# Code Generation Plan - u1-walking-skeleton

## Summary

- Builds: 1 game / 4 shared roles / 1 week の end-to-end walking skeleton
- Touches: `apps/beer-game/`、database migration、tests、container / Terraform / CI configuration
- Tests: 約 45 tests（unit、integration、Playwright E2E、security / accessibility / performance smoke）

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

## Implementation Steps

- [x] **Step 1 — Workspace and test runner** (`US1.1`–`US2.3`): create the TypeScript workspace under `apps/beer-game/`, React/Fastify packages, Vitest/Playwright configuration, PostgreSQL test container setup, and runnable `test:u1` / `verify:u1` scripts.
- [x] **Step 2 — Executable behavior scenarios first** (`US1.1`–`US2.3`): add failing Given/When/Then scenarios for create/join/shared-role assignment/start, role-safe reads, optimistic decision edits, explicit week commit, duplicate retry, rollback, and deterministic golden series.
- [x] **Step 3 — Domain and 12-step engine slice** (`US2.3`): implement value types, shared role membership, exact 12-step pipeline order, factory two-stage production, shipment/order propagation, integer-minor cost, and golden tests; refactor green.
- [ ] **Step 4 — PostgreSQL schema and repositories** (`US1.1`–`US2.3`): add migrations for games, participants/role memberships, sessions, decisions, week results, idempotency, monotonic event sequence, and outbox; add atomic repository integration tests and RPO-safe transaction boundaries.
- [x] **Step 5 — Application commands and contracts** (`US1.1`, `US1.2`, `US2.2`, `US2.3`): implement creation-request idempotency before game identity exists, join, assign-role, start-session, submit-decision, and commit-week inputs/outputs, authorization, errors, and compatibility tests; cover accepted Contract Review findings.
- [ ] **Step 6 — Fastify API and security boundary** (`US1.1`–`US2.3`): implement OpenAPI schemas, HttpOnly cookie sessions, CSRF/origin protection, RFC 9457 errors, correlation IDs, rate/size limits, role-safe serialization, SSE with version reconciliation, and integration/security tests.
- [ ] **Step 7 — Minimal React walking-skeleton UI** (`US1.1`–`US2.3`): implement facilitator create/lobby/start/commit and participant join/state/decision screens, keyboard/focus/error states, polling fallback, `data-testid`, and Playwright scenarios.
- [ ] **Step 8 — Outbox, observability, and correctness detection** (`US2.3`): implement durable ordered dispatcher, LISTEN/NOTIFY hint, retry/backoff, metrics/log/trace redaction, duplicate/missing-outbox invariant checks, and tests.
- [ ] **Step 9 — Build and deployment artifacts**: add Dockerfiles, local Compose for PostgreSQL, Terraform modules for ECS/RDS/S3/CloudFront/monitoring, and GitHub Actions validation/build/staging/production gates without embedding secrets.
- [ ] **Step 10 — Full U1 verification and refactor**: run unit, integration, E2E, accessibility, security and performance smoke tests; enforce 80% line coverage, formatter, linter, and type-check; refactor only while scenarios remain green.
- [ ] **Step 11 — Documentation and traceability**: document local setup, exact commands, API usage, migrations, failure recovery, and map source/tests to all U1 acceptance criteria.

## Sources

All declared U1 Functional, NFR, Infrastructure, Contract, Unit, and Requirements artifacts.

## Assumptions & Open Questions

- JSD preset values remain externally blocked; tests use an explicitly CUSTOM fixture until confirmed.
- Infrastructure review findings are implementation obligations: durable C3 event transport, explicit private-subnet egress, and executable blue-green conditions.
