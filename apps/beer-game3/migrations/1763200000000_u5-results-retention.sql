-- Up Migration
-- U5（結果と出力、保持と削除）: 放置の判定に使う「最後の操作の時刻」と、定期処理の対象を選ぶ部分索引を足す。
-- 追加だけで、既存の列は削除も意味の変更もしない。entities.md（U5）と scalability-design.md が正本。

-- default now() は付けたままにする。ローリングデプロイの間に旧版のアプリケーションが games へ挿入しても
-- not null で失敗せず、作成時の時刻が入る（新版は作成時に created_at と同じ値を明示して入れる）。
alter table games add column last_operation_at timestamptz not null default now();

-- 既存の行は、実際の最後の操作より古くならないように、最も遅い時刻で埋める。
-- 参加・開始・参加者の入力は履歴に残らないため、履歴だけでは古く見積もり、移行の直後に早すぎる自動終了が起きる。
update games g set last_operation_at = greatest(
  g.created_at,
  coalesce(g.ended_at, g.created_at),
  coalesce((select max(occurred_at) from operation_log_entries where game_id = g.game_id), g.created_at),
  coalesce((select max(joined_at) from participants where game_id = g.game_id), g.created_at),
  coalesce((select max(decided_at) from week_records where game_id = g.game_id), g.created_at)
);

-- 未終了の中から放置されたものを、終了済みの中から期限を過ぎたものを、それぞれ自分の集合だけを走査して選ぶ。
create index games_stale_idx on games (last_operation_at) where status <> 'ended';
create index games_expired_idx on games (ended_at) where status = 'ended';

-- Down Migration
-- 追加した索引と列を落とす。最後の操作の時刻は失われる。

drop index games_expired_idx;
drop index games_stale_idx;
alter table games drop column last_operation_at;
