# Performance Requirements - U3 Learning View

## Targets

| ID | Requirement | Verification |
|---|---|---|
| NFR1.1 | 15 games and 90 concurrent readers under normal load: observation/review p95 ≤ 1 second and p99 ≤ 2 seconds. | 30-minute production-like load test. |
| NFR1.2 | Committed events become visible within 2 seconds p95 and 5 seconds p99. | Measure projection visibility lag. |
| NFR1.3 | Export accepts within 1 second and completes a 50-week, 4-role CSV+JSON package within 30 seconds p95. | End-to-end benchmark with validation enabled. |

Queries never synchronously rebuild. Export concurrency is bounded to two jobs per instance and excess work is queued.

## Sources

- `requirements.md` NFR1
- `functional-spec.md`
