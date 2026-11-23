-- Up Migration
-- 共有の API の契約（RoleStatus.decisionSavedAt）が、入力の保存の時刻を返す。
-- docs/development/beer-game-ts/api_alignment_plan.md（ゲート 1。2026-11-24 に承認）。
-- 既存の行は、適用の時刻になる（過去の入力の正確な時刻は残っていない）。以後は、保存のたびに永続化が now() を付ける
ALTER TABLE role_decisions
  ADD COLUMN saved_at timestamptz NOT NULL DEFAULT now();

-- Down Migration
ALTER TABLE role_decisions DROP COLUMN saved_at;
