-- Up Migration
-- 週の確定方式。MANUAL（進行役が確定）または AUTO（全役割の保存で自動確定）
ALTER TABLE games
  ADD COLUMN commit_mode text NOT NULL DEFAULT 'MANUAL'
  CHECK (commit_mode IN ('MANUAL', 'AUTO'));

-- Down Migration
ALTER TABLE games DROP COLUMN commit_mode;
