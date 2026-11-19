# Accessibility Checklist

Target: WCAG 2.2 AA

## Perceivable

- [ ] normal text は 4.5:1 以上、large text と UI component は 3:1 以上です。
- [ ] 状態は色だけでなく text と icon でも表現します。
- [ ] chart は pattern、直接 label、text summary、table alternative を持ちます。
- [ ] zoom 200% で内容と機能を失わず 1 column に reflow します。

## Operable

- [ ] skip link から main content へ移動できます。
- [ ] すべての操作を keyboard だけで完了できます。
- [ ] focus indicator は 3 px、背景との contrast 3:1 以上です。
- [ ] dialog は focus trap、Escape、trigger への focus return を実装します。
- [ ] 自動更新を pause または停止でき、操作に時間制限を設けません。
- [ ] target size は原則 24 × 24 CSS px 以上です。

## Understandable

- [ ] page title と H1 は画面目的を表します。
- [ ] label、help、error は field と programmatically 関連付けます。
- [ ] error summary から対象 field へ移動できます。
- [ ] 週確定、ゲーム終了、削除は実行内容と結果を確認できます。
- [ ] 同じ action と状態に一貫した用語を使用します。

## Robust

- [ ] native HTML を優先し、ARIA は不足する semantics だけを補います。
- [ ] dynamic status は適切な live region で通知します。
- [ ] custom component は name、role、value、state を accessibility tree に公開します。
- [ ] Chrome、Edge、Firefox、Safari の最新 2 世代で keyboard と screen reader の smoke test を行います。

## Screen-specific checks

| Screen | Required checks |
|---|---|
| 開始 | form label、復帰 action の優先順、error summary |
| ゲーム作成 | 50 週境界、需要系列 table の header、error focus |
| ロビー | 状態の非色表現、役割割当て dialog、動的参加通知 |
| 週次プレイ | step の `aria-current`、入力保持、stale / pause 通知 |
| 進行役 console | role status table、代理入力と終了の確認 |
| 振り返り | chart alternative、series toggle、長い table の navigation |

## Acceptance evidence

- automated: semantic HTML、accessible name、contrast、keyboard rule の lint / E2E check。
- manual: 200% zoom、keyboard-only、screen reader、forced colors、reduced motion。
- BDD: 各主要 flow に keyboard 操作と error recovery の Given/When/Then を実装前に追加します。

## Sources

- `requirements.md` NFR5、NFR6
- `stories.md` Cross-Cutting Acceptance
- `mockups.md`
- `interaction-spec.md`

## Assumptions & Open Questions

- screen reader の正式な組合せは Tech Stack 決定後に、browser support matrix と合わせて確定します。

