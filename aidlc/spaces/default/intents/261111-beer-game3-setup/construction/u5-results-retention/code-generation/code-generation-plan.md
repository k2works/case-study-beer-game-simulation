# コード生成計画 - U5 u5-results-retention

## Summary

- Builds: 終了後の結果の比較表示と CSV・JSON の出力、放置されたゲームの自動終了、保持期間を過ぎたゲームの削除（定期処理）
- Touches: `apps/beer-game3/src/server/`（reporting、retention、access、http、session、config、main）、`migrations/`、`src/web/`（結果画面、出力パネル、導線）、`tests/u5/`、設計文書（`contract-summary.md`、U1・U3 の規則）
- Tests: 受入条件 10 件の振る舞い（Given/When/Then）を先に定義し、単体・結合（PostgreSQL）・画面の試験を約 70 件。BDD の順（シナリオ → 失敗の確認 → 実装 → 緑 → リファクタリング）

出典: `functional-spec.md`、`rules.md`（BR21〜BR26）、`entities.md`、`performance-design.md`、`security-design.md`、`scalability-design.md`、`reliability-design.md`、`observability-design.md`、`logical-components.md`、`contract-summary.md`（C1、C3、C5）。

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
      "text": "- 実装後のテスト追加や低レベルの TDD のみではなく、業務ルールを Given/When/Then で先に固定する BDD を採用した。週次計算、冪等性、役割別認可を実行可能な振る舞いとして追跡するためである。 (learned 2026-10-27) \n\n- 共通の土台（保存の型、セッションの層）を作り替えるスライドの後続は、振る舞いの試験より先に実装を書くと失敗を確かめられない。土台を変える最初のスライドで、後続の振る舞いの試験も先に書いて失敗を確かめてから実装する。順序を守れなかったときは、規則を壊すと試験が落ちることを個別に確かめて code-summary に記録する。 (learned 2026-11-12)"
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
  "input_sha256": "sha256:5df8522b767bc3fef469d1ca778c766ee86edc757c1170cd962a655aa222f05e",
  "contract_sha256": "sha256:7ed7f6fa151431d2bddc00d40ba7409940bf767d5b5c142b673801267fbe4b51"
}
```

## 進め方

BDD の順で、観察できる機能のスライドごとに「Given/When/Then のシナリオと失敗する試験 → 失敗の確認 → 最小の実装 → 緑 → リファクタリング」を回す。スライド A は共通の土台（保存の型と書き込みの入口）を作り替えるため、プロジェクトの規則（Testing Posture）に従い、後続のスライド B〜E の振る舞いの試験も、スライド A の中で先に書いて失敗を確かめてから実装する。試験の場所は `tests/u5/`。実行コマンドは `unit-test-instructions.md`。

## 実装の計画

- [x] Step 1: 構成の確認と試験の準備。`tests/u5/{features,unit,integration,web,support}` を作る。`package.json` の `test`、`test:unit`、`test:integration`、`test:web`、`test:coverage` に `tests/u5` を足す。`vitest.config.ts` の閾値は変えない。`tests/u5/support/harness.ts`（ゲームの作成、4 役割の参加、N 週の確定、終了、時計の差し替え）を U4 の補助に倣って作る。U5 のコマンドで空の実行が通ることを確かめる（AC のすべて）
- [x] Step 2: スライド A の振る舞いの試験を先に書く（赤）。A の試験: 状態を変える各操作の後に `lastOperationAt` が進み、閲覧・再送・拒否では進まない（BR25.2）、表示名が `=`、`+`、`-`、`@`、先頭に空白のあとの `=` で始まる参加と入れ替えが 422（BR23.10）、既存の表示名は変わらない。あわせて、スライド B〜E の振る舞いの試験（Given/When/Then）を先に書き、失敗を確かめる。B: 期限の境界（直前・ちょうど・直後）での自動終了と削除、削除後の 403、削除の原子性。C: 終了前の結果の拒否、観察者・無資格・別のゲームの同一の 403、確定済みの週だけ。D: CSV と JSON の一致、カンマと改行と先頭が `=` の表示名の読み戻し、権限。E: 画面の切り替えと表と注意（US4.1: AC4.1.1〜AC4.1.4、US4.2: AC4.2.1〜AC4.2.3、US5.1: AC5.1.1〜AC5.1.3）。失敗（赤）の出力を code-summary に記録する
- [x] Step 3: スライド A の実装（データ）。移行 `1763200000000_u5-results-retention.sql`（`games.last_operation_at` を `not null default now()` で追加、補完の更新、部分索引 2 つ）と Down を書く。`GameRow` に `lastOperationAt` を足し、`createGame` が `createdAt` と同じ値を入れる（メモリ上の保存と PostgreSQL の保存の両方）。`GameTx` に `mutated` の印と `touchOperation(at)` を足し、`GameSession.write` が印が立っていればコミットの前に 1 回更新する（NFR2.5、BR25.2）
- [x] Step 4: スライド A の実装（入力）。`session/schemas.ts` の表示名の検証を 1 つのスキーマ `displayName` に集約し、`joinSchema` と `replacementSchema` が同じものを使う。正規化後の先頭が `=`、`+`、`-`、`@`、タブ、復帰のものを 422 で拒否する（BR23.10、NFR6.8）。画面の入力欄の近くに制限の説明を示す。U1・U3 の設計文書（表示名の規則）を直す
- [x] Step 5: スライド A の確認とリファクタリング。A の試験を緑にする。U1〜U4 の既存の試験が緑のままであることを確かめる。重複を整理する
- [x] Step 6: スライド B（保持と自動終了）の実装（保存）。`Store` に `findStaleGames(before, limit, exclude)`、`findExpiredGames(before, limit, exclude)`、`runExclusive(key, fn)`、`GameTx.deleteGame()` を足す（メモリ上の保存と PostgreSQL の保存の両方）。PostgreSQL の `runExclusive` は専用の接続で `pg_try_advisory_lock` を取り、同じ接続で解放する（解放に失敗した接続は破棄する）。選ぶ問い合わせは部分索引を使う述語（`status <> 'ended'` と `last_operation_at <= $1`、`status = 'ended'` と `ended_at <= $1`）にし、除外は `game_id <> all($n::uuid[])`
- [x] Step 7: スライド B の実装（業務）。`GameSession.autoEnd(gameId, staleBefore)` に占有の中の再検査と結果（`ended`、`not-stale`、`already-ended`、`not-found`）を足す。`GameSession.deleteIfExpired(gameId, expiredBefore)` を足す（結果は `deleted`、`not-expired`、`not-found`）。`retention/policy.ts`（`RetentionPolicy`、`loadRetentionPolicy`、`isExpired`、`isStale`）、`retention/failure-memory.ts`、`retention/job.ts`（`runOnce(now)`: ロック、自動終了、削除、結果のログ）、`retention/scheduler.ts`（起動時に待たずに 1 回、周期、連続の失敗の回数、停止で最大 10 秒待つ）を作る
- [x] Step 8: スライド B の実装（設定と起動）。`config.ts` に `RETENTION_DAYS`、`AUTO_END_DAYS`、`RETENTION_JOB_INTERVAL_MINUTES`、`RETENTION_BATCH_LIMIT` を範囲つきで足す。起動時に有効な設定値のログと、既定より短いときの警告を出す。`main.ts` が `listen` のあとにスケジューラを始め、停止でタイマー、HTTP、接続プールの順に閉じる。`.env.example` と README を直す。入口のモジュールは Retention を import しない
- [x] Step 9: スライド B の確認とリファクタリング。B の試験（振る舞い、単体、PostgreSQL の結合: 連鎖削除、原子性、二重実行の防止、再検査、除外、先頭詰まり）を緑にする。構造の試験（`games` を参照する外部キーの連鎖）を足す
- [x] Step 10: スライド C（結果）の実装。`reporting/results.ts`（`buildResultsView`）、`Reporting.results(gameId)`（`readSnapshot` を 1 回呼び、見つからなければ存在しないゲームと同じ 403）。`AccessControl.requireResultsViewer`（参加者と進行役。観察者・無資格・別のゲーム・削除済みは同一の 403）。経路の表に `viewResults`（`GET /api/games/:gameId/results`）を足し、終了前は 403（理由は「ゲームが終了するまで、結果は見られません」）。応答に `Cache-Control: no-store`。取得のログ。API の型を `web/api.ts` に足す
- [x] Step 11: スライド D（出力）の実装。`reporting/export.ts`（`buildExportRecords`）、`reporting/csv.ts`（`renderCsv`: BOM、CRLF、RFC 4180 の引用、値は変えない）、`renderJson`。`AccessControl` の進行役の認可、経路の表に `exportGame`（`GET /api/games/:gameId/export?format=`）を足す。進行役でも終了前は 409、`format` の不正は 422、応答ヘッダ（`Content-Disposition`、`Cache-Control`、`X-Content-Type-Options`）。読み戻しの試験の補助を `tests/u5/support/csv-reader.ts` に置く（本番の依存に足さない）
- [x] Step 12: スライド C・D の確認とリファクタリング。経路の網羅試験（U4 の表）に 2 行を足し、資格情報の種類 × ゲームの状態を確かめる。結果と出力の許可リスト方式の型の走査（コード・token の値が含まれない）、CSV と JSON の一致、50 週のゲームの応答時間の記録を緑にする
- [x] Step 13: スライド E（画面）の実装。`ResultsScreen`（指標と費用の切り替えのラジオ、SVG のグラフ: 線種・印・凡例、表の併記、チームの累積費用）、`ExportPanel`（CSV・JSON のボタン、注意、列名と役割の説明。ヘッダ付きの取得 → Blob → ダウンロード）、終了後だけ出る「結果を見る」の導線（参加者の画面と進行役のボード）、`formatCents`、日本語の文言の一覧。`data-testid` を操作できる要素に付ける
- [ ] Step 14: スライド E の確認とリファクタリング。画面の試験（キーボード操作、系列の区別、表と同じ数値、注意と説明の同時表示、導線、表示名の拒否の表示）を緑にする。ブラウザで実際に開いて確かめる（開発用データベースへの移行 `npm run migrate` を適用してから。開発サーバーは止めない）
- [x] Step 15: 環境と構成。`npm run verify`（型検査、lint、整形の検査、カバレッジつきの全試験）を通す。カバレッジの閾値は下げない。`.prettierignore`、`tsconfig` に影響がないことを確かめる
- [x] Step 16: 設計文書と追跡。`contract-summary.md` の C1（results と export の応答と 409・422）と C5（`autoEnd` と `deleteIfExpired` の引数と結果、`query` の上限と除外）を直す。`functional-spec.md` と U1・U3 の規則に、実装で決まった差を反映する。`code-summary.md`、`traceability.json`、`source-manifest.json` を書く。スライド A の順序の逸脱があれば、その確認の結果を `code-summary.md` に記録する

## ストーリーと計画の対応

| ストーリー | 計画の Step |
| :--- | :--- |
| US4.1 終了後に全役割の時系列を比較する | Step 2、10、12、13、14 |
| US4.2 進行役が結果を CSV と JSON で出力する | Step 2、4、11、12、13 |
| US5.1 運営者が保持期間を設定し、期限後にデータが削除される | Step 2、3、6、7、8、9 |
