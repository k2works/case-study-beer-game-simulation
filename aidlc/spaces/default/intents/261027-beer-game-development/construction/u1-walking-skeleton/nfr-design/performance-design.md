# Performance Design - u1-walking-skeleton

## Design

- Fastify request schema validation、bounded payload、PostgreSQL prepared query と connection pool を使用します。
- week commit は 1 transaction / 1 aggregate lock とし、SimulationEngine は database I/O なしの pure calculation にします。
- role-safe current state は indexed `gameId/sessionId/role/version` query で取得し、unbounded history を返しません。
- commit 後は outbox row を dispatcher が読み、`NOTIFY` を低遅延 hint として各 instance に伝えます。client は version query で欠落を回復します。

## Budgets and Verification

API p95 1 second、commit-to-render p95 2 seconds、fallback polling 4 seconds を 75 concurrent user で測定します。database 450 ms、application 250 ms、SSE dispatch 500 ms、browser render 300 ms を design budget とし、end-to-end target を正本とします。

## Sources

`performance-requirements.md`、`scalability-requirements.md`、`functional-spec.md`、`contract-summary.md`。

## Assumptions & Open Questions

pool size と instance size は load test で調整します。
