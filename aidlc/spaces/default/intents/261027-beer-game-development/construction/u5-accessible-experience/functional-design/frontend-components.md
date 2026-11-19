# Frontend Components - U5 Accessible Experience

## Hierarchy and ownership

| Component | Parent | Props / owned state | Interaction and accessibility |
|---|---|---|---|
| AppShell | root | route、actor context、connection status | skip link、main landmark、H1、global live region |
| CreateGameForm | AppShell | draft settings、validation errors | field / summary error、値保持、成功時 code へ focus |
| JoinAndRecovery | AppShell | code、displayName、復帰状態 | token は browser secure storage に限定、失敗理由を text 表示 |
| Lobby | AppShell | role assignment、participant status | 4 役割の table、非色状態、進行役 action |
| PlayPage | AppShell | role-safe snapshot、version、connection state | 自役割値のみ、SSE と polling fallback、更新停止 |
| WeekProgress | PlayPage | currentWeek、step、status | ordered list、`aria-current="step"`、text marker |
| RoleDecisionForm | PlayPage | draft quantity、dirty / conflict state | input と error の関連付け、未保存値保持 |
| FacilitatorConsole | AppShell | role status、session lifecycle | 代理入力、停止、再開、終了を確認 dialog 経由で実行 |
| ConfirmActionDialog | PlayPage / FacilitatorConsole / RetentionPage | action、target、result | focus trap、Escape、trigger focus return、処理中の状態通知 |
| ObservationPage | AppShell | privacy-safe totals、suppression reason | suppressed value は DOM に置かず理由を表示 |
| ReviewPage | AppShell | ended-game series、selection | chart と同値 table を同時表示、table skip action |
| TimeSeriesComparison | ReviewPage | series selection、week range | pattern / direct label / summary、keyboard toggle |
| ExportPanel | ReviewPage | generation status、format | partial failure と complete を区別 |
| RetentionPage | AppShell | policy、Saga、owner progress | FAILED の未完 owner と retry 確認、COMPLETED の正確な表示 |

## State and data flow

AppShell は server からの role / game scope を画面ごとに再検査し、UI 側では非公開 field を受け取らない contract を使います。各 page は `loading`、`ready`、`empty`、`partial`、`error`、`stale`、`offline` を同一の StateRegion で示します。mutation は idempotency key と expected version を付け、成功時に server response の version を採用します。

PlayPage の SSE は game / role scope の server event だけを購読し、切断時は 1 秒 polling に切り替えます。利用者の「自動更新を停止」を尊重し、停止中は手動更新 button を残します。server version より古い response を適用せず、未保存 draft を維持します。

## Form and confirmation rules

| Form | Client assistance | Server authority | Error / focus behavior |
|---|---|---|---|
| Game creation | 必須、終了週 1〜50、数量非負整数、保持期間 | 設定・需要系列・保持方針 | 先頭 summary へ focus、field link で移動、値保持 |
| Join | code format、表示名必須 | code validity、game status、role | input を保持して理由を alert |
| Decision / proxy | 非負整数、許可上限 | role、week、version、quantity | conflict の latest と draft を併記 |
| Commit / end / retry | 明示確認のみ | 権限、状態遷移、冪等性 | 失敗時 dialog を維持し correlation ID と再試行 action |

## Responsive and assistive behavior

1024 px 以上は 2 column、200% zoom は 1 column へ reflow して全操作を維持します。実際の狭い端末では閲覧と復帰案内を優先しますが、画面幅だけで zoom と端末を区別できないため、操作を CSS で隠しません。device capability に依存する制限を設ける場合は明示的な環境判定と代替経路を要します。

keyboard、screen reader、forced colors、reduced motion の検証を各主要 flow に結び付けます。更新や動きは利用者が停止でき、chart の同値 table は常に accessibility tree に存在します。

## API integration points

| UI | Contract | Boundary |
|---|---|---|
| Create / Lobby / Play / Facilitator | C1 と U2 の公開 application interface | mutation は idempotency / version、role-safe response |
| Observation / Review / Export | C6 | game / role / ended authorization、complete export のみ |
| Retention | U4 operator API（共有契約補完が必要） | server-side operator authorization、receipt に PII なし |
| Live updates | SSE contract（共有契約補完が必要） | game / role scope、version、polling fallback |

## Sources

- `functional-spec.md`
- `inception/refined-mockups/interaction-spec.md`
- `inception/refined-mockups/accessibility-checklist.md`
- `inception/contract-design/contract-summary.md`
- `functional-design-questions.md` Q1〜Q3

## Assumptions & Open Questions

- screen reader / browser の正式な test matrix は NFR Requirements で確定します。
