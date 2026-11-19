# Monitoring Design - U3 Learning View

## Collection

- ECS Container Insights and ALB/RDS/SQS/S3 metrics feed CloudWatch dashboards.
- OpenTelemetry Collector receives payload-free traces and application metrics; JSON logs use 30-day hot retention and encrypted archival according to project policy.
- Dashboards cover API RED, projection lag/gaps/rebuilds, export queue/duration/failure, database saturation, and privacy suppression.

## Alerts

| Severity | Condition | Response |
|---|---|---|
| P1 | availability error-budget fast burn, sensitive-data scan failure, unrecoverable rebuild | Page and runbook. |
| P2 | p95 >1 s for 10 min, lag >5 s for 5 min, gap >2 min, export failures >5% for 15 min, DLQ message | Ticket/on-call notification. |
| P3 | CPU >60%, DB connections >70%, queue age >5 s, cost anomaly | Dashboard and capacity review. |

Every alarm includes environment, service, correlation search, and runbook link. Synthetic checks call observation and ended-review paths without protected data.

## Sources

- U3 `observability-design.md`, `performance-design.md`
