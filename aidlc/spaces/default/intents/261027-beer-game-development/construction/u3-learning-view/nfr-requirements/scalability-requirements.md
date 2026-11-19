# Scalability Requirements - U3 Learning View

## Capacity

| ID | Requirement | Verification |
|---|---|---|
| NFR1.4 | Support 15 simultaneous games, 90 readers, 60 event streams, and 10 concurrent export requests without breaching latency targets. | Step-load to 150% target. |
| NFR1.5 | Consumers scale horizontally by session partition; one ordered consumer processes a session while duplicate delivery remains safe. | Rebalance test. |
| NFR1.6 | Storage grows linearly with game-weeks and retains 30% headroom at the 90-day peak. | Quarterly capacity model. |

Scale queries at CPU >60% or p95 >750 ms; consumers at lag >2 seconds; workers at queue age >5 seconds. Overload returns `429` with `Retry-After`.

## Sources

- `requirements.md` NFR1
- `functional-spec.md`
