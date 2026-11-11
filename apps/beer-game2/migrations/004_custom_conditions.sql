-- Up Migration
-- Bolt 6: カスタム条件（初期在庫・遅延・公開範囲）と、キット準拠からの変更項目
-- （docs/development/beer-game2/bolt_6_plan.md）。既存の行はキットの値になる
ALTER TABLE games
  ADD COLUMN initial_inventory       integer NOT NULL DEFAULT 12 CHECK (initial_inventory >= 0),
  ADD COLUMN order_delay_weeks       integer NOT NULL DEFAULT 2 CHECK (order_delay_weeks >= 1),
  ADD COLUMN shipment_delay_weeks    integer NOT NULL DEFAULT 2 CHECK (shipment_delay_weeks >= 1),
  ADD COLUMN production_delay_weeks  integer NOT NULL DEFAULT 2 CHECK (production_delay_weeks >= 1),
  ADD COLUMN disclosure_policy       text NOT NULL DEFAULT 'TEAM_TOTAL'
    CHECK (disclosure_policy IN ('TEAM_TOTAL', 'PROGRESS_ONLY')),
  ADD COLUMN settings_changes        jsonb NOT NULL DEFAULT '[]';

-- Down Migration
ALTER TABLE games
  DROP COLUMN settings_changes,
  DROP COLUMN disclosure_policy,
  DROP COLUMN production_delay_weeks,
  DROP COLUMN shipment_delay_weeks,
  DROP COLUMN order_delay_weeks,
  DROP COLUMN initial_inventory;
