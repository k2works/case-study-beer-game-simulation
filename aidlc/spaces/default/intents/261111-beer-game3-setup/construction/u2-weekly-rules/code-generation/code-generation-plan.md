# コード生成の計画 - U2 u2-weekly-rules

## Summary

- Builds: キット準拠とカスタムの判定、設定値の上限、確定の原子性と冪等性の強化、費用の 64 ビット化、50 週の golden test
- Touches: `apps/beer-game3/` の既存のコード（設定の検証、種別の判定、確定の処理、移行、試験）。新しいアプリは作らない
- Tests: 振る舞いの例と単体・結合の試験およそ 40 件。行カバレッジ 80% 以上

出典: U2 の `functional-spec.md`、`rules.md`（BR6.1〜BR8.3）、`entities.md`、U1 の実装（`apps/beer-game3/`）、`contract-summary.md`。

## 前提

- U1 のコードの上に足す。既存の試験（206 件）は緑のまま保つ。
- 検証コマンドは承認済みのもの（`npm run verify`）を使う。PostgreSQL は `beer-game3-pg`（ポート 55432）。
- 設計のレビューで残った点を、実装で次のように決めて `code-summary.md` に記録する。
  - BR7.1: 識別子が違う同時の確定は、再送の照合を識別子で行い、識別子が違う確定済みの週は 409 `state`（最終週も含む）。U1 の最終週の分岐は、この規則に合わせて直すか、残す場合は理由を書く。
  - BR6.2: U2 には「プリセットを選ぶ入力」を作らない。値の一致だけで判定する。実際のゲームは未提供の間、必ず「カスタム」になる。
  - BR8.2: 上限の設定での費用の見積りは、`rules.md` の記述より大きい（週次およそ 2 × 10 の 10 乗、累積およそ 5 × 10 の 11 乗）。結論（64 ビット、安全な整数の範囲）は同じ。試験は実際の最悪の場合で行う。
- 試験の方針は U1 と同じ（`unit-test-instructions.md`）。

## Testing Contract

```json
{
  "version": 1,
  "methodology": "bdd",
  "source": "team",
  "ordering": "Given/When/Then の振る舞い例と失敗する自動テストを実装前に定義し、最小実装で通した後に refactor します。",
  "scope": "feature",
  "test_strategy": "standard",
  "project_type": "brownfield",
  "applicable_notes": [
    {
      "layer": "org",
      "text": "We treat tests as a first-class deliverable in every Bolt. The specific\nmethodology (TDD, BDD, ATDD, or classic test-after) is affirmed at\npractices-discovery and recorded in `team.md` under this heading with explicit\n`Methodology` and `Ordering` fields; Code Generation resolves those fields\nindependently from coverage, tooling, and scope notes.\n\nWhen no posture has been affirmed, our default per scope is:\n- **Methodology**: test-after\n- **Ordering**: implement each applicable testable layer, then write and run\n  that layer's tests.\n- `mvp`, `enterprise`, `feature`, `infra`, `classic` add an 80% line-coverage\n  floor and CI execution before merge.\n- `bugfix`, `security-patch` add a targeted regression for the specific\n  bug/vulnerability and require the existing suite to remain green.\n- `express` uses the Minimal strategy: requirement-driven unit tests (one per\n  requirement, with a happy-path floor per component); existing tests remain\n  green.\n- `poc`, `refactor`, `workshop` add no extra new-test floor and require the\n  existing suite to remain green.\n\nThe active `Test Strategy` still applies in every scope and determines test\nvolume/types. Scope floors are additive; they never reduce or replace the\nselected strategy.\n\nBuild and Test verifies defined coverage floors and affirmed quality targets;\nthey may not be weakened to make a step pass.\n\nAffirm a stricter posture in `team.md` if the team commits to one."
    },
    {
      "layer": "team",
      "text": "- **Methodology**: bdd\n- **Methodology evidence**: 週次計算、週確定の冪等性、役割別認可、復元について、利用者から見える振る舞いを Given/When/Then で先に定義する方針を team が選択した。beer-game2 は受入条件との対応表を検査しており、BDD 運用の実績がある。\n- **Ordering**: Given/When/Then の振る舞い例と失敗する自動テストを実装前に定義し、最小実装で通した後に refactor します。\n- カバレッジは行 80% を基準（floor）とします。beer-game2 の lines・functions・statements 85、branches 75 のしきい値は引き継ぎません。\n- Unit Test と主要境界の Integration Test を CI で実行します。\n- 決定論的な週次計算には既知系列の golden test を用意し、冪等な週確定、役割別認可、復元を回帰テストで保護します。"
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
      "Meet an 80% line-coverage floor.",
      "Run the selected tests in CI before merge."
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
  "input_sha256": "sha256:eb0c4ce743f2b251c0858383299e19fb9d9049716e7627fc260fb80dce2f3e94",
  "contract_sha256": "sha256:1a3b6cc5e902795b12fbf268cd04d15b17fd8cf26ed6c9af8e6bdbe55d713d08"
}
```

## 実装の手順

- [x] Step 1: 骨組みの確認（既存の `apps/beer-game3/` の構成。新しい依存は足さない。足す場合は理由を記録して人の確認を求める）
- [x] Step 2: 試験の実行環境の確認（`npm run test:unit`、結合用の `DATABASE_URL`。U2 用の試験の場所 `tests/u2/` を足し、`npm run verify` が U1 と U2 の両方を対象にすること。カバレッジの閾値は下げない）
- [x] Step 3: 振る舞いの例（スライド A: 設定値の上限）。BR8.1、BR8.2。上限の内側・外側、上限ぎりぎりの設定での 50 週の確定
- [x] Step 4: スライド A の実装（作成の検証に上限、`week_records` の費用の 64 ビット化の移行、数値の変換の確認）。BR8.1、BR8.2
- [x] Step 5: 振る舞いの例（スライド B: キット準拠の判定）。AC1.6.1〜AC1.6.5。BR6.1〜BR6.5
- [x] Step 6: スライド B の実装（KitPreset の定義と判定の関数、作成のときの種別の決定、出力用に種別が残ること）。BR6.1〜BR6.5
- [x] Step 7: 振る舞いの例（スライド C: 確定の強化）。AC2.4.1〜AC2.4.3。BR7.1〜BR7.4（同時の確定、途中の失敗、二重送信、前週の欠損）
- [x] Step 8: スライド C の実装（BR7.1 の規則の一本化と U1 の最終週の分岐の調整、前週の記録の欠損を失敗にする）。BR7.1〜BR7.4
- [x] Step 9: 振る舞いの例（スライド D: 50 週の golden test）。AC5.2.1。BR8.3。期待値は実装とは別の計算で作り、ファイルに固定する
- [x] Step 10: スライド D の実装（既存の SimulationEngine で通す。通らなければ、期待値でなく実装の誤りとして直す）
- [x] Step 11: スライド A〜D の試験を通し、整える
- [x] Step 12: 実際の PostgreSQL での結合試験（同時の確定、途中の失敗の注入、上限ぎりぎりの設定、移行）
- [x] Step 13: 文書と追跡（`code-summary.md`、`traceability.json`、`unit-test-instructions.md`、`source-manifest.json`。U1 の `functional-spec.md` の `remainingWeeks` の誤りの訂正を含める）

## 追跡（ストーリーと手順）

| ストーリー | 手順 |
| :--- | :--- |
| US1.6 | Step 5、6 |
| US2.4 | Step 7、8、12 |
| US5.2 | Step 9、10 |
| （U1 の指摘）設定値の上限 | Step 3、4、12 |

## 試験の量（Standard）

- 部品ごとに 5〜8 件: 設定の検証と種別の判定、確定の保証、50 週の golden test。
- 結合の試験: 同時の確定、途中の失敗、上限ぎりぎりの設定、移行。
- 行カバレッジ 80% 以上を、検証コマンドで確かめる。
