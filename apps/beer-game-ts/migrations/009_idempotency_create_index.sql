-- Up Migration
-- createGame の冪等（共有の API の契約: 変更系は Idempotency-Key が必須。同じキーの再送は、保存した応答を返す）。
-- docs/development/beer-game-ts/api_alignment_plan.md（案 3。2026-11-24 に承認）。
-- 作成の要求は、ゲームの存在前に届くので、ゲームの ID でなく、キーのダイジェストだけで探す。
-- 新しいゲームの ID を game_id として、作成と同じトランザクションで記録する（外部キーは満たされる）。
-- 同じキーの同時の重複は、この一意制約の違反になる（アプリは、1 回だけやり直して、保存済みの応答を返す）
CREATE UNIQUE INDEX uq_idempotency_create
  ON idempotency_records (key_digest) WHERE scope = 'create';

-- Down Migration
DROP INDEX uq_idempotency_create;
