-- Up Migration
-- Bolt 1 のスキーマ。全表が games への ON DELETE CASCADE を持つ（削除の網羅。docs/design/beer-game2/data-model.md）

CREATE TABLE games (
  game_id             uuid PRIMARY KEY,
  join_code           text NOT NULL UNIQUE,
  status              text NOT NULL CHECK (status IN ('PREPARING', 'STARTED', 'ENDED')),
  version             integer NOT NULL CHECK (version >= 0),
  settings_kind       text NOT NULL DEFAULT 'KIT' CHECK (settings_kind IN ('KIT', 'CUSTOM')),
  final_week          integer NOT NULL CHECK (final_week BETWEEN 1 AND 50),
  demand              jsonb NOT NULL,
  holding_cost_minor  integer NOT NULL CHECK (holding_cost_minor >= 0),
  backlog_cost_minor  integer NOT NULL CHECK (backlog_cost_minor >= 0),
  quantity_max        integer NOT NULL CHECK (quantity_max >= 0),
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE participants (
  participant_id  uuid PRIMARY KEY,
  seq             bigint GENERATED ALWAYS AS IDENTITY,
  game_id         uuid NOT NULL REFERENCES games (game_id) ON DELETE CASCADE,
  display_name    text NOT NULL,
  role            text CHECK (role IN ('FACTORY', 'DISTRIBUTOR', 'WHOLESALER', 'RETAILER')),
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX participants_game_idx ON participants (game_id);

CREATE TABLE browser_sessions (
  credential_digest  text PRIMARY KEY,
  game_id            uuid NOT NULL REFERENCES games (game_id) ON DELETE CASCADE,
  actor_kind         text NOT NULL CHECK (actor_kind IN ('FACILITATOR', 'PARTICIPANT')),
  participant_id     uuid REFERENCES participants (participant_id) ON DELETE CASCADE,
  created_at         timestamptz NOT NULL DEFAULT now(),
  expires_at         timestamptz NOT NULL DEFAULT now() + interval '24 hours'
);
CREATE INDEX browser_sessions_expiry_idx ON browser_sessions (game_id, expires_at);

CREATE TABLE sessions (
  session_id   uuid PRIMARY KEY,
  game_id      uuid NOT NULL UNIQUE REFERENCES games (game_id) ON DELETE CASCADE,
  status       text NOT NULL CHECK (status IN ('ACTIVE', 'ENDED')),
  week         integer NOT NULL CHECK (week > 0),
  version      integer NOT NULL CHECK (version >= 0),
  settings     jsonb NOT NULL,
  holders      jsonb NOT NULL,
  role_states  jsonb NOT NULL
);

CREATE TABLE role_decisions (
  session_id  uuid NOT NULL REFERENCES sessions (session_id) ON DELETE CASCADE,
  week        integer NOT NULL CHECK (week > 0),
  role        text NOT NULL CHECK (role IN ('FACTORY', 'DISTRIBUTOR', 'WHOLESALER', 'RETAILER')),
  quantity    integer NOT NULL CHECK (quantity >= 0),
  version     integer NOT NULL CHECK (version > 0),
  saved_by    uuid NOT NULL,
  PRIMARY KEY (session_id, week, role)
);

-- 確定した週。主キーで、同じ週の二重の確定を防ぐ
CREATE TABLE week_results (
  session_id    uuid NOT NULL REFERENCES sessions (session_id) ON DELETE CASCADE,
  week          integer NOT NULL CHECK (week > 0),
  commit_kind   text NOT NULL DEFAULT 'MANUAL' CHECK (commit_kind IN ('MANUAL', 'AUTO')),
  committed_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, week)
);

-- 役割別の週結果（振り返り・出力・観察の源泉）
CREATE TABLE week_role_results (
  session_id             uuid NOT NULL,
  week                   integer NOT NULL,
  role                   text NOT NULL CHECK (role IN ('FACTORY', 'DISTRIBUTOR', 'WHOLESALER', 'RETAILER')),
  demand                 integer NOT NULL CHECK (demand >= 0),
  received               integer NOT NULL CHECK (received >= 0),
  shipped                integer NOT NULL CHECK (shipped >= 0),
  ordered                integer NOT NULL CHECK (ordered >= 0),
  ending_inventory       integer NOT NULL CHECK (ending_inventory >= 0),
  ending_backlog         integer NOT NULL CHECK (ending_backlog >= 0),
  weekly_cost_minor      integer NOT NULL CHECK (weekly_cost_minor >= 0),
  cumulative_cost_minor  integer NOT NULL CHECK (cumulative_cost_minor >= 0),
  PRIMARY KEY (session_id, week, role),
  FOREIGN KEY (session_id, week) REFERENCES week_results (session_id, week) ON DELETE CASCADE
);

CREATE TABLE events (
  event_id     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seq          bigint GENERATED ALWAYS AS IDENTITY,
  game_id      uuid NOT NULL REFERENCES games (game_id) ON DELETE CASCADE,
  event_type   text NOT NULL,
  payload      jsonb NOT NULL,
  occurred_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX events_game_idx ON events (game_id, seq);

CREATE TABLE idempotency_records (
  game_id      uuid NOT NULL REFERENCES games (game_id) ON DELETE CASCADE,
  scope        text NOT NULL,
  key_digest   text NOT NULL,
  fingerprint  text NOT NULL,
  response     bytea NOT NULL,
  expires_at   timestamptz NOT NULL DEFAULT now() + interval '24 hours',
  PRIMARY KEY (game_id, scope, key_digest)
);
CREATE INDEX idempotency_expiry_idx ON idempotency_records (expires_at);

-- Down Migration
DROP TABLE idempotency_records;
DROP TABLE events;
DROP TABLE week_role_results;
DROP TABLE week_results;
DROP TABLE role_decisions;
DROP TABLE sessions;
DROP TABLE browser_sessions;
DROP TABLE participants;
DROP TABLE games;
