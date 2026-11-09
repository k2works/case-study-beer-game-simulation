-- Expand the U1 schema for stateless API processes. Existing rows remain readable.
ALTER TABLE games ADD COLUMN IF NOT EXISTS retention_days integer NOT NULL DEFAULT 90;
ALTER TABLE participants
  ADD COLUMN IF NOT EXISTS credential_expires_at timestamptz NOT NULL DEFAULT (now() + interval '30 days'),
  ADD COLUMN IF NOT EXISTS credential_revoked boolean NOT NULL DEFAULT false;
ALTER TABLE decisions ALTER COLUMN participant_id DROP NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS participants_credential_digest_idx ON participants (credential_digest);
ALTER TABLE sessions DROP CONSTRAINT IF EXISTS sessions_status_check;
ALTER TABLE sessions ADD CONSTRAINT sessions_status_check CHECK (status IN ('LOBBY','ACTIVE','PAUSED','ENDED'));

CREATE TABLE IF NOT EXISTS browser_sessions (
  credential_digest text PRIMARY KEY,
  game_id uuid NOT NULL REFERENCES games(game_id) ON DELETE CASCADE,
  actor_id uuid NOT NULL,
  actor_kind text NOT NULL CHECK (actor_kind IN ('FACILITATOR','PARTICIPANT')),
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS browser_sessions_game_idx ON browser_sessions (game_id, expires_at);

-- The U1 idempotency table stores digests and returned responses. Raw
-- credentials must never be placed in its JSON response column.
CREATE INDEX IF NOT EXISTS outbox_game_replay_idx
  ON outbox_events (aggregate_id, aggregate_version);
ALTER TABLE outbox_events ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz;
CREATE INDEX IF NOT EXISTS outbox_retry_idx
  ON outbox_events (next_attempt_at, occurred_at) WHERE published_at IS NULL;

CREATE TABLE IF NOT EXISTS retention_retry_idempotency (
  game_id uuid NOT NULL,
  key_digest text NOT NULL,
  expected_attempt integer NOT NULL,
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (game_id, key_digest)
);
