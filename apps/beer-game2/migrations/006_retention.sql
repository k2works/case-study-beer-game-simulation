-- Up Migration
-- Bolt 10: 保持と削除（docs/development/beer-game2/bolt_10_plan.md）。
-- 保持日数・削除期限・試行回数は games の列で持つ（削除に成功すれば行ごと消え、ゲームの ID を残さない）
ALTER TABLE games
  ADD COLUMN retention_days      integer NOT NULL DEFAULT 90 CHECK (retention_days BETWEEN 1 AND 3650),
  ADD COLUMN delete_after        timestamptz NOT NULL DEFAULT now() + interval '90 days',
  ADD COLUMN deletion_attempts   integer NOT NULL DEFAULT 0 CHECK (deletion_attempts >= 0),
  ADD COLUMN deletion_failed_at  timestamptz;
-- 既存の行は、作成時から 90 日
UPDATE games SET delete_after = created_at + interval '90 days';
CREATE INDEX games_delete_after_idx ON games (delete_after);

-- 削除の受領記録。games への外部キーを持たず、ゲームを特定できない参照（鍵つきのダイジェスト）だけを持つ
CREATE TABLE deletion_receipts (
  reference    text PRIMARY KEY,
  outcome      text NOT NULL CHECK (outcome IN ('DELETED')),
  recorded_at  timestamptz NOT NULL,
  expires_at   timestamptz NOT NULL
);
CREATE INDEX deletion_receipts_expiry_idx ON deletion_receipts (expires_at);

-- Down Migration
DROP TABLE deletion_receipts;
DROP INDEX games_delete_after_idx;
ALTER TABLE games
  DROP COLUMN deletion_failed_at,
  DROP COLUMN deletion_attempts,
  DROP COLUMN delete_after,
  DROP COLUMN retention_days;
