# コード生成の計画 - U3 u3-facilitation

## Summary

- Builds: 一時停止・再開・終了、担当者の入れ替え、代理入力、共同担当の置き換わりの表示、同名の区別、進行管理、操作の履歴（7 種類）
- Touches: `apps/beer-game3/` の既存のコード（セッション、保存、アクセス制御、API、進行管理と役割別プレイの画面、移行、試験）。新しいアプリや新しい依存は足さない
- Tests: 振る舞いの例と単体・結合・画面の試験およそ 80 件。行カバレッジ 80% 以上（閾値は下げない）

出典: U3 の `functional-spec.md`、`rules.md`（BR9.1〜BR14.3）、`entities.md`、NFR の要件と設計（`nfr-requirements/`、`nfr-design/`）、`contract-summary.md`（C1、C3、C5）、U1・U2 の実装（`apps/beer-game3/`）。

## 前提

- U1・U2 のコードの上に足す。既存の試験（272 件）は緑のまま保つ。
- 検証コマンドは承認済みのもの（`npm run verify`）を使う。PostgreSQL は `beer-game3-pg`（ポート 55432）。
- 設計の決定: 準備中の終了は進行役ができない（BR9.4）。入れ替えは識別子を使わない（BR10.6）。履歴の連番は `games.next_log_sequence`（NFR Design の Q1）。履歴は追記専用で、データベースの権限は変えない（Q2）。
- 設計のレビューで残った点は、実装で次のように決めて `code-summary.md` に記録する。
  - 失効した旧 token が、以前に成功した識別子の入力を再送した場合: 認可が先（NFR6.3 の判定の順の前段）なので、403 にする。前回の結果は返さない。
  - 契約（`contract-summary.md` の C1）の更新: `PUT assignments` は進行中と一時停止中は 409 `state` にする。`/end` は準備中を 409 にする。実装と同じ変更の中で C1 の該当記述を直す。
  - U1 の `entities.md` の「終了時は weekCount のまま」は、finalWeek の場合に限る、に直す。
- 試験の方針は U1・U2 と同じ（`unit-test-instructions.md`）。

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

各スライドは、振る舞いの例（Given/When/Then）と失敗する試験を先に書き、失敗を確かめてから、データ・保存・業務・API・画面の各層を足して通し、整える。

- [x] Step 1: 骨組みの確認（既存の `apps/beer-game3/` の構成。新しい依存は足さない。足す場合は理由を記録して人の確認を求める）
- [x] Step 2: 試験の実行環境の確認（`tests/u3/` を足し、`npm run verify` と `test*` の各スクリプトが U1・U2・U3 を対象にすること。カバレッジの閾値は下げない）
- [x] Step 3: 振る舞いの例（スライド A: 履歴の土台と取得）。BR13.1〜BR13.6、BR9.7 の履歴。作成の設定（setting）、準備中の割当て（assign、reassign）、週の確定（weekConfirm）が履歴に残る。連番、追記専用、進行役だけの取得、資格情報が含まれない
- [x] Step 4: スライド A の実装（移行 `operation_log_entries`、`games.end_reason`、`games.next_log_sequence`、既存の ended の行への finalWeek の補完。保存の関数に履歴を必須にする `appendLog`。履歴の取得 API と進行役の認可。メモリ上の保存と PostgreSQL の保存の両方）
- [x] Step 5: 振る舞いの例（スライド B: 一時停止・再開・終了）。AC2.5.1〜AC2.5.4。BR9.1〜BR9.8（状態の組み合わせ、終了の冪等、準備中の終了、最終週の自動終了と進行役の終了の競合）
- [x] Step 6: スライド B の実装（`status` に paused、遷移の表の検査、`end_reason`、終了の reason の固定、一時停止中の入力・確定の拒否、識別子の照合を状態の検査より先に、API の pause・resume・end）
- [x] Step 7: 振る舞いの例（スライド C: 担当者の入れ替え）。AC2.6.1〜AC2.6.3。BR10.1〜BR10.6、NFR6.3（旧担当者の入力との競合、再送）
- [x] Step 8: スライド C の実装（入れ替えの API とトランザクション、旧 token の失効、占有の中での入力者の再検査、`PUT assignments` の進行中・一時停止中の 409、`Cache-Control: no-store`）
- [x] Step 9: 振る舞いの例（スライド D: 代理入力、共同担当、同名の区別）。AC2.7.1、AC2.2.1、AC2.2.2、AC2.3.1。BR11.1〜BR11.4、BR12.1〜BR12.4
- [x] Step 10: スライド D の実装（`week_records` の入力した主体と revision、進行役用コードによる入力の代理扱い、履歴 proxyInput、参加者の投影に入力者のラベルと revision、ラベル「表示名 #参加順」）
- [x] Step 11: 振る舞いの例（スライド E: 進行管理）。AC2.8.1、AC2.8.2。BR14.1〜BR14.3。進行役の投影は入力値を含まず、入力済みの真偽と現在の状態を返す
- [x] Step 12: スライド E の実装（進行役の投影の型、`REPEATABLE READ` の読み取り専用のトランザクション、画面: 進行管理 `FacilitatorBoard`、役割別プレイの置き換わりの通知と一時停止中の表示。`data-testid` を足す）
- [x] Step 13: スライド A〜E の試験を通し、整える（重複の除去、命名、移行の逆の手順の確認）
- [x] Step 14: 実際の PostgreSQL での結合試験（操作と履歴の原子性、入れ替えの途中の失敗、最終週の確定と終了の競合、入れ替えと旧担当者の入力の競合、投影の一貫性、連番、移行と逆の移行）
- [x] Step 15: 非機能の自動試験（履歴 1,000 件の取得と大きさ、ログに資格情報がないこと、`UPDATE`・`DELETE` の文がないことの静的な検査、reason を外部から指定できないこと）
- [x] Step 16: 文書と追跡（`code-summary.md`、`traceability.json`、`unit-test-instructions.md`、`source-manifest.json`。`contract-summary.md` の C1 の更新、U1 の `entities.md` の終了時の制約の訂正）

## 追跡（ストーリーと手順）

| ストーリー | 手順 |
| :--- | :--- |
| US5.6 | Step 3、4、14、15 |
| US2.5 | Step 5、6、14 |
| US2.6 | Step 7、8、14 |
| US2.7 | Step 9、10 |
| US2.2 | Step 9、10 |
| US2.3 | Step 9、10 |
| US2.8 | Step 11、12、14 |

## 試験の量（Standard）

- 部品ごとに 5〜8 件: 履歴、状態遷移、入れ替え、代理入力と共同担当、進行管理、画面。
- 結合の試験: 原子性、競合、投影の一貫性、移行。
- 行カバレッジ 80% 以上を、検証コマンドで確かめる。
