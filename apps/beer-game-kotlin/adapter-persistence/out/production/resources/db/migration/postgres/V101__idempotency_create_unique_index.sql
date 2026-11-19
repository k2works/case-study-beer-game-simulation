-- 101: PostgreSQL 固有。ゲーム作成（scope = 'create'）の冪等キーの部分一意索引。
-- 同じキーの同時の重複を、この索引の違反（uq_idempotency_create）で検出し、記録を再照合して保存済みの応答を返す。
-- H2 では部分一意索引が使えない（Step 1 の実測）ので、アプリケーション側で再照合する（ローカルでは守られない）。
-- 番号は B5 Step 5.5 で付け替えた（B1 で 102 として作った。作った順と番号の順を合わせるため、DB ロールと GRANT の 102 より前の 101 にした）。

CREATE UNIQUE INDEX uq_idempotency_create ON idempotency_records (scope, key_digest) WHERE scope = 'create';
