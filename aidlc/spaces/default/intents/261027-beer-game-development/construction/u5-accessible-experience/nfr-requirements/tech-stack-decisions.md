# Tech Stack Decisions - u5-accessible-experience

## Decisions

| ID | Decision | Rationale and verification |
|---|---|---|
| NFR5.1 | React 19 と TypeScript 5 を既存 `apps/beer-game` の UI 基盤として使い、native HTML の semantics を優先する。 | 既存 package と整合し、role ごとの form、状態通知、focus 管理を component test で検証できる。 |
| NFR5.2 | WCAG 2.2 AA を主要 flow の受入基準とする。通常文字 4.5:1、large text と UI component 3:1、focus indicator 3 px / 3:1、target size 原則 24 × 24 CSS px、200% zoom reflow を検査する。 | automated accessibility check と keyboard-only、200% zoom、forced colors、reduced motion の手動確認を併用する。 |
| NFR5.3 | 動的な通常更新は polite live region、権限・保存失敗は alert とし、自動更新の停止と手動更新を全対象画面に用意する。chart と同値 table を同時表示する。 | screen reader で通知回数、焦点、情報等価性を確認する。 |
| NFR6.2 | desktop の Chrome、Edge、Firefox、Safari 最新 2 世代で主要 flow の keyboard 操作を確認する。screen reader 手動受入は Windows NVDA + Chrome、macOS VoiceOver + Safari を必須とする。 | release 前の実 browser matrix。Playwright Chromium / Firefox / WebKit は自動回帰に用い、Safari 本体の手動確認を省略しない。 |
| NFR6.3 | 200% zoom の狭い viewport でも全操作を提供する。実際の狭い端末への案内は画面幅だけで操作を隠さない。 | desktop browser の 200% zoom と 1 column reflow の E2E / 手動確認。 |
| NFR8.1 | Vitest、React Testing Library、Playwright を既存 package の試験基盤として使い、主要 flow の Given/When/Then、keyboard、error recovery を実装前に定義する。 | CI で unit、integration、browser E2E、lint、typecheck を実行し、line coverage 80% 以上を確認する。 |
| NFR9.1 | U5 を同じ application の build / release に含め、`develop` で統合して `main` merge 後の staging と production 手動承認経路で検証する。 | branch / deployment pipeline と release 証跡を確認する。 |

## Compatibility and Accessibility Matrix

| 対象 | 自動確認 | 手動確認 |
|---|---|---|
| Chrome、Edge、Firefox、Safari 最新 2 世代 | 対応 engine の Playwright E2E、semantic / contrast checks | 全対象で主要 flow の keyboard 操作 |
| Windows NVDA + Chrome | automated check は補助 | 作成、参加、週次入力、週確定、復帰、振り返り、export、削除状態の主要 flow |
| macOS VoiceOver + Safari | automated check は補助 | 同じ主要 flow と chart / table 等価性 |

## Sources

- `inception/requirements-analysis/requirements.md` NFR5、NFR6、NFR8、NFR9
- `inception/refined-mockups/accessibility-checklist.md`
- `construction/u5-accessible-experience/functional-design/functional-spec.md`
- `construction/u1-walking-skeleton/nfr-requirements/tech-stack-decisions.md`
- `nfr-requirements-questions.md` Q1
- `apps/beer-game/package.json`

## Assumptions & Open Questions

- Playwright の WebKit は Safari 本体と同一の検証結果とは扱いません。各 browser の「最新 2 世代」は release 時点で確定し、検証した version を証跡に残します。
- NFR2 の server transaction / data durability は U1〜U4 が所有します。U5 は成功・失敗・再試行状態を正確に表示し、未保存 draft を維持します。
