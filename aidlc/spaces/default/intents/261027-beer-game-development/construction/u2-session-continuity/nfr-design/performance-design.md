# Performance Design - U2 Session Continuity

## Latency budgets

| Flow | Total target | Budget |
|---|---:|---|
| pause / resume / end / proxy decision | p95 500 ms、p99 1 s | HTTP 40 ms、認可と validation 60 ms、transaction 300 ms、response 100 ms |
| reconnect snapshot | p95 1 s at 75 users | token lookup 100 ms、projection query 500 ms、serialization / network 400 ms |
| reconnect reconciliation | 5 s 以内 | SSE reconnect 2 s、gap detection 500 ms、snapshot 1 s、UI apply 1.5 s |

## Query and transaction strategy

- recovery credential は `token_digest` の unique index で lookup し、取得列を membership、expiry、revocation、key version に限定します。
- session snapshot は `session_id`、`aggregate_version`、current week を index key とし、1 round trip で role-safe projection の材料を取得します。
- lifecycle mutation は aggregate row の optimistic version check、audit、idempotency record、outbox insert を 1 transaction にまとめます。
- application instance は bounded PostgreSQL pool を持ち、instance ごとの最大 connection 数を 20、query timeout を 2 s、transaction timeout を 3 s とします。
- snapshot response は actor ごとの非公開情報を含むため shared cache に保存しません。ETag / `stateVersion` による conditional response のみ許可します。

## Async work

Outbox 配信と SSE fan-out は request transaction の外で非同期実行します。HTTP success は durable outbox insert の commit を条件とし、実際の SSE delivery を待ちません。dispatcher は batch size 100、idle poll 500 ms、指数 backoff + jitter、最大 30 s で再試行します。

## Verification

- k6 で 25 games、75 reconnect users、100 SSE connections を作り、p95 / p99 と error rate を測定します。
- Vitest integration test で index 利用、query count、transaction timeout、gap reconciliation を検査します。
- production-like PostgreSQL で `EXPLAIN (ANALYZE, BUFFERS)` を保存し、snapshot query が sequential scan に退行した場合は CI を失敗させます。

## Requirement coverage

NFR10.1、NFR10.2、NFR10.3、NFR12.1、NFR12.2 をこの設計で満たします。

