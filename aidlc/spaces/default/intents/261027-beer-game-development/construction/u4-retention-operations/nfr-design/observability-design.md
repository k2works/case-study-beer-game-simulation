# Observability Design - U4 Retention Operations

## Signal architecture

OpenTelemetry-compatible meter、logger、tracer を Fastify、scheduler、outbox、worker に組み込みます。`correlationId`、`deletionId`、`ownerUnit`、`attempt`、`eventId` を allowlist 属性として伝播し、game ID と payload は記録しません。

## Metrics and SLI

| Metric | Purpose |
|---|---|
| `deletion_due_total`, `deletion_completed_within_24h_total` | rolling 30 日の 24 時間 SLI |
| `deletion_age_seconds` | due から terminal までの histogram |
| `deletion_queue_oldest_seconds`, `deletion_queue_depth` | lag と capacity |
| `deletion_owner_completion_total{owner,status}` | owner 別結果 |
| `deletion_retry_total{owner,failure_code}` | retry / failure 分析 |
| `deletion_receipt_persist_failure_total` | 完了阻害の検知 |
| `deletion_alert_delivery_total{channel,status}` | 5 分通知 SLI |

## Logging and tracing

scheduler scan、C4 outbox publish、C5 consume、retry scheduling、terminal transition、receipt cleanup を structured event として 100% 記録します。trace span は DB transaction と broker publish/consume を結び、sampling 外でも error と terminal span を保持します。exporter 前に禁止 field scan と redaction を行います。

## Alerts and escalation

- permanent failure または retry exhaustion の transaction commit を alert timer の起点とします。
- 5 分以内に alert manager が運営 channel への送信を受理し、delivery status を記録することを成功とします。未受理・失敗は secondary channel へ escalation します。
- 24 時間 SLO burn、oldest queue age 15 分、DLQ 1 件以上、receipt persistence failure、cleanup failure を alert 対象とします。

## Dashboards

current status と 30 日 trend に、SLO / error budget、due age、queue lag、owner completion、retry、failure code、receipt cleanup を表示します。failure code は低 cardinality enum に限定します。

## Sources

- `nfr-requirements/observability-requirements.md`
- `nfr-design-questions.md` Q2、Q3

## Assumptions & Open Questions

None.
