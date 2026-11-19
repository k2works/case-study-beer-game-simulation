# Code Generation Plan - U5 Accessible Experience

## Summary

- Builds: 11 story の browser UI、役割別の安全な表示、更新と復帰、振り返り・出力・保持状態の操作。
- Touches: `apps/beer-game/src/ui/`、`src/api/app.ts` と provider adapter、`tests/u5/`、`tests/e2e/u5.spec.ts`、`infra/main.tf`、共有契約。
- Tests: U5 の scenario / component 35〜50 件、主要 API 境界の integration と browser E2E、line coverage 80% 以上。

## Scope and contract prerequisites

U5 は US1.1〜US5.1 の 11 story と AC1.1.1〜AC5.1.3 の UI 受入を実装します。U2 の browser 操作、U4 の保持状態 / retry、SSE、U3 export の完了・download は共有契約に不足しています。実装前に U1〜U4 の provider と request / response、認可、version、idempotency、failure shape、再接続 / download を確定し、契約 fixture と negative test を置きます。SameSite=Strict + Origin / Referer 検査を全変更操作に統一し、U1 の CSRF token 前提を改訂します。契約が確定できない flow を推測実装で完了扱いにしません。

性能の受入は入力確定 end-to-end p95 1 秒、SSE 通常時の週確定後表示 p95 2 秒、polling fallback 4 秒です。75 user / 15 game の負荷と、clock 差に依存しない測定方法を実装前に定めます。アクセシビリティは WCAG 2.2 AA、NVDA + Chrome、VoiceOver + Safari、4 browser 最新 2 世代の keyboard 操作で確認します。

## Implementation steps

- [x] **Step 1 — Runner and configuration (all 11 stories):** 既存 `vitest.config.ts`、Playwright、React Testing Library を確認し、U5 の scoped command `npm --prefix apps/beer-game test -- --run tests/u5` を実行可能にする。`package.json` に `test:u5`、`e2e:u5` と coverage / verify 更新を計画する。runner が動くことを確かめてから scenario を書く。
- [x] **Step 2 — Provider contract scenarios (US1.1〜US5.1):** 共有契約の不足を U1〜U4 と整合させ、U2 操作、SSE / polling、U3 export、U4 status / retry、cookie / Origin の Given/When/Then と失敗する integration test を先に作る。edge の `Idempotency-Key`、`If-Match`、cookie、Origin、再接続 header、query、`Set-Cookie` 転送も test にする。provider contract と adapter を最小実装して green にし、refactor する。
- [x] **Step 3 — Create / join / lobby scenarios (US1.1、US1.2):** form validation、参加コード、役割割当て、復帰資格、error focus の失敗する scenario を先に作る。CreateGameForm、JoinAndRecovery、Lobby と role-safe API 接続を実装して green にし、refactor する。
- [x] **Step 4 — Weekly play / facilitator scenarios (US2.1〜US3.2):** 12 step、入力・競合・未保存値、週確定、停止・代理入力・再開・終了、SSE / polling / 手動更新の失敗する scenario を先に作る。PlayPage、RoleDecisionForm、FacilitatorConsole、LiveStateAdapter と確認 dialog を実装して green にし、refactor する。
- [x] **Step 5 — Observe / review / export scenarios (US4.1〜US4.3):** 抑止値が DOM にないこと、chart / table 等価性、CSV / JSON の生成・完了・失敗と download の失敗する scenario を先に作る。ObservationPage、ReviewPage、ExportPanel、LearningAdapter を実装して green にし、refactor する。
- [x] **Step 6 — Retention scenarios (US5.1):** operator 認可、保持期限、owner 進捗、FAILED、COMPLETED、手動 retry の失敗する scenario を先に作る。RetentionPage と RetentionAdapter を実装して green にし、refactor する。
- [x] **Step 7 — Accessibility and browser scenarios (all 11 stories):** skip link、heading / focus、field error、live region 重複抑止、dialog focus、200% zoom、forced colors、reduced motion、chart / table 同値性を失敗する scenario にして修正する。Playwright の browser matrix と NVDA / VoiceOver 手動確認手順を追加する。
- [ ] **Step 8 — Performance, edge and deployment (US2.1〜US5.1):** 同一観測 clock の synthetic 測定と 75 接続 / fallback 負荷試験を追加する。CloudFront / ALB の method、header、cookie、query、cache、SSE timeout を IaC に反映し、scale trigger と cost alert を決める。staging 相当の認証・再接続 smoke test を通す。
- [ ] **Step 9 — Verification and handoff (all 11 stories):** U5 scoped tests、既存 suite、format、lint、typecheck、80% line coverage、browser E2E、共有 contract test を確認する。`source-manifest.json`、`code-summary.md`、`traceability.json` を記録し、未達 SLO や実 browser 手動試験の結果を明示する。

## Test files and configuration

`tests/u5/` に `contracts.integration.test.ts`、`create-join.test.tsx`、`play-live.test.tsx`、`facilitator.test.tsx`、`review-export.test.tsx`、`retention.test.tsx`、`accessibility.test.tsx` を追加します。`tests/e2e/u5.spec.ts` は keyboard、SSE / polling、role isolation、200% zoom の主要 flow を含めます。各 component 5〜8 test を目安に、負荷と手動 screen reader は別証跡にします。`vitest.config.ts` と `playwright.config.ts` は必要な U5 scoped run に限って更新します。

## Blast radius and rollback

UI のほか、U1〜U4 provider、共有契約、CloudFront / ALB、CI が変更候補です。API と UI は versioned contract の互換 window を設けます。rollback は旧 UI asset prefix と既知良好 API image を一体で戻し、旧 asset が cache に残る間の接続を smoke test で保護します。schema / event を壊す変更は expand-first とします。

## Testing Contract

```json
{
  "version": 1,
  "methodology": "bdd",
  "source": "team",
  "ordering": "Given/When/Then の振る舞い例と失敗する自動テストを実装前に定義し、最小実装で通した後に refactor します。",
  "scope": "classic",
  "test_strategy": "standard",
  "project_type": "brownfield",
  "applicable_notes": [
    {
      "layer": "org",
      "text": "We treat tests as a first-class deliverable in every Bolt. The specific\nmethodology (TDD, BDD, ATDD, or classic test-after) is affirmed at\npractices-discovery and recorded in `team.md` under this heading with explicit\n`Methodology` and `Ordering` fields; Code Generation resolves those fields\nindependently from coverage, tooling, and scope notes.\n\nWhen no posture has been affirmed, our default per scope is:\n- **Methodology**: test-after\n- **Ordering**: implement each applicable testable layer, then write and run\n  that layer's tests.\n- `mvp`, `enterprise`, `feature`, `infra`, `classic` add an 80% line-coverage\n  floor and CI execution before merge.\n- `bugfix`, `security-patch` add a targeted regression for the specific\n  bug/vulnerability and require the existing suite to remain green.\n- `express` uses the Minimal strategy: requirement-driven unit tests (one per\n  requirement, with a happy-path floor per component); existing tests remain\n  green.\n- `poc`, `refactor`, `workshop` add no extra new-test floor and require the\n  existing suite to remain green.\n\nThe active `Test Strategy` still applies in every scope and determines test\nvolume/types. Scope floors are additive; they never reduce or replace the\nselected strategy.\n\nBuild and Test verifies defined coverage floors and affirmed quality targets;\nthey may not be weakened to make a step pass.\n\nAffirm a stricter posture in `team.md` if the team commits to one."
    },
    {
      "layer": "team",
      "text": "- **Methodology**: bdd\n- **Methodology evidence**: 週次計算、週確定の冪等性、役割別認可、復元について、利用者から見える振る舞いを Given/When/Then で先に定義する方針を team が選択しました。\n- **Ordering**: Given/When/Then の振る舞い例と失敗する自動テストを実装前に定義し、最小実装で通した後に refactor します。\n- classic scope の 80% line coverage floor を満たし、Unit Test と主要境界の Integration Test を CI で実行します。\n- 決定論的な週次計算には既知系列の golden test を用意し、冪等な週確定、役割別認可、復元を回帰テストで保護します。"
    },
    {
      "layer": "project",
      "text": "- 実装後のテスト追加や低レベルの TDD のみではなく、業務ルールを Given/When/Then で先に固定する BDD を採用した。週次計算、冪等性、役割別認可を実行可能な振る舞いとして追跡するためである。 (learned 2026-10-27)"
    }
  ],
  "obligations": {
    "strategy": "standard",
    "strategy_volume": [
      "Five to eight tests per component.",
      "Unit tests plus integration tests for key boundaries.",
      "Add E2E, performance, or security tests when requirements demand them."
    ],
    "scope_floor": [
      "Keep the existing test suite green.",
      "This scope adds no extra new-test floor beyond the selected test strategy."
    ],
    "combination_rule": "Apply every selected-strategy obligation and every scope-floor obligation; neither replaces the other, and a targeted scope regression may add the narrowest necessary test type beyond the strategy default."
  },
  "plan_profile": {
    "methodology": "bdd",
    "runner_step": "Verify the existing test runner/configuration and record the exact unit-scoped command.",
    "runner_ready_before_first_test": true,
    "testable_layers": [
      "Data model / database behavior",
      "Repository / data access",
      "Business logic",
      "API / endpoint",
      "Frontend behavior"
    ],
    "steps": [
      "Project structure and production configuration skeleton.",
      "Verify the existing test runner/configuration and record the exact unit-scoped command.",
      "Behavior scenarios - define executable examples for the observable feature slice before implementation.",
      "Feature slice - implement the required data, repository, business, API, and frontend layers.",
      "Behavior scenarios - run the scenarios until they pass.",
      "Feature slice - refactor while the scenarios stay green.",
      "Environment/build configuration.",
      "Documentation and traceability."
    ]
  },
  "input_sha256": "sha256:990b6aae0ed85b2f0e4cc4342024c58b9ecca531b403da599584823ed20752c8",
  "contract_sha256": "sha256:36b8d5673a42bb2bd1dccae624441a176a061cd510b06be5831d928d686f0bf2"
}
```

## Sources

- `construction/u5-accessible-experience/functional-design/functional-spec.md`
- `inception/contract-design/contract-summary.md`
- `construction/u5-accessible-experience/nfr-design/performance-design.md`、`security-design.md`
- `construction/u5-accessible-experience/infrastructure-design/infrastructure-specification.md`
- `inception/units-generation/unit-of-work.md`
- `inception/requirements-analysis/requirements.md`

## Assumptions & Open Questions

- 共有 browser 契約の provider 合意が未了です。Step 2 が完了するまで、それに依存する UI flow の完成を宣言しません。
