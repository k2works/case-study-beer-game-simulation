-- Up Migration
-- 共有の API の契約（CustomConditions）に合わせる。初期在庫を役割ごとにし、初期の流れ（遅延の各段の数量。キットは 4）を足す。
-- docs/development/beer-game-ts/api_alignment_plan.md（案 1。2026-11-24 に承認）。
-- games は、条件を平らな列で持つ現在の流儀のまま、役割ごとの 4 列にする。sessions.settings（開始時点の条件の写し）も同じ形に変換する
ALTER TABLE games
  ADD COLUMN initial_inventory_factory     integer CHECK (initial_inventory_factory     >= 0),
  ADD COLUMN initial_inventory_distributor integer CHECK (initial_inventory_distributor >= 0),
  ADD COLUMN initial_inventory_wholesaler  integer CHECK (initial_inventory_wholesaler  >= 0),
  ADD COLUMN initial_inventory_retailer    integer CHECK (initial_inventory_retailer    >= 0),
  ADD COLUMN initial_flow integer NOT NULL DEFAULT 4 CHECK (initial_flow BETWEEN 0 AND 1000);

UPDATE games SET
  initial_inventory_factory     = initial_inventory,
  initial_inventory_distributor = initial_inventory,
  initial_inventory_wholesaler  = initial_inventory,
  initial_inventory_retailer    = initial_inventory;

ALTER TABLE games
  ALTER COLUMN initial_inventory_factory     SET NOT NULL,
  ALTER COLUMN initial_inventory_distributor SET NOT NULL,
  ALTER COLUMN initial_inventory_wholesaler  SET NOT NULL,
  ALTER COLUMN initial_inventory_retailer    SET NOT NULL,
  DROP COLUMN initial_inventory;

UPDATE sessions SET settings = settings || jsonb_build_object(
  'initialInventory', jsonb_build_object(
    'FACTORY',     settings->'initialInventory',
    'DISTRIBUTOR', settings->'initialInventory',
    'WHOLESALER',  settings->'initialInventory',
    'RETAILER',    settings->'initialInventory'),
  'initialFlow', 4)
WHERE jsonb_typeof(settings->'initialInventory') = 'number';

-- Down Migration
-- 役割ごとの違いは失われる（小売店の値を、全役割の値にする）。開発 DB だけの想定
ALTER TABLE games ADD COLUMN initial_inventory integer CHECK (initial_inventory >= 0);
UPDATE games SET initial_inventory = initial_inventory_retailer;
ALTER TABLE games
  ALTER COLUMN initial_inventory SET NOT NULL,
  DROP COLUMN initial_inventory_factory,
  DROP COLUMN initial_inventory_distributor,
  DROP COLUMN initial_inventory_wholesaler,
  DROP COLUMN initial_inventory_retailer,
  DROP COLUMN initial_flow;

UPDATE sessions SET settings = (settings - 'initialFlow')
  || jsonb_build_object('initialInventory', settings->'initialInventory'->'RETAILER')
WHERE jsonb_typeof(settings->'initialInventory') = 'object';
