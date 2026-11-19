# Reliability Requirements - U3 Learning View

## Requirements

| ID | Requirement | Verification |
|---|---|---|
| NFR2.1 | C6 monthly availability target is 99.9%. | Successful eligible requests / total over 30 days. |
| NFR2.2 | Projection update, processed-event marker, and cursor commit atomically; duplicate delivery changes nothing. | Crash injection around commit. |
| NFR2.3 | A gap or invalid event stops that session, preserves the last safe projection as stale, and starts bounded replay/rebuild. | Gap, reorder, duplicate, corrupt tests. |
| NFR2.4 | Replay/rebuild has RPO 0 and RTO ≤15 minutes for one 50-week game. | Quarterly destructive rebuild. |
| NFR2.5 | Export is COMPLETE only after both formats validate, have checksums, and match quantities/costs; partial artifacts are never downloadable. | Step fault injection. |

Transient failures retry at most five times with exponential backoff and jitter. Non-retryable events are quarantined. Queries expose building, failed, or stale state instead of incomplete current data.

## Sources

- `requirements.md` NFR2
- `contract-summary.md` C3
- `functional-spec.md`
