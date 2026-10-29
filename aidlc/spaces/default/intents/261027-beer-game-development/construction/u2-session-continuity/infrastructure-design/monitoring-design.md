# Monitoring Design - U2 Session Continuity

## Metrics & KPIs

| Metric | Source | Threshold | Why it matters |
|---|---|---|---|
| command p95 / p99 latency | Fastify EMF | 500 ms / 1 s | lifecycle API target を監視します。 |
| recovery snapshot p95 | Fastify EMF | 1 s | reconnect UX を保護します。 |
| reconciliation duration | browser synthetic + API | 5 s | SSE gap 復旧を検査します。 |
| outbox lag | PostgreSQL query / dispatcher | 30 s warning、120 s critical | durable event delivery の停滞を検出します。 |
| recovery failure ratio | application metric | 20% and 20 attempts / 5 min | abuse と障害を区別して調査します。 |
| audit sequence violations | invariant job | 1 event | correctness failure を即時検出します。 |
| DB connections | RDS | max の 70% | scale-out による pool exhaustion を防ぎます。 |
| ECS task health | ECS / ALB | healthy tasks < 2 production | multi-AZ availability を守ります。 |

## Alerts

| Alert | Condition | Severity | Routes to |
|---|---|---|---|
| Continuity latency | p95 > 500 ms for 5 min | warning | on-call notification |
| Recovery unavailable | synthetic failure 2 consecutive runs | critical | on-call + incident channel |
| Outbox lag | >30 s for 2 periods / >120 s once | warning / critical | on-call |
| Audit invariant | gap、duplicate、redaction violation > 0 | critical | security + on-call |
| Restart recovery | deployment 後 1 minute 内の synthetic recovery failure | critical | deployment owner + on-call |
| Database saturation | connections >70% or storage <20% | warning | platform owner |

## SLIs / SLOs

| SLI | SLO target | Measurement window |
|---|---|---|
| valid continuity request non-5xx ratio | 99.9% | rolling 30 days |
| command latency | p95 ≤500 ms、p99 ≤1 s | rolling 15 min and 24 h |
| recovery snapshot latency | p95 ≤1 s | rolling 15 min |
| state / audit / outbox invariant success | 100% | every transaction and hourly scan |

## Logs & Tracing

ECS stdout の JSON を CloudWatch Logs に集約し、correlationId を ALB request、application span、RDS span、outbox event へ伝播します。X-Ray / OpenTelemetry collector は error と slow trace を sampling し、credential fields は exporter 前の allowlist processor で除外します。

## Dashboards

Continuity dashboard は latency、error code、recovery result、SSE reconnect、outbox lag、ECS capacity、RDS pool / storage を 1 画面に表示し、各 alarm から runbook と Logs Insights query へ link します。

