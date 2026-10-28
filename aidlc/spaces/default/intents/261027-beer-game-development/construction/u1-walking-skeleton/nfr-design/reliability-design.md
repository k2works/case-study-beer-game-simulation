# Reliability Design - u1-walking-skeleton

## Data Durability

- managed PostgreSQL Multi-AZ synchronous standby を使用し、commit acknowledgment は synchronous durable commit 後に返します。
- continuous WAL archive / PITR と automated backup を併用し、restore drill で RPO 0 / RTO 15 minutes を検証します。
- GameSession、WeekResult、RoleDecision、IdempotencyRecord、OutboxEvent は同じ transaction で commit します。

## Resilience

- database timeout 後の mutation は成功を推測せず、同じ idempotency key で reconciliation / retry します。
- retryable read と dispatcher は capped exponential backoff + jitter、mutation は idempotency evidence がある場合だけ retry します。
- liveness は process、readiness は database connectivity / migration compatibility を検査します。
- SSE failure は polling fallback、NOTIFY loss は outbox scan / version reconciliation で回復します。

## Sources

`reliability-requirements.md`、`security-requirements.md`、`functional-spec.md`、`nfr-design-questions.md`。

## Assumptions & Open Questions

managed service product と backup retention は Infrastructure Design で確定します。
