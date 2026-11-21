-- 0006: DB ロールと GRANT。events の追記専用と、観察者の最小権限（NF-S18、BR-17）。
-- 表の所有者は、このマイグレーションを実行する接続のユーザー（所有者。migrate だけが使う）。
-- 下の 4 つのロールは、どの表も所有せず、所有者のロールのメンバーにもならない（権限の継承で広がらない）。
-- ロールは NOLOGIN で作る。ログインできる用途別のユーザー（パスワードは Secrets Manager）は、接続プールの分離（B10）で足す。
-- **LOGIN ユーザーに付ける `idle_in_transaction_session_timeout` などの設定は、ロールではなくログインユーザーに付ける**
-- （NOLOGIN ロールの設定は、ログインしたセッションに継承されない。実測済み）。
-- 守りは GRANT だけで行い、events に更新・削除を拒否するトリガーは足さない（連鎖削除も止めるため。ADR-010）。
-- 連鎖削除の子の行の削除は、参照の整合性のトリガーが「子の表の所有者」の権限で実行するため、削除ロールに events の DELETE が無くても動く。
-- 表を足したら、その表の GRANT は、その表のマイグレーションより大きい番号の SQL に書く（既定の権限は与えない）。
-- Rust 版では、`participation_attempts`・保持の表（`deletion_*`）は B2 では作っていない。後の Bolt で、その表の後ろの番号に GRANT を書く。

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
