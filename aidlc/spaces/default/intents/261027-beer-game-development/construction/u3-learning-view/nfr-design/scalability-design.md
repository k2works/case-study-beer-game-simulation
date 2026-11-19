# Scalability Design - U3 Learning View

## Strategy

- Stateless HTTP instances scale horizontally behind the existing load balancer.
- Event work is partitioned by `sessionId`; one lease-holder advances a session cursor while duplicates are safely acknowledged.
- Export workers use a durable queue and per-instance bulkhead of two jobs. Database-wide concurrency is configuration bounded.
- PostgreSQL partitions large projection/event-marker tables by retention month; game/session indexes preserve query locality.
- Autoscaling signals: HTTP CPU >60% or p95 >750 ms, consumer lag >2 seconds, export queue age >5 seconds. Scale-in waits for consumer lease handoff and active exports.

## Overload

Bounded queues reject excess requests with `429 Retry-After`; observation remains higher priority than export generation.

## Sources

- `scalability-requirements.md`
