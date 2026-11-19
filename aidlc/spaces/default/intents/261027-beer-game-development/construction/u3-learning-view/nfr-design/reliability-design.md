# Reliability Design - U3 Learning View

## Event processing

- One PostgreSQL transaction writes projection rows, processed `eventId`, and session cursor.
- Duplicate event: acknowledge without change. Next version: apply. Gap: mark stale, pause partition, request replay; if unavailable, request an owner-provided snapshot and rebuild into shadow tables before atomic pointer swap.
- Transient storage/transport failures retry 5 times with exponential backoff (100 ms base, 5 s cap, full jitter). Invalid schema/data is quarantined and alerted without advancing.

## Export state machine

`PENDING → GENERATING → COMPLETE|FAILED`. CSV and JSON are temporary until schema, row count, totals, costs, and checksums pass; publication is one atomic metadata transaction. Cleanup removes all partial objects.

## Recovery

- Shallow health checks cover process readiness; deep checks cover database, consumer lag, and queue for alerting only.
- RPO 0 derives from durable C3 replay/snapshot. A quarterly game rebuild must meet 15-minute RTO.
- Query degradation returns last-safe stale data only when explicitly marked; review/export never claim completeness while rebuilding.

## Sources

- `reliability-requirements.md`
- `functional-spec.md`
