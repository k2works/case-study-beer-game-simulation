# NFR Design Questions - U2 Session Continuity

## Decisions

### Q1. 状態と event 配信の authority

A. PostgreSQL を唯一の authority とし、transactional outbox と snapshot reconciliation を使う
B. application memory を authority とし、定期的に PostgreSQL へ保存する
X. Other (please specify)

[Answer]: A

### Q2. recovery credential の保護

A. 256-bit opaque token を発行し、server には keyed digest のみ保存する
B. 自己完結 JWT を browser に保存する
X. Other (please specify)

[Answer]: A

### Q3. multi-instance 同期

A. stateless application、PostgreSQL-backed state、durable outbox、SSE + polling fallback を使う
B. sticky session と instance-local event buffer を使う
X. Other (please specify)

[Answer]: A

### Q4. 障害時の整合性

A. state、audit、idempotency、outbox を 1 transaction で保存し、失敗時は全体を rollback する
B. 各 record を個別保存し、後から補償する
X. Other (please specify)

[Answer]: A

## Assumptions & Open Questions

- U1 で選定済みの TypeScript、Fastify、React、PostgreSQL、Vitest、Playwright を継続します。
- production の recovery token digest は環境別 secret を使う HMAC-SHA-256 とし、secret rotation は key version を併記して段階移行します。
- event broker を追加せず、PostgreSQL outbox を dispatcher が配信します。

