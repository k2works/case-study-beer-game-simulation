-- Up Migration
-- U1（薄い一通り）の保存先。entities.md が正本。後続の Unit は、自分が足す表を別の移行として足す。
-- 金額は整数の最小単位（セント）。浮動小数点型は使わない。

create table games (
  game_id uuid primary key,
  name text not null check (char_length(name) between 1 and 60),
  status text not null default 'preparing' check (status in ('preparing', 'running', 'ended')),
  week_count integer not null check (week_count between 1 and 50),
  current_week integer not null default 1 check (current_week >= 1),
  setup_kind text not null default 'custom' check (setup_kind in ('kit', 'custom')),
  version integer not null default 0 check (version >= 0),
  created_at timestamptz not null,
  ended_at timestamptz,
  check (status <> 'ended' or ended_at is not null),
  check (current_week <= week_count)
);

create table game_settings (
  settings_id uuid primary key,
  game_id uuid not null unique references games (game_id) on delete cascade,
  week_count integer not null check (week_count between 1 and 50),
  initial_inventory integer not null default 12 check (initial_inventory >= 0),
  initial_pipeline_quantity integer not null default 4 check (initial_pipeline_quantity >= 0),
  inventory_unit_cost integer not null default 50 check (inventory_unit_cost >= 0),
  backlog_unit_cost integer not null default 100 check (backlog_unit_cost >= 0),
  visibility_scope text not null default 'team_totals' check (visibility_scope in ('team_totals'))
);

create table demand_series (
  series_id uuid primary key,
  settings_id uuid not null unique references game_settings (settings_id) on delete cascade,
  series_values integer[] not null,
  is_provisional_default boolean not null default false
);

create table participants (
  participant_id uuid primary key,
  game_id uuid not null references games (game_id) on delete cascade,
  display_name text not null check (char_length(display_name) between 1 and 40),
  join_order integer not null check (join_order >= 1),
  joined_at timestamptz not null,
  unique (game_id, join_order)
);

create table role_assignments (
  assignment_id uuid primary key,
  game_id uuid not null references games (game_id) on delete cascade,
  participant_id uuid not null unique references participants (participant_id) on delete cascade,
  role text not null check (role in ('factory', 'wholesaler1', 'wholesaler2', 'retailer'))
);

create table week_records (
  week_record_id uuid primary key,
  game_id uuid not null references games (game_id) on delete cascade,
  week integer not null check (week between 1 and 50),
  role text not null check (role in ('factory', 'wholesaler1', 'wholesaler2', 'retailer')),
  decision integer check (decision between 0 and 9999),
  receipt integer check (receipt >= 0),
  orders_received integer check (orders_received >= 0),
  shipped integer check (shipped >= 0),
  inventory integer check (inventory >= 0),
  backlog integer check (backlog >= 0),
  weekly_cost integer check (weekly_cost >= 0),
  cumulative_cost integer check (cumulative_cost >= 0),
  is_confirmed boolean not null default false,
  unique (game_id, week, role),
  check (
    is_confirmed
    or (receipt is null and orders_received is null and shipped is null and inventory is null
        and backlog is null and weekly_cost is null and cumulative_cost is null)
  ),
  check (
    not is_confirmed
    or (decision is not null and receipt is not null and orders_received is not null
        and shipped is not null and inventory is not null and backlog is not null
        and weekly_cost is not null and cumulative_cost is not null)
  )
);

create table pipeline_slots (
  pipeline_slot_id uuid primary key,
  game_id uuid not null references games (game_id) on delete cascade,
  kind text not null check (kind in ('delivery', 'order', 'production')),
  role text not null check (role in ('factory', 'wholesaler1', 'wholesaler2', 'retailer')),
  remaining_weeks integer not null check (remaining_weeks between 1 and 2),
  quantity integer not null check (quantity >= 0),
  unique (game_id, kind, role, remaining_weeks),
  check (kind <> 'production' or role = 'factory'),
  check (kind <> 'delivery' or role in ('wholesaler1', 'wholesaler2', 'retailer')),
  check (kind <> 'order' or role in ('factory', 'wholesaler1', 'wholesaler2'))
);

-- code_hash の形: 参加コードと観察者用コードは `<鍵の識別子>:<hex>`（HMAC-SHA-256）、進行役用コードは `sha256:<hex>`。
-- code_sealed の形: `v1.<鍵の識別子>.<iv>.<tag>.<暗号文>`（AES-256-GCM）。進行役用コードは null（再表示も再発行もしない）。
create table access_codes (
  code_id uuid primary key,
  game_id uuid not null references games (game_id) on delete cascade,
  kind text not null check (kind in ('join', 'facilitator', 'observer')),
  code_hash text not null unique,
  code_sealed text,
  issued_at timestamptz not null,
  revoked_at timestamptz,
  unique (game_id, kind),
  check (kind = 'facilitator' or code_sealed is not null),
  check (kind <> 'facilitator' or code_sealed is null)
);

-- U4 が有効期間と最後の操作の時刻の列を足す。
create table return_tokens (
  token_id uuid primary key,
  participant_id uuid not null references participants (participant_id) on delete cascade,
  token_hash text not null unique,
  issued_at timestamptz not null,
  revoked_at timestamptz
);

create index return_tokens_participant_idx on return_tokens (participant_id);

create table idempotency_records (
  record_id uuid primary key,
  game_id uuid not null references games (game_id) on delete cascade,
  key text not null check (char_length(key) between 16 and 128),
  operation text not null check (operation in ('submitDecision', 'confirmWeek')),
  requester_id text not null,
  request_digest text not null,
  response_body jsonb not null,
  created_at timestamptz not null,
  unique (game_id, operation, requester_id, key)
);

-- Down Migration

drop table if exists idempotency_records;
drop table if exists return_tokens;
drop table if exists access_codes;
drop table if exists pipeline_slots;
drop table if exists week_records;
drop table if exists role_assignments;
drop table if exists participants;
drop table if exists demand_series;
drop table if exists game_settings;
drop table if exists games;
