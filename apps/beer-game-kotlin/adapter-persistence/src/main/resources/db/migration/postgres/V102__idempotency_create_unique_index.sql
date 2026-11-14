-- 102: PostgreSQL 固有。ゲーム作成（scope = 'create'）の冪等キーの部分一意索引。
-- 同じキーの同時の重複を、この索引の違反（uq_idempotency_create）で検出し、記録を再照合して保存済みの応答を返す。
-- H2 では部分一意索引が使えない（Step 1 の実測）ので、アプリケーション側で再照合する（ローカルでは守られない）。
-- 番号 101（DB ロールと GRANT。B2）は空けてある。

CREATE UNIQUE INDEX uq_idempotency_create ON idempotency_records (scope, key_digest) WHERE scope = 'create';
