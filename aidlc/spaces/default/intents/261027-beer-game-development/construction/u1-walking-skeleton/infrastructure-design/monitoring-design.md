# Monitoring Design - u1-walking-skeleton

## Metrics & KPIs

| Metric | Source | Threshold | Why it matters |
|---|---|---|---|
| API latency p95 | ALB + application OTEL | > 1 s for 5 min | NFR1.1 |
| Commit-to-render p95 | application + browser telemetry | > 2 s for 5 min | NFR1.2 |
| HTTP 5xx / commit failure | ALB / app | > 1% or active-session failure for 1 min | availability |
| RDS CPU / connections / replica state | RDS | CPU > 70%、pool > 70%、standby unhealthy | capacity / durability |
| Outbox / SSE lag p95 | worker / app | > 1 s for 5 min | live update freshness |
| Invariant violation | app correctness metric | any occurrence | duplicate / missing result detection |

## Alerts

| Alert | Condition | Severity | Routes to |
|---|---|---|---|
| Active session outage | critical operation unavailable 1 min | Critical | on-call + incident channel |
| Data correctness | duplicate week、missing outbox、negative invariant | Critical | on-call + engineering lead |
| RDS failover / backup | failover、backup/PITR failure | Critical | platform on-call |
| Latency burn | API or render SLO threshold 5 min | High | application on-call |
| Delivery lag | outbox/SSE lag threshold 5 min | High | application on-call |
| Budget | forecast or actual > configured budget | Medium | owner + FinOps |

## SLIs / SLOs

| SLI | SLO target | Measurement window |
|---|---|---|
| eligible request availability | 99.5% | rolling month |
| decision / state p95 | <= 1 s | 5 min and monthly report |
| commit-to-render p95 | <= 2 s | 5 min and monthly report |
| committed data durability | 0 acknowledged loss | continuous / restore drill |

## Logs & Tracing

ECS stdout JSON log を encrypted CloudWatch Logs へ集約し、retention と export policy を environment 別に設定します。OTEL trace は correlation ID を HTTP、PostgreSQL、outbox、SSE へ伝播し、token、display name、role-private data を attribute にしません。

## Sources

`observability-design.md`、`performance-design.md`、`reliability-design.md`、`security-design.md`、`infrastructure-specification.md`。

## Assumptions & Open Questions

on-call destination と log retention 日数は operation planning で確定します。
