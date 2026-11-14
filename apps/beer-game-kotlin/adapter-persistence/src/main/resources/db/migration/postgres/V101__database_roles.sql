-- 101: DB ロールと GRANT（PostgreSQL 専用。H2 には適用しない）。events の追記専用と、観察者の最小権限（NF-S18、BR-17）。
--
-- 表の所有者は、このマイグレーションを実行する接続のユーザー（所有者。migrate タスクだけが使う）。
-- 下の 4 つのロールは、どの表も所有せず、所有者のロールのメンバーにもならない（権限の継承で広がらない）。
-- ロールは NOLOGIN で作る。ログインできる用途別のユーザーとパスワード（Secrets Manager）と接続プールの分離は B3 以降。
-- 守りは GRANT だけで行い、events に更新・削除を拒否するトリガーは足さない（連鎖削除も止めるため。ADR-010）。
--
-- 連鎖削除（ON DELETE CASCADE）の子の行の削除は、PostgreSQL が参照の整合性のトリガーを「子の表の所有者」の権限で
-- 実行するため、削除ロールに events の DELETE 権限が無くても動く（Step 3 の実測。RolePrivilegesSpec）。
--
-- 以降の表の追加（V006 の deletion_* など）は、その表の GRANT をそのマイグレーションで書く（既定の権限は与えない）。

DO $$
DECLARE
    app_role text;
BEGIN
    FOREACH app_role IN ARRAY ARRAY['beergame_writer', 'beergame_reader', 'beergame_observer', 'beergame_deleter']
    LOOP
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = app_role) THEN
            EXECUTE format(
                'CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT',
                app_role);
        END IF;
    END LOOP;
END
$$;

GRANT USAGE ON SCHEMA public TO beergame_writer, beergame_reader, beergame_observer, beergame_deleter;

-- 書き込み（api のコマンド、rebuild-projections）。events と game_roots は追記専用（INSERT / SELECT）。
-- 投影・周辺ストア・冪等記録は読み書き（投影の再構築が行を削除して作り直すため DELETE も与える）。
GRANT SELECT, INSERT ON game_roots, events TO beergame_writer;
GRANT SELECT, INSERT, UPDATE, DELETE ON
    projection_checkpoints,
    display_profiles, credentials, browser_sessions, idempotency_records,
    game_overview, game_join_codes, game_settings,
    lobby_participants, lobby_observer_invitations, lobby_observers,
    session_overview, role_current_states, current_decisions,
    week_commits, week_role_results, week_team_totals
    TO beergame_writer;

-- 読み取り（api の問い合わせ）。投影の SELECT だけ。display_profiles はロビーの表示名の結合に使う。
GRANT SELECT ON
    projection_checkpoints, display_profiles,
    game_overview, game_join_codes, game_settings,
    lobby_participants, lobby_observer_invitations, lobby_observers,
    session_overview, role_current_states, current_decisions,
    week_commits, week_role_results, week_team_totals
    TO beergame_reader;

-- 観察者の読み取り。3 表だけ。参加コード（game_join_codes）と役割別の表には到達できない。
GRANT SELECT ON game_overview, session_overview, week_team_totals TO beergame_observer;

-- 削除（retention）。game_roots の DELETE だけ（WHERE 句の列の参照に SELECT が要る）。
-- 子の行は ON DELETE CASCADE で消える。
GRANT SELECT, DELETE ON game_roots TO beergame_deleter;
