-- Up Migration
-- Bolt 4: 停止・代理入力、資格の有効期限と失効、復帰コード、参加・復帰のレート制限
-- （docs/development/beer-game2/bolt_4_plan.md）

-- 一時停止
ALTER TABLE sessions DROP CONSTRAINT sessions_status_check;
ALTER TABLE sessions
  ADD CONSTRAINT sessions_status_check CHECK (status IN ('ACTIVE', 'PAUSED', 'ENDED'));

-- 代理入力の保存者は、参加者 ID ではなく 'FACILITATOR'
ALTER TABLE role_decisions ALTER COLUMN saved_by TYPE text;

-- ブラウザセッションの失効。期限はアプリの時計で決める（既定値を外す）
ALTER TABLE browser_sessions ALTER COLUMN expires_at DROP DEFAULT;
ALTER TABLE browser_sessions ADD COLUMN revoked_at timestamptz;

-- 復帰コード（主体ごとに 1 つ。ダイジェストだけを保存する）
ALTER TABLE participants
  ADD COLUMN recovery_digest      text UNIQUE,
  ADD COLUMN recovery_expires_at  timestamptz,
  ADD COLUMN recovery_revoked_at  timestamptz;
ALTER TABLE games
  ADD COLUMN facilitator_digest      text UNIQUE,
  ADD COLUMN facilitator_expires_at  timestamptz,
  ADD COLUMN facilitator_revoked_at  timestamptz;

-- 参加・復帰のレート制限（固定窓）。タスクの間で共有し、実効の上限がタスク数で増えないようにする。
-- ゲームのデータではない（game_id を持たない）。古い窓は書き込み時に消す
CREATE TABLE rate_limits (
  bucket        text NOT NULL,
  window_start  timestamptz NOT NULL,
  hits          integer NOT NULL CHECK (hits > 0),
  PRIMARY KEY (bucket, window_start)
);
CREATE INDEX rate_limits_window_idx ON rate_limits (window_start);

-- Down Migration
DROP TABLE rate_limits;
ALTER TABLE games
  DROP COLUMN facilitator_revoked_at,
  DROP COLUMN facilitator_expires_at,
  DROP COLUMN facilitator_digest;
ALTER TABLE participants
  DROP COLUMN recovery_revoked_at,
  DROP COLUMN recovery_expires_at,
  DROP COLUMN recovery_digest;
ALTER TABLE browser_sessions DROP COLUMN revoked_at;
ALTER TABLE browser_sessions ALTER COLUMN expires_at SET DEFAULT now() + interval '24 hours';
ALTER TABLE role_decisions ALTER COLUMN saved_by TYPE uuid USING saved_by::uuid;
ALTER TABLE sessions DROP CONSTRAINT sessions_status_check;
ALTER TABLE sessions
  ADD CONSTRAINT sessions_status_check CHECK (status IN ('ACTIVE', 'ENDED'));
