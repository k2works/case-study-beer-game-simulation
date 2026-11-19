# Bolt Plan - ビールゲームシミュレーション

## Planning Approach

Bolt は、1 つ以上の Unit を実行可能な状態まで仕上げる 1 回の build pass です。本計画は walking-skeleton-first とし、各 Bolt に 1 Unit を割り当て、unit-major / serial で進めます。最初に walking skeleton（主要な integration point を通る最小の end-to-end slice）を完成させ、その後は依存 DAG、価値、risk 低減、規模の qualitative scoring に従います。

| Order | Bolt | Unit | Size | Value | Risk reduction | Dependency |
|---|---|---|---|---|---|---|
| 1 | B1 Core Week Flow | U1 `u1-walking-skeleton` | XL | High | High | None |
| 2 | B2 Session Continuity | U2 `u2-session-continuity` | L | High | High | B1 |
| 3 | B3 Learning View | U3 `u3-learning-view` | L | High | Medium | B1 |
| 4 | B4 Retention Operations | U4 `u4-retention-operations` | M | Medium | High | B1, B2, B3 |
| 5 | B5 Accessible Experience | U5 `u5-accessible-experience` | L | High | Medium | B1, B2, B3, B4 |

U2 と U3 は DAG 上は並行可能ですが、明示された serial execution を優先します。U2 を先に置くのは、復旧、stale update、代理入力、credential lifecycle が core state の整合性と security を早期に検証するためです。

## B1 Core Week Flow - Walking Skeleton

- **Included Unit**: U1 `u1-walking-skeleton`
- **Definition of Done**: 1 ゲームを作成し、4 役割を割り当て、各役割が非負整数を入力し、1 週を原子的かつ冪等に確定し、role-safe state を real database から表示できる。Given/When/Then を実装前に作成し、golden test、authorization test、integration test、E2E test、80% line coverage を満たす。
- **Confidence hypothesis**: 同じ初期状態と入力から同じ結果が得られ、重複確定が二重計上されず、他役割の値が漏れなければ、simulation の正確性、transaction boundary、情報制約を端から端まで実現できる。
- **Expected demo**: 進行役が game を作成し、4 role が参加・入力し、1 回の week commit 後に各 role の許可された状態だけが更新される。
- **Prerequisite**: JSD 改訂版教材と照合した preset demand series と初期値。遅延時は custom series で技術検証を先行し、JSD 準拠の受入判定は保留する。
- **Contract follow-up**: C1 の schema、security、correlation ID、idempotency scope / retention / payload mismatch error を Functional / NFR Design で解消する。

## B2 Session Continuity

- **Included Unit**: U2 `u2-session-continuity`
- **Definition of Done**: pause、proxy input、resume、end、recovery token、multi-tab conflict、restart recovery を実装し、actor / role / time / value の audit と BDD regression を備える。
- **Confidence hypothesis**: process restart、一時切断、重複 retry、stale client があっても、最後の確定済み状態から安全に継続できる。
- **Expected demo**: game を停止し、進行役が代理入力し、再開後に参加者が recovery token で同じ role へ復帰する。
- **Contract follow-up**: U2→U5 の session operation と UI state contract、および C2 の timeout、retry、unknown outcome reconciliation を確定する。

## B3 Learning View

- **Included Unit**: U3 `u3-learning-view`
- **Definition of Done**: outbox event から observation / review / export projection を冪等に構築し、privacy-safe totals、ended-game chart / table、versioned CSV / JSON、partial failure 表示を実装する。
- **Confidence hypothesis**: at-least-once event delivery でも projection が一致し、観察中の個別 role 情報を開示せず、終了後に Bullwhip Effect を説明できる。
- **Expected demo**: play 中は privacy-safe aggregate を表示し、終了後は同一週軸の分析と一致する CSV / JSON を生成する。
- **Contract follow-up**: C3 の event-type 別 payload schema、privacy boundary、rebuild rule と、C6 の schema、security、timeout / retry / reconciliation を確定する。

## B4 Retention Operations

- **Included Unit**: U4 `u4-retention-operations`
- **Definition of Done**: retention scheduler、game-scoped deletion saga、owner completion、retry / dead-letter / alert、operator-visible status、PII を含まない receipt lifecycle を実装する。
- **Confidence hypothesis**: partial failure があっても削除を完了と誤認せず、各 owner data を最終的に一度削除し、監査可能な結果を残せる。
- **Expected demo**: 期限到達 game の削除を開始し、owner ごとの進行・retry・最終結果を表示する。
- **Contract follow-up**: U4→U5 の retention status contract、C4 / C5 の state machine、deadline、retry cap、terminal state、receipt owner / retention を確定する。

## B5 Accessible Experience

- **Included Unit**: U5 `u5-accessible-experience`
- **Definition of Done**: U1〜U4 の全 flow を refined mockups に沿って完成し、keyboard、focus、screen reader、contrast、non-color status、zoom reflow、loading / empty / error / partial / stale / offline state を自動・手動 test で確認する。
- **Confidence hypothesis**: capability contract を再実装せず、主要な利用者が supported desktop browser で支援技術を含めて全 flow を完了できる。
- **Expected demo**: game creation から play、facilitation、observation、review、export、retention status まで keyboard のみで操作する。

## Sources

- `inception/requirements-analysis/requirements.md`
- `inception/user-stories/stories.md`
- `inception/refined-mockups/mockups.md`
- `inception/domain-design/components.md`
- `inception/units-generation/unit-of-work.md`
- `inception/units-generation/unit-of-work-dependency.md`
- `inception/units-generation/unit-of-work-story-map.md`
- `inception/contract-design/contract-summary.md`
- `inception/practices-discovery/team-practices.md`
- `inception/delivery-planning/delivery-planning-questions.md`

## Assumptions & Open Questions

- concrete technology stack と database product は Functional / NFR / Infrastructure Design で確定します。
- Contract Design で受容された 6 件の Major finding は、上記 Contract follow-up を各 Bolt の着手条件として解消します。
