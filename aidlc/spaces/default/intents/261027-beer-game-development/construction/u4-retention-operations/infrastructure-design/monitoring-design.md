# Monitoring Design - U4 Retention Operations

## Metrics & KPIs

| Metric | Source | Threshold | Why it matters |
|---|---|---|---|
| deletion due / completed within 24h | PostgreSQL due cohort + CloudWatch custom metric | rolling 30 日で 99% | 期限到達全件を母集団とする削除 SLO |
| oldest due age | Saga query / CloudWatch | 18 時間 warning、24 時間 critical | deadline 前に運用介入する |
| SQS oldest message age | owner queue / CloudWatch | 15 分 warning、30 分 critical | delivery 停滞を検出する |
| DLQ visible count | SQS / CloudWatch | 1 件以上 | 契約不一致や恒久障害を検出する |
| receipt persistence failure | U4 application metric | 1 件以上 | COMPLETED を阻む障害を検出する |
| receipt expiry lag | cleanup worker metric | 5 分 warning、1 時間 critical | 1 年保持の超過を検出する |
| alert delivery latency | alert manager | terminal failure commit から受理まで 5 分以内 | 通知 SLI を検証する |
| ECS worker / DB pool saturation | ECS / application | CPU 70%、pool 80% が 10 分 | scale と接続 budget の早期警告 |

## Alerts

| Alert | Condition | Severity | Routes to |
|---|---|---|---|
| Deletion failed | permanent failure または retry 枯渇で FAILED に commit | P1 | 運営 primary channel、5 分未受理なら secondary channel |
| SLO at risk | due age 18 時間、または rolling 30 日 error budget burn | P2 | 運営 channel |
| Delivery stuck | queue oldest 15 分超、DLQ 1 件以上 | P2 | platform on-call |
| Receipt persistence / cleanup | 保存失敗または expiry lag 5 分超 | P1 | platform on-call + privacy owner |
| Restore gate remains closed | restore 後の expiry sweep が未完了 | P1 | incident commander |

## SLIs / SLOs

| SLI | SLO target | Measurement window |
|---|---|---|
| `completedAt <= deleteAfter + 24h` の Saga / `deleteAfter` 到達全 Saga | 99% | rolling 30 日。承認済み hold は別 series に併記し、母集団からは除外しない |
| FAILED commit から運営 channel が受理した通知の割合 | 100% を 5 分以内 | rolling 30 日、個別の違反は即時 escalation |
| 期限切れ receipt の外部読取 | 0 件 | 継続監視、restore rehearsal 時にも検証 |

## Logs & Tracing

| Signal | Configuration | Retention |
|---|---|---|
| Structured JSON logs | `correlationId`、`deletionId`、`ownerUnit`、`attempt`、`eventId`、低 cardinality failure code の allowlist。PII / token / payload は禁止 | 30 日 hot、必要な監査集計は別の定義済み保存期間に従う |
| Traces | API → scheduler / outbox → owner queue → completion consumer の context propagation。error / terminal span は全件保存 | 7 日 hot |
| Audit metrics | policy change、manual retry、receipt cleanup、restore gate の結果を count として記録 | 30 日 trend |

## Dashboard

current と rolling 30 日について、削除 SLO / budget、due age、owner queue lag、DLQ、retry / failure code、receipt cleanup、alert delivery、ECS / DB saturation を同一画面で確認します。

## Sources

- `nfr-design/observability-design.md`
- `nfr-design/reliability-design.md`
- `infrastructure-design-questions.md` Q2

## Assumptions & Open Questions

- 通知経路の具体的な運営 channel は environment provisioning 時に接続先を設定します。
