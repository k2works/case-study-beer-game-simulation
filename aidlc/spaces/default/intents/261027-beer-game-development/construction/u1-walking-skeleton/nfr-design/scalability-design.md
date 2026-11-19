# Scalability Design - u1-walking-skeleton

## Design

- React static assets と stateless Fastify instance を load balancer 配下で水平拡張します。
- PostgreSQL が authoritative state、transactional outbox、idempotency record を所有します。
- LISTEN/NOTIFY は wake-up hint に限定し、instance / client は resource version を照合して missed notification を database query で回復します。
- SSE reconnect は last known version を渡し、server は current safe state を再送します。sticky session は correctness の前提にしません。

## Capacity and Triggers

75 active SSE connection、15 game、60 decision burst を initial target とします。API p95 800 ms、pool utilization 70%、SSE lag 1 second を 5 minutes 超過した場合に scale review / alert を開始します。

## Sources

`scalability-requirements.md`、`performance-requirements.md`、`tech-stack-decisions.md`、`nfr-design-questions.md`。

## Assumptions & Open Questions

Redis は初期構成に含めず、PostgreSQL notification capacity が不足した測定結果が出た場合に追加します。
