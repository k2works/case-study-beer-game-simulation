-- Up Migration
-- 共有の API の契約（assignRole の開始後の入れ替え。H4）が、入れ替えで外された旧担当者を `replaced` として示す。
-- docs/development/beer-game-ts/api_alignment_plan.md（段階 3 の前の確認事項。2026-11-24 に承認）。
-- 旧担当者の行と週の入力の履歴は、入力者のラベルのために消さない。入れ替えの時刻だけを持つ（NULL は入れ替えられていない）
ALTER TABLE participants
  ADD COLUMN replaced_at timestamptz;

-- Down Migration
ALTER TABLE participants DROP COLUMN replaced_at;
