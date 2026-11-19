# コード生成の計画 - U1 u1-walking-skeleton

## Summary

- Builds: 薄い一通り（ゲームの作成、参加、役割割当てと開始、入力、週の確定、役割別の状態表示）。最初の動くコード
- Touches: 新しい `apps/beer-game3/`（サーバー、画面、DB の移行、試験、設定）。既存のコードは触らない
- Tests: 振る舞いの例（Given/When/Then）と単体・結合の試験およそ 60 件。行カバレッジ 80% 以上

出典: `functional-spec.md`、`rules.md`（BR1.1〜BR5.11）、`entities.md`、`contract-summary.md`、`performance-design.md`、`security-design.md`、`scalability-design.md`、`reliability-design.md`、`observability-design.md`、`tech-stack-decisions.md`、`unit-of-work.md`。

## 前提

- アプリケーションは `apps/beer-game3/` に新しく作る。beer-game2 のコードは複製しない（設計の参考のみ）。
- 技術は `tech-stack-decisions.md` に従う（Node.js 26、TypeScript strict、Fastify、PostgreSQL 18、node-pg-migrate、zod、React と Vite、Vitest、ESLint、Prettier）。版は実装の時点で公式情報で確かめて固定する。
- CI の設定と staging の自動デプロイは、この Unit では作らない（Functional Design の Q3 の A）。手元で動く検証コマンドまでを作る。
- 前のレビューで残った点（バージョンの更新の扱い、接続元のログ、鍵の識別子の保存先など）は、実装の段階で設計に沿って決め、`code-summary.md` に記録する。契約が変わる場合は `contract-summary.md` を同時に直す。
- 試験は、DB を使わない単体・振る舞いの試験（メモリ上のリポジトリ）と、実際の PostgreSQL を使う結合の試験に分ける。結合の試験は環境変数 `DATABASE_URL` の PostgreSQL に接続し、無いときは失敗として扱う（飛ばさない）。

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

方法は BDD です。観察できる機能の薄片ごとに、振る舞いの例と失敗する試験を先に書き、最小の実装で通してから整えます。

- [x] Step 1: プロジェクトの骨組みと本番の設定（`apps/beer-game3/` の `package.json`、`tsconfig.json`、ESM、ESLint、Prettier、`.nvmrc`、環境変数の読み込み。鍵と接続先は環境変数から渡す）。BR1.8、NFR6.3 の準備
- [x] Step 2: 試験の実行環境の確認（Vitest の設定、カバレッジ 80% の閾値、`unit-test-instructions.md` の単体用コマンドが実行できること。`DATABASE_URL` の PostgreSQL への接続の確認）
- [x] Step 3: 振る舞いの例（スライド A: 週の計算）。AC1.5.3、AC1.5.4、AC1.5.5、AC1.5.6、AC1.5.7、AC1.5.9 を Given/When/Then の試験にする。BR5.3〜BR5.6、BR5.8
- [x] Step 4: スライド A の実装（SimulationEngine: 純粋な週の計算、枠の前進、整数の費用）。BR5.3、BR5.4、BR5.5、BR5.6、BR5.8、NFR1.1、NFR1.2
- [x] Step 5: スライド A の試験を通し、整える
- [x] Step 6: 振る舞いの例（スライド B: ゲームの作成とコード）。AC1.1.1〜AC1.1.5。BR1.1〜BR1.8
- [x] Step 7: スライド B の実装（DB の移行 `games`、`game_settings`、`demand_series`、`access_codes`。GameSession の作成、検証、AccessControl のコード発行。鍵付きハッシュと暗号化）。BR1.1〜BR1.8、NFR6.1、NFR6.3、NFR6.11
- [x] Step 8: 振る舞いの例（スライド C: 参加と token）。AC1.2.1〜AC1.2.4、AC1.4.1 の前提。BR2.1〜BR2.6
- [x] Step 9: スライド C の実装（`participants`、`return_tokens`。参加、表示名の検証、token の発行と照合）。BR2.1〜BR2.6、NFR6.9
- [x] Step 10: 振る舞いの例（スライド D: 割当てと開始）。AC1.3.1〜AC1.3.3。BR3.1〜BR3.3
- [x] Step 11: スライド D の実装（`role_assignments`、`pipeline_slots`、`week_records`。割当て、定員、開始と初期状態の固定）。BR3.1〜BR3.3
- [x] Step 12: 振る舞いの例（スライド E: 入力と役割別の見せ方）。AC1.4.1〜AC1.4.4。BR4.1〜BR4.5、BR4.8
- [x] Step 13: スライド E の実装（入力の保存と上書き、役割別の投影、他役割の拒否、判定の順）。BR4.1〜BR4.5、BR4.8、NFR6.2、NFR6.5
- [x] Step 14: 振る舞いの例（スライド F: 週の確定と再送）。AC1.5.1、AC1.5.2、AC1.5.8、再送と事前条件。BR5.1、BR5.2、BR5.7、BR5.9〜BR5.11、BR4.6、BR4.7
- [x] Step 15: スライド F の実装（`idempotency_records`。ゲーム単位の行の占有、1 トランザクションでの確定、版の検査、最終週での終了）。BR4.6、BR4.7、BR5.1、BR5.2、BR5.7、BR5.9、BR5.10、BR5.11、NFR2.1〜NFR2.3、NFR3.7
- [x] Step 16: スライド B〜F の試験を通し、整える（重複の削除、名前、エラー形式 `Problem` の統一）
- [x] Step 17: API の層（Fastify。`contract-summary.md` の C1 に沿った入口、共通のエラー形式、要求の識別子、構造化ログ、ヘルスチェック、セキュリティヘッダ）。NFR3.5、NFR3.6、NFR6.4、NFR6.6、NFR6.10
- [x] Step 18: 画面の振る舞いの例と実装（React。S0 参加入口、S1 ゲーム作成、S2 ロビー、S3 役割別プレイ。日本語。1 秒おきの取り直し。キーボード操作、`data-testid`）。AC1.1.1〜AC1.5.2 の画面側、NFR3.4、NFR6.10
- [x] Step 19: 薄い一通りの結合試験（作成 → 4 人の参加 → 割当て → 開始 → 4 役割の入力 → 確定 → 状態の表示を、実際の PostgreSQL で通す）
- [x] Step 20: 環境とビルドの設定（`Dockerfile` の下書きは作らない。ビルドと起動のスクリプト、`.env.example`、移行の実行）
- [x] Step 21: 文書と追跡（`code-summary.md`、`traceability.json`、`unit-test-instructions.md` の最新化、`source-manifest.json`）

## 追跡（ストーリーと手順）

| ストーリー | 手順 |
| :--- | :--- |
| US1.1 | Step 6、7、17、18 |
| US1.2 | Step 8、9、17、18 |
| US1.3 | Step 10、11、17、18 |
| US1.4 | Step 12、13、17、18 |
| US1.5 | Step 3、4、5、14、15、17、18、19 |

## 試験の量（Standard）

- 部品ごとに 5〜8 件: SimulationEngine（週の計算）、GameSession（作成・参加・割当て・開始・入力・確定）、AccessControl（コード・token・投影）。
- 主要な境界の結合試験: API と GameSession、GameSession と PostgreSQL、薄い一通り。
- 既知系列の試験: AC1.5.3〜AC1.5.9 の数値。
- 行カバレッジ 80% 以上を、検証コマンドで確かめる。閾値は下げない。
