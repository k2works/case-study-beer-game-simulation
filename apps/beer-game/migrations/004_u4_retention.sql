BEGIN;

CREATE TABLE retention_policies (
  game_id uuid PRIMARY KEY,
  retention_days integer NOT NULL CHECK (retention_days BETWEEN 1 AND 3650),
  retention_starts_at timestamptz NOT NULL,
  delete_after timestamptz NOT NULL,
  policy_version integer NOT NULL CHECK (policy_version > 0),
  CHECK (delete_after > retention_starts_at)
);
CREATE INDEX retention_policies_due_idx ON retention_policies (delete_after, game_id);

CREATE TABLE deletion_sagas (
  deletion_id uuid PRIMARY KEY,
  game_id uuid NOT NULL UNIQUE,
  status text NOT NULL CHECK (status IN ('PENDING', 'IN_PROGRESS', 'FAILED', 'COMPLETED')),
  attempt integer NOT NULL CHECK (attempt > 0),
  automatic_retries integer NOT NULL DEFAULT 0 CHECK (automatic_retries BETWEEN 0 AND 5),
  requested_at timestamptz NOT NULL,
  next_attempt_at timestamptz,
  last_failure_code text,
  completed_at timestamptz
);
CREATE INDEX deletion_sagas_retry_idx ON deletion_sagas (next_attempt_at)
  WHERE status = 'IN_PROGRESS' AND next_attempt_at IS NOT NULL;

CREATE TABLE owner_deletion_progress (
  deletion_id uuid NOT NULL REFERENCES deletion_sagas (deletion_id),
  owner_unit text NOT NULL CHECK (owner_unit IN ('u1-walking-skeleton', 'u2-session-continuity', 'u3-learning-view')),
  status text NOT NULL CHECK (status IN ('PENDING', 'COMPLETED', 'RETRYABLE_FAILURE', 'PERMANENT_FAILURE')),
  completed_at timestamptz,
  failure_code text,
  PRIMARY KEY (deletion_id, owner_unit)
);

CREATE TABLE deletion_attempts (
  deletion_id uuid NOT NULL REFERENCES deletion_sagas (deletion_id),
  attempt integer NOT NULL CHECK (attempt > 0),
  started_at timestamptz NOT NULL,
  next_attempt_at timestamptz,
  failure_code text,
  PRIMARY KEY (deletion_id, attempt)
);

CREATE TABLE deletion_outbox (
  event_id uuid PRIMARY KEY,
  deletion_id uuid NOT NULL REFERENCES deletion_sagas (deletion_id),
  owner_unit text NOT NULL,
  attempt integer NOT NULL CHECK (attempt > 0),
  channel text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  UNIQUE (deletion_id, owner_unit, attempt)
);
CREATE INDEX deletion_outbox_pending_idx ON deletion_outbox (created_at)
  WHERE published_at IS NULL;

CREATE TABLE deletion_inbox (
  event_id uuid PRIMARY KEY,
  deletion_id uuid NOT NULL,
  owner_unit text NOT NULL,
  attempt integer NOT NULL,
  payload_digest text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE deletion_receipts (
  deletion_id uuid PRIMARY KEY,
  game_reference_digest text NOT NULL CHECK (length(game_reference_digest) = 64),
  outcome text NOT NULL CHECK (outcome IN ('COMPLETED', 'FAILED')),
  recorded_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  correlation_id uuid NOT NULL,
  CHECK (expires_at > recorded_at)
);
CREATE INDEX deletion_receipts_expiry_idx ON deletion_receipts (expires_at);

CREATE TABLE retention_restore_gate (
  gate_id boolean PRIMARY KEY DEFAULT true CHECK (gate_id),
  reads_open boolean NOT NULL DEFAULT false,
  sweep_completed_at timestamptz
);
INSERT INTO retention_restore_gate (gate_id, reads_open, sweep_completed_at)
VALUES (true, true, now());

COMMIT;
