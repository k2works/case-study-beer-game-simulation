# Logical Components - u1-walking-skeleton

## Component Inventory

| Component | Responsibility | Failure domain | Shared resource |
|---|---|---|---|
| React Web | facilitator / participant UI、version reconciliation、SSE fallback | browser tab | API / SSE |
| HTTP Boundary | schema、cookie / CSRF、correlation ID、Problem Details | Fastify instance | PostgreSQL pool |
| Game Application | authorization、idempotency、command/query orchestration | Fastify instance | PostgreSQL |
| SimulationEngine | deterministic 12-step calculation | in-process library | none |
| PostgreSQL | aggregate、result、credential digest、idempotency、outbox | Multi-AZ database | shared authoritative store |
| Outbox Dispatcher | ordered scan、publish hint、retry | worker process | PostgreSQL |
| SSE Gateway | role-safe event notification、reconnect | Fastify instance | PostgreSQL NOTIFY / query |
| Telemetry | trace、metric、redacted log | external collector degradation | correlation context |

## Blast Radius

HTTP/SSE instance failure affects only its connections and load balancer retries/reconnects them。Dispatcher failure delays notification but not committed state。Database primary failure pauses mutation until synchronous failover; no acknowledged week is lost。Telemetry failure must not block game flow and is buffered / dropped within bounded policy。

## Sources

All U1 NFR requirement artifacts、`functional-spec.md`、`contract-summary.md`、`tech-stack-decisions.md`。

## Assumptions & Open Questions

deployment count と network topology は Infrastructure Design で確定します。
