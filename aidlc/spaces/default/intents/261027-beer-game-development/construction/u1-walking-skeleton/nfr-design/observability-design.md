# Observability Design - u1-walking-skeleton

## Telemetry Architecture

- OpenTelemetry-compatible trace context を HTTP → application → PostgreSQL → outbox dispatcher → SSE へ伝播します。
- JSON log は timestamp、severity、service、operation、opaque actor/game/session ID、outcome、correlation ID を allowlist で記録します。
- metrics は latency histogram、error / conflict / rollback count、pool utilization、outbox / SSE lag、active connection、version reconciliation count を持ちます。

## Alerts and Dashboard

active-session outage 1 minute、API p95 1 second、render p95 2 seconds、outbox/SSE lag 1 second、duplicate week / missing outbox 1 件を alert threshold とします。dashboard は SLO burn、game/session health、commit correctness、database、delivery lag を表示します。

## Sources

`observability-requirements.md`、`performance-requirements.md`、`reliability-requirements.md`、`contract-summary.md`。

## Assumptions & Open Questions

collector / metric / log backend product は Infrastructure Design で決定します。
