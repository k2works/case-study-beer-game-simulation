# Risk and Sequencing Rationale - ビールゲームシミュレーション

## Heuristic

walking-skeleton-first と lightweight qualitative scoring を組み合わせます。qualitative scoring は value、risk reduction、size を High / Medium / Low で比較する方法であり、根拠のない数値精度を避けます。順序は依存 DAG を満たし、最初に end-to-end uncertainty を減らし、その後に state continuity、learning value、data lifecycle、cross-cutting UX を完成させます。

## Sequence Rationale

| Bolt | Value | Risk reduction | Size | Why now |
|---|---|---|---|---|
| B1 | High | High | XL | simulation correctness、atomicity、idempotency、role authorization、real persistence を最初に実証するため |
| B2 | High | High | L | B1 の state model に対する restart、reconnect、stale update、credential risk を早期に潰すため |
| B3 | High | Medium | L | B1 event を利用して learning outcome を提供し、U4 が必要とする projection owner を完成するため |
| B4 | Medium | High | M | U1〜U3 の owner contract が揃った後で deletion saga を安全に閉じる必要があるため |
| B5 | High | Medium | L | 全 capability contract の確定後に、重複実装を避けながら全 flow の accessibility を統合するため |

## DAG Check

- B1 / U1 は dependency なしです。
- B2 / U2 と B3 / U3 は B1 / U1 の後です。
- B4 / U4 は U1、U2、U3 の後です。
- B5 / U5 は U1〜U4 の後です。
- topological order からの deviation はありません。U2 と U3 の parallel opportunity はありますが、選択された serial execution により B2 → B3 とします。

## Primary Risks and Responses

| Risk | Early evidence | Response / gate |
|---|---|---|
| 週次計算が教材規則と不一致 | B1 golden test と 1-week E2E | JSD preset / initial values を照合し、同一 input の deterministic output を固定する |
| 重複確定または中断で二重計上・部分更新 | B1 concurrent retry / fault injection test | idempotency key、optimistic concurrency、single transaction を実証する |
| 他 role や未来需要の漏洩 | B1 authorization / negative API test | role-safe response を server 側で生成し、UI / API / export の禁止値を test する |
| restart / reconnect で状態喪失 | B2 restart recovery と stale client test | durable state、credential digest、version reconciliation を確認する |
| event schema 不足で projection が推測実装 | B3 contract test | C3 を event-type 別 discriminated schema に補完する |
| deletion が永久に進行中または監査不能 | B4 saga failure test | deadline、retry cap、terminal state、receipt ownership を確定する |
| 後付け accessibility で再設計が発生 | B1〜B4 の UI acceptance + B5 | U1 の最小 UI から semantic structure と keyboard operation を維持する |

## Contract Review Findings

Contract Design で受容された R-01〜R-06 は risk acceptance であり、実装省略ではありません。U2 / U4 から U5 への contract、OpenAPI schema / security、event payload、deletion saga terminal behavior、receipt ownership、timeout / retry / reconciliation を該当 Bolt の design entry criteria とします。

## Sources

- `inception/requirements-analysis/requirements.md`
- `inception/user-stories/stories.md`
- `inception/domain-design/components.md`
- `inception/units-generation/unit-of-work.md`
- `inception/units-generation/unit-of-work-dependency.md`
- `inception/contract-design/contract-summary.md`
- `inception/practices-discovery/team-practices.md`
- `inception/delivery-planning/delivery-planning-questions.md`

## Assumptions & Open Questions

- scoring は relative comparison に使用し、delivery date の見積りには使用しません。
