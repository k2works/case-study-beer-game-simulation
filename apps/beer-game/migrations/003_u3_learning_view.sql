CREATE TABLE observation_projections (
  game_id uuid PRIMARY KEY, session_id uuid NOT NULL, source_version bigint NOT NULL,
  projection jsonb NOT NULL, stale boolean NOT NULL DEFAULT false, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX observation_projections_game_version_idx ON observation_projections (game_id, source_version);
CREATE TABLE learning_processed_events (event_id uuid PRIMARY KEY, game_id uuid NOT NULL, aggregate_version bigint NOT NULL);
CREATE TABLE learning_consumer_cursors (game_id uuid PRIMARY KEY, aggregate_version bigint NOT NULL);
CREATE TABLE review_projections (
  game_id uuid PRIMARY KEY, source_version bigint NOT NULL, status text NOT NULL,
  projection jsonb NOT NULL, CHECK (status IN ('BUILDING', 'READY', 'FAILED'))
);
CREATE TABLE export_packages (
  export_id uuid PRIMARY KEY, game_id uuid NOT NULL, source_version bigint NOT NULL,
  schema_version text NOT NULL, status text NOT NULL, artifact_refs jsonb,
  CHECK (status IN ('PENDING', 'GENERATING', 'COMPLETE', 'FAILED'))
);
