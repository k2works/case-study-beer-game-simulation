# Code Generation Plan - U4 Retention Operations

## Summary

- Builds: 保持期限の設定、期限到達削除 Saga、owner 完了通知、証跡と運用状態 API。
- Touches: `apps/beer-game/src/retention/`、`src/api/app.ts`、`migrations/004_u4_retention.sql`、`infra/main.tf`、`tests/u4/`、`package.json`。
- Tests: U4 の scenario / unit 20〜30 件と PostgreSQL・HTTP・event 境界の integration test、80% line coverage。

## Scope and risks

U4 は US5.1 / AC5.1.1〜AC5.1.3 と FR8.1〜FR8.3 を実装します。既存 U1 / U2 / U3 の owner data は各 owner の公開境界から削除し、U4 からその table を直接削除しません。共有 C5 v1 に `attempt` がないため、C5 v2 の schema / channel / producer fixture を合わせて更新し、v1 completion は隔離します。NFR2.2 の「最大 5 回の再試行」を正本とし、初回 attempt 1 と retry attempt 2〜6 の計 6 回とします。先行 NFR Design の「total attempt 5 回」はこの計画で是正対象にします。

## Implementation steps

- [x] **Step 1 — Structure / runner readiness (US5.1):** `tests/u4/` と `src/retention/` を用意し、Vitest の unit-scoped command `npm --prefix apps/beer-game test -- --run tests/u4` が実行可能であることを確認する。`package.json` に `test:u4` と、U4 を含む coverage / verify task を追加する。
- [x] **Step 2 — Scenario first, policy (US5.1 / AC5.1.1):** 既定 90 日、明示期間、期限起点、operator 認可を Given/When/Then で失敗するテストにする。`RetentionPolicy`、validation、U1 の game creation 境界への設定受渡し、PostgreSQL migration / repository、status API を最小実装し、scenario を green にして refactor する。
- [x] **Step 3 — Scenario first, due deletion (US5.1 / AC5.1.2):** due scan、重複起動、active Saga 再利用、3 owner の outbox 作成を失敗する scenario にする。Saga / progress / outbox transaction、scheduler、C4 v2 envelope を実装し、scenario を green にして refactor する。
- [x] **Step 4 — Scenario first, owner completion (US5.1 / AC5.1.2〜AC5.1.3):** C5 重複、旧 attempt、unknown schema、partial completion、receipt 保存失敗を失敗する scenario にする。v2 completion consumer、event inbox、一意制約と current-attempt 条件更新、全 owner 完了 + receipt の atomic commit を実装し、scenario を green にして refactor する。v1 completion は quarantine し、状態更新しない。
- [x] **Step 5 — Scenario first, retry / failure (US5.1 / AC5.1.3):** 初回 + 最大 5 retry、backoff + jitter、permanent failure、手動 retry、再起動後復元、完了済み owner 非再削除を失敗する scenario にする。attempt ledger、next attempt schedule、FAILED 状態、operator retry API を実装し、scenario を green にして refactor する。
- [x] **Step 6 — Scenario first, retention privacy (US5.1 / AC5.1.2〜AC5.1.3):** receipt の PII 排除、HMAC game reference、1 年 expiry、restore gate 中の読取拒否、expiry sweep を失敗する scenario にする。receipt store、cleanup worker、復旧時 read gate を実装し、scenario を green にして refactor する。
- [ ] **Step 7 — Contract and integration tests (US5.1):** C4 / C5 の provider / consumer fixture、v1 quarantine、v2 rollout、PostgreSQL transaction、SQS duplicate / out-of-order、Fastify operator IDOR、alert delivery を境界 test で検証する。実際の PostgreSQL と queue adapter を test 環境で動かし、外部 AWS 呼出は contract adapter で隔離する。
- [ ] **Step 8 — IaC and delivery (US5.1):** `infra/main.tf` に owner queue / DLQ、completion v2 / quarantine queue、EventBridge、ECS worker、KMS / IAM / CloudWatch を追加する。環境変数は non-secret のみとし、secret は Secrets Manager。Terraform validation と policy test を実行する。
- [ ] **Step 9 — Verification and documentation (US5.1):** U4 scoped tests、全既存 suite、format、lint、type-check、coverage floor、staging 相当の migration / restart / restore rehearsal を確認する。C5 v2 contract の移行手順、operator runbook、source manifest、code summary、traceability を記録する。

## Test files and configuration

`tests/u4/retention-policy.test.ts`、`deletion-saga.test.ts`、`completion-consumer.test.ts`、`retry.test.ts`、`receipt.test.ts`、`retention-api.integration.test.ts`、`retention-persistence.integration.test.ts`、`deletion-contract.integration.test.ts` を作成します。既存 `vitest.config.ts` を U4 の scoped run と coverage が正しく測れるよう必要最小限で更新します。各 component に 5〜8 件を目安とし、境界の主要な失敗経路を追加します。

## Blast radius and rollback

既存 `src/api/app.ts`、`src/application/game-service.ts`、`package.json`、`infra/main.tf`、PostgreSQL schema、U1 / U2 / U3 owner adapter が変更候補です。API / persistence / event contract を跨ぐため影響は高です。migration は expand-first とし、旧 image を動かせる schema の間だけ rollback します。v2 Saga 開始後に v1 producer へ戻すことは避け、queue と durable state を保持して修復します。

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

- `functional-design/functional-spec.md`、`rules.md`、`entities.md`
- `nfr-design/performance-design.md`、`security-design.md`、`reliability-design.md`
- `infrastructure-design/infrastructure-specification.md`、`cicd-pipeline.md`
- `inception/contract-design/contract-summary.md`

## Assumptions & Open Questions

- shared C5 v2 contract は実装に先立ち正式に更新し、全 owner Unit の fixture と rollout を一致させる必要があります。
