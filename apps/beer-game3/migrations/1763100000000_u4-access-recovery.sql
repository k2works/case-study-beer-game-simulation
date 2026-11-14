-- Up Migration
-- U4（復帰と権限）: 復帰用 token の最後の操作の時刻と、参加の無効な試行の窓を足す。
-- どちらも追加だけで、既存の列は削除も意味の変更もしない。entities.md（U4）が正本。

-- 復帰用 token: 最後の操作の時刻（BR17.1、BR17.2）。既存の行は issued_at で埋める。
alter table return_tokens add column last_used_at timestamptz;
update return_tokens set last_used_at = issued_at;
alter table return_tokens alter column last_used_at set not null;

-- 参加の無効な試行の窓（BR18）。source_key は接続元の鍵付きの要約で、生のアドレスを持たない（NFR7.1）。
-- ゲームの削除とは無関係なので、games への外部キーを持たない。古い行は掃除（起動時と定期）で消す。
create table join_attempts (
  id bigserial primary key,
  source_key text not null,
  attempted_at timestamptz not null
);

create index join_attempts_source_idx on join_attempts (source_key, attempted_at);
create index join_attempts_attempted_idx on join_attempts (attempted_at);

-- Down Migration
-- 追加した表と列を落とす。最後の操作の時刻と、窓の試行の記録は失われる。

drop table join_attempts;
alter table return_tokens drop column last_used_at;
