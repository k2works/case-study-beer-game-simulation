ALTER TABLE game_sessions
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'ACTIVE',
  ADD COLUMN IF NOT EXISTS aggregate_version bigint NOT NULL DEFAULT 1;

CREATE TABLE IF NOT EXISTS recovery_credentials (
  recovery_credential_id uuid PRIMARY KEY,
  participant_id uuid NOT NULL,
  credential_digest text NOT NULL UNIQUE,
  key_version integer NOT NULL DEFAULT 1,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);

CREATE INDEX IF NOT EXISTS recovery_credentials_participant_idx
  ON recovery_credentials (participant_id, expires_at);

CREATE TABLE IF NOT EXISTS operation_audit (
  audit_id uuid PRIMARY KEY,
  session_id uuid NOT NULL,
  actor_id uuid NOT NULL,
  action_kind text NOT NULL,
  target_role text,
  outcome text NOT NULL,
  correlation_id uuid NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now()
);
