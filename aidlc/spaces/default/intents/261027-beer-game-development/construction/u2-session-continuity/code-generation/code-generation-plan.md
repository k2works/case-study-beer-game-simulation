# Code Generation Plan - U2 Session Continuity

## Summary

- Builds: session pause / resume / end、proxy decision、recovery token、restart recovery、multi-tab conflict handling
- Touches: `apps/beer-game/src/`、`apps/beer-game/migrations/`、`apps/beer-game/tests/u2/`、API / UI、Terraform と CI configuration
- Tests: 30〜40 tests（BDD scenarios、unit、PostgreSQL integration、API、security、E2E smoke）

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

## Implementation steps

- [x] Step 1: 既存 Vitest configuration と U1 regression suite を確認し、U2 scoped command を実行可能にする。（NFR8、U2）
- [x] Step 2: pause / resume / end、proxy input、recovery、stale multi-tab、restart の失敗する Given/When/Then scenario を `tests/u2/` に追加する。（US3.1、US3.2、AC3.1.1〜AC3.2.3）
- [ ] Step 3: RecoveryCredential、session lifecycle、audit、idempotency、outbox 用 PostgreSQL migration と repository contract test を追加する。（FR2.2、FR6.1〜FR6.4、NFR13）
- [x] Step 4: C2 owner interface を拡張し、GameSession aggregate から pause / resume / end / proxy decision を実装する。table の直接更新は行わない。（BR7、BR8、C2）
- [x] Step 5: 256-bit opaque recovery token、versioned HMAC digest、expiry / revocation / atomic rotation、uniform failure と rate limit を実装する。（BR9、NFR11）
- [x] Step 6: API endpoints、If-Match、Idempotency-Key、RFC 9457 response、role-safe state query と SSE reconciliation を実装する。（BR10、C1）
- [ ] Step 7: minimal UI に paused / ended / stale / recovered state、facilitator controls、BroadcastChannel 補助同期を追加する。（AC3.1.1、AC3.2.1、AC3.2.3）
- [ ] Step 8: outbox dispatcher の ordering / deduplication、restart restore、structured telemetry と redaction を実装する。（NFR12〜NFR14）
- [x] Step 9: scenario、unit tests を green にし、line coverage 80% 以上で refactor する。PostgreSQL integration、API security、E2E は未完了。
- [ ] Step 10: Terraform / CI を U2 の secrets、alarms、contract / security / migration checks に拡張し、README と API documentation を更新する。
- [x] Step 11: formatter、lint、type-check、unit-scoped tests、full regression、coverage を実行し、成果と traceability を記録する。E2E は未完了。

## Planned files

- `apps/beer-game/src/domain/` session lifecycle / credential types
- `apps/beer-game/src/application/` continuity service and C2 interface
- `apps/beer-game/src/infrastructure/` PostgreSQL repositories、outbox、rate limiter
- `apps/beer-game/src/api/app.ts` continuity endpoints
- `apps/beer-game/src/ui/App.tsx` continuity states and controls
- `apps/beer-game/migrations/002_u2_session_continuity.sql`
- `apps/beer-game/tests/u2/*.test.ts` and `apps/beer-game/tests/e2e/u2.spec.ts`
- `apps/beer-game/infra/` and `.github/workflows/beer-game-u1.yml`

