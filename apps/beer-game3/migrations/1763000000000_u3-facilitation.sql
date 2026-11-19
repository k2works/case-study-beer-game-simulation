-- Up Migration
-- U3（運営操作）: 操作の履歴、一時停止、終了の理由、入力した主体、入れ替えの印を足す。
-- すべて追加で、既存の列は削除も意味の変更もしない。entities.md（U3）が正本。

-- 操作の履歴（BR13.1〜BR13.6）。追記だけで、アプリケーションは INSERT と SELECT しか書かない（NFR9.2）。
-- ゲームの削除（U5）と同時に消える。detail は kind ごとの型で検証してから保存し、資格情報の平文を持たない。
create table operation_log_entries (
  entry_id uuid primary key,
  game_id uuid not null references games (game_id) on delete cascade,
  sequence integer not null check (sequence >= 1),
  kind text not null check (kind in ('setting', 'roleChange', 'proxyInput', 'weekConfirm', 'pause', 'resume', 'end')),
  actor_kind text not null check (actor_kind in ('facilitator', 'system')),
  occurred_at timestamptz not null,
  week integer check (week between 1 and 50),
  role text check (role in ('factory', 'wholesaler1', 'wholesaler2', 'retailer')),
  detail jsonb not null,
  unique (game_id, sequence)
);

-- ゲーム: 一時停止の状態、終了の理由、履歴の採番。
alter table games drop constraint games_status_check;
alter table games add constraint games_status_check
  check (status in ('preparing', 'running', 'paused', 'ended'));
alter table games add column end_reason text
  check (end_reason in ('facilitator', 'finalWeek', 'autoEnd'));
-- U3 の前に ended になる経路は最終週の確定だけ（U1 には途中終了がない）
update games set end_reason = 'finalWeek' where status = 'ended' and end_reason is null;
alter table games add constraint games_end_reason_state_check
  check ((status = 'ended') = (end_reason is not null));
alter table games add column next_log_sequence integer not null default 1
  check (next_log_sequence >= 1);

-- 週の記録: 入力した主体と、置き換わりの検出に使う版（BR11.2、BR12.2）。
alter table week_records add column decided_by_kind text
  check (decided_by_kind in ('participant', 'facilitator'));
alter table week_records add column decided_by_participant_id uuid references participants (participant_id);
alter table week_records add column decided_at timestamptz;
alter table week_records add column decision_revision integer not null default 0
  check (decision_revision >= 0);
-- U3 の前に入力済みの値は、最初の版（1）とみなす。入力した主体は分からないので null のまま
update week_records set decision_revision = 1 where decision is not null;
alter table week_records add constraint week_records_decision_trace_check
  check (
    (decision is not null or decision_revision = 0)
    and (decision is not null or (decided_by_kind is null and decided_by_participant_id is null and decided_at is null))
  );

-- 参加者: 入れ替えで交代した印と、進行役が作った印（BR10.2）。
alter table participants add column replaced_at timestamptz;
alter table participants add column created_by_facilitator boolean not null default false;

-- Down Migration
-- 一時停止中のゲームは進行中に戻す（paused の値を持つ行を残すと、元の制約を付けられない）。
-- 履歴の表と、追加した列の値は失われる。

update games set status = 'running' where status = 'paused';

alter table participants drop column created_by_facilitator;
alter table participants drop column replaced_at;

alter table week_records drop constraint week_records_decision_trace_check;
alter table week_records drop column decision_revision;
alter table week_records drop column decided_at;
alter table week_records drop column decided_by_participant_id;
alter table week_records drop column decided_by_kind;

alter table games drop column next_log_sequence;
alter table games drop constraint games_end_reason_state_check;
alter table games drop column end_reason;
alter table games drop constraint games_status_check;
alter table games add constraint games_status_check
  check (status in ('preparing', 'running', 'ended'));

drop table operation_log_entries;
