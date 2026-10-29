# Code Generation Plan - U3 Learning View

## Summary

- Builds: privacy-safe observation、ended-game review、versioned CSV/JSON export の projection module
- Touches: `apps/beer-game/src/`、migration、U3 tests、API routes、deployment/IaC configuration
- Tests: component ごと 5〜8 件の unit tests、C3/C6 integration tests、export/security/fault scenarios

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
## Steps

- [ ] Step 1 — 既存 runner と `npm --prefix apps/beer-game test -- --run tests/u3` を確認する。
- [ ] Step 2 — US4.1〜US4.3 の Given/When/Then を `tests/u3/learning-view.test.ts`、contract/fault scenarios を `tests/u3/learning-view.integration.test.ts` に先行追加する。
- [ ] Step 3 — PostgreSQL projection、processed-event、cursor、export metadata migration と repository port/adapter を実装する。
- [ ] Step 4 — C3 validator、session ordering/idempotency、gap/rebuild coordinator、privacy disclosure policy を実装する。
- [ ] Step 5 — C6 observation/review/export create/status/download routes と fresh authorization を実装する。
- [ ] Step 6 — canonical dataset から streaming CSV/JSON、schema/checksum/equality validation、partial cleanup を実装する。
- [ ] Step 7 — scenarios を green にし、既存 U1/U2 suite と 80% coverage を維持して refactor する。
- [ ] Step 8 — telemetry、queue/export configuration、migration/IaC assertions、API contract fixture を追加する。
- [ ] Step 9 — `code-summary.md`、`traceability.json`、`source-manifest.json` を作成する。

## Story traceability

| Story | Steps |
|---|---|
| US4.1 | 2, 4, 5, 7 |
| US4.2 | 2, 3, 4, 5, 7 |
| US4.3 | 2, 3, 5, 6, 7, 8 |
