# Observability Requirements - U3 Learning View

## Signals

| ID | Requirement | Verification |
|---|---|---|
| NFR7.1 | Structured logs include correlation/event identifiers, hashed session identifier, operation, result, versions, and duration; no token, display name, private value, or export content. | Log allow/deny test. |
| NFR7.2 | Metrics cover C6 rate/error/latency, consumer lag/gaps/duplicates, rebuilds, projection states, export queue/duration/failure, and suppression count. | Metrics contract test. |
| NFR7.3 | Payload-free traces link HTTP, authorization, projection, export, and event consumption. | Trace sampling test. |
| NFR7.4 | Alert on p95 >1 second/10 minutes, lag >5 seconds/5 minutes, gap >2 minutes, rebuild failure, export failures >5%/15 minutes, or SLO burn. | Synthetic alert tests. |

Dashboards show SLO burn, latency, errors, lag, rebuilds, exports, and privacy suppression. Every alert links a runbook.

## Sources

- `requirements.md` NFR7
- `contract-summary.md`
