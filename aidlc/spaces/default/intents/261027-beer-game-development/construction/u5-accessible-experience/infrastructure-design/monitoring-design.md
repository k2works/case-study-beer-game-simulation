# Monitoring Design - u5-accessible-experience

## Metrics & KPIs

| Metric | Source | Threshold | Why it matters |
|---|---|---|---|
| Input end-to-end p95 | browser RUM + server trace | 5 分 window で 1 秒超 | NFR1.10 の user-visible 遅延。成功した入力確定を母集団にする。 |
| Commit-to-render p95 | synthetic browser + correlated server commit | 5 分 window で 2 秒超 | SSE 接続中の NFR1.11。 |
| Fallback reflection max | SSE 障害注入の synthetic browser | 4 秒超 | polling 時の NFR1.12。 |
| SSE disconnect / fallback rate | browser connection event + ALB / API | 5 分で 10% 超 | stream 障害と容量不足の早期検知。 |
| 75-user fallback API p95 / error | API / ALB | p95 700 ms 超または 5xx 1% 超 | polling が server 予算を圧迫するか確認。 |
| Auth / Origin denial | API security event | 平常 baseline から急増 | cookie / Origin 設定誤りと攻撃を区別する。 |
| UI error recovery | browser telemetry | 失敗後の再試行成功率低下 | ユーザーが未保存入力を失わず復旧できるか見る。 |

## Alerts

| Alert | Condition | Severity | Routes to |
|---|---|---|---|
| UI performance burn | end-to-end p95 > 1 秒が 5 分 | High | application on-call |
| Live update delay | SSE commit-to-render p95 > 2 秒が 5 分 | High | application on-call |
| Fallback failure | synthetic fallback > 4 秒、または snapshot 5xx > 1% が 5 分 | High | application on-call |
| Browser auth regression | deploy 後の Origin denial 急増、cookie-less 401 急増 | High | application on-call / security owner |
| Static asset failure | CloudFront 5xx > 1% が 5 分 | High | platform on-call |

## SLIs / SLOs

| SLI | SLO target | Measurement window |
|---|---|---|
| 成功した入力確定の browser end-to-end p95 | 1 秒以内 | rolling 5 分、15 game × 5 user の負荷試験と実運用傾向 |
| SSE 接続中の commit-to-render p95 | 2 秒以内 | rolling 5 分。server commit と browser receipt を同じ synthetic session の clock で測る。 |
| SSE 切断時の commit-to-render | 4 秒以内 | 障害注入 synthetic。通常 SLI と分離。 |
| U1 baseline の API availability | 月次 99.5% | rolling 30 日。U5 だけの別 SLO を作らない。 |

## Logs & Tracing

| Stream | Retention / protection | Correlation |
|---|---|---|
| Browser telemetry | event / outcome / timing / correlation ID の allowlist、環境別 retention | server response の correlation ID と request span を関連付ける。 |
| API / SSE logs | 既存 CloudWatch 暗号化、表示名・参加コード・token を redact | request、snapshot、SSE 通知に同じ correlation ID。 |
| CI accessibility evidence | CI artifact と release manifest に browser / screen reader version を保存 | commit SHA と deployment digest に紐付ける。 |

dashboard は user-visible latency、SSE / fallback、API errors、static asset errors、Origin denial、前回 release を同じ時系列に表示します。

## Sources

- `construction/u5-accessible-experience/nfr-design/performance-design.md`
- `construction/u5-accessible-experience/nfr-design/security-design.md`
- `construction/u5-accessible-experience/nfr-design/logical-components.md`
- `construction/u5-accessible-experience/functional-design/functional-spec.md`
- `inception/domain-design/components.md`
- `inception/contract-design/contract-summary.md`

## Assumptions & Open Questions

- browser RUM は opt-in / privacy 方針と sampling を release 前に確定します。受入判定は synthetic browser で行い、RUM だけに依存しません。
