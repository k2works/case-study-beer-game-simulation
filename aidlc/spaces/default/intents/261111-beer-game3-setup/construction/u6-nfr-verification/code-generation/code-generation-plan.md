# コード生成計画 - U6 u6-nfr-verification

## Summary

- Builds: 非機能の検証の仕組み（負荷試験のスクリプト、実ブラウザの反映の測定、Playwright の画面の試験と axe-core の検査、色の比と日本語表示と CI 定義の検査）と、beer-game3 専用の CI（`.github/workflows/beer-game3.yml`）。新しい業務機能は足さない
- Touches: `apps/beer-game3/verification/`（新規。load、e2e、ci、shared）、`tests/u6/`、`package.json`、`tsconfig.json`、`eslint.config.js`、`.github/workflows/beer-game3.yml`、`docs/operation/`（リリース前の確認票）、設計文書（`cicd-pipeline.md` ほか）
- Tests: 受入条件 5 件（AC5.3.1、AC5.5.1、AC5.5.2、AC5.7.1、AC5.7.2）の振る舞い（Given/When/Then）を先に定義し、単体・結合（PostgreSQL）・実ブラウザの試験を約 80 件。BDD の順（シナリオ → 失敗の確認 → 実装 → 緑 → リファクタリング）

出典: `unit-of-work.md`（U6）、`stories.md`（US5.3、US5.5、US5.7）、`nfr-requirements/` の 5 文書と `tech-stack-decisions.md`、`nfr-design/` の 6 文書、`infrastructure-design/` の 3 文書、`contract-summary.md`（C1 の取り直しと認可）。

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

BDD の順で、観察できる検証の部品（スライド）ごとに「Given/When/Then のシナリオと失敗する試験 → 失敗の確認 → 最小の実装 → 緑 → リファクタリング」を回す。U6 は新しい業務機能を足さず、`src/` は変えない（変えるのは `package.json`、`tsconfig.json`、`eslint.config.js` と、新しい `verification/` と `tests/u6/`）。検証の部品はアプリケーションの内部を import せず、HTTP の公開の面だけを使う（NFR の設計）。

プロジェクトの規則（Testing Posture）に従い、土台を作るスライド A の中で、後続のスライド B〜E の振る舞いの試験も先に書いて失敗を確かめる。順序を守れない箇所があれば、規則を壊すと試験が落ちることを個別に確かめて `code-summary.md` に記録する。

試験の置き場は `tests/u6/{features,unit,integration,support}`。実ブラウザの試験は Playwright（`verification/e2e/`）で、Vitest の対象に入れない。実行コマンドは `unit-test-instructions.md`。カバレッジの対象（`src/**`）と閾値（行 80%）は変えない。

**第 2 回の設計レビュー（Infrastructure Design）の新規指摘の取り込み**: 集約のジョブ `gate` の判定は、起動の種類ごとに書き分ける（`schedule` と `workflow_dispatch` は `load-main` を必須にし、ほかの 4 ジョブは `skipped` を許す）。`pull_request` の種別に `edited` を足す。`relevant` が `false` 以外はすべて検証を要求する側に倒す。この 3 点は Step 11 の `gate` の判定の試験で先に固定し、Step 14 で設計文書へ反映する。

## 実装の計画

- [x] Step 1: 構成の確認と試験の準備。`tests/u6/{features,unit,integration,support}` と `verification/{shared,load,e2e,ci}/` を作る。依存（Playwright、axe-core とその Playwright 用の連携）の版を、npm の公式の登録情報と既知の脆弱性の情報で確かめ、完全な版の指定（`^`、`~` なし）で `devDependencies` にだけ入れる（NFR6.4）。`package.json` の `test`、`test:unit`、`test:integration`、`test:coverage` に `tests/u6` を足し、`verify:load`、`verify:load:smoke`、`verify:load:main`、`verify:render`、`e2e` のスクリプトを足す。`tsconfig.json` の `include` に `verification` を足す。`vitest.config.ts` の閾値と対象は変えない。U6 のコマンド（`vitest run tests/u6`）で空の実行が通ることを確かめる（AC のすべて）
- [x] Step 2: スライド A（検証の土台）の振る舞いの試験を先に書く（赤）。A の試験: 接続先の検査（`localhost`、`127.0.0.1`、`::1` と Unix ドメインソケットは通る。それ以外は許可なしで終了コード 2。`host=` パラメーターと外部の `PG*` の継承を拒否。許可時は成果物の保存が無効）、`Secret` 型（文字列化、JSON 化、検査の出力のいずれも `[秘匿]`）、種付きの擬似乱数と要求の列（同じ種と設定は同じ列、チームごとに独立）、統計（最近順位法の百分位、立ち上げ期間の除外、タイムアウトを 5 秒、未反映を 10 秒の標本に入れる）、設定の読み込み（既定が要件の表の値、不正な値は終了コード 2）、閾値の判定（短い試験は標本の多い指標だけ、本試験はすべて、測定器の飽和は「無効」）、要約の形（必須の欄、秘匿の値が含まれない）、色の比の計算（既知の値）。あわせて、スライド B〜E の振る舞いの試験（Given/When/Then）を先に書き、失敗を確かめる。失敗（赤）の出力を code-summary に記録する
- [x] Step 3: スライド A の実装。`verification/shared/` に `target-guard.ts`、`secret.ts`、`rng.ts`、`stats.ts`、`config.ts`（zod）、`thresholds.ts`、`summary.ts`、`contrast.ts` を作る。起動する子プロセスの環境は、許可リスト方式で空から組み立てる関数にまとめる。A の試験を緑にする
- [x] Step 4: スライド B（負荷試験のスクリプトと整合性の検査）の実装（基盤）。`verification/load/lifecycle.ts`（使い捨てのデータベースの作成と破棄、アプリケーションの子プロセスの起動と停止（環境は許可リスト方式で空から組み立てる: `HOST=127.0.0.1`、空きポートの `PORT`、使い捨ての `DATABASE_URL`、実行ごとに生成した `CODE_ENC_KEY` と `CODE_HMAC_KEY`（形式は `<識別子>:<base64 の 32 バイト>`）、`RUN_MIGRATIONS=true`、画面の配信用の `WEB_DIST`。起動のログの `listening` と `GET /health` の成功を待つ。上限つきの待ち）、1 時間より古い `bg3_verify_` の掃除、中断の信号でも破棄）、`consistency.ts` と `schema-adapter.ts`（読み取り専用のセッションで、週の連続、二重の確定、成功応答の値の保存を検査。SQL は 1 部品に閉じ込める。対象は `games`、`week_records`（`(game_id, week, role)` で一意、確定済みは `is_confirmed`）で、確定済みの週が 1 から連続して各 4 役割そろい、`current_week` が最後の確定の週に 1 を足した値（終了後は `week_count`）に合うことを確かめる）。結合の試験（PostgreSQL）: 失敗を注入した実行のあとで、残ったプロセスとデータベースがない。読み取り専用の接続で書き込むと `25006` で失敗する。意図的に崩した（週の欠け、二重、値の欠落）データを検査が検知する
- [x] Step 5: スライド B の実装（負荷の生成）。`verification/load/virtual-client.ts`（予定時刻から数える 1 秒周期の取り直し、遅れても飛ばさない、`behind` の記録、タイムアウト 5 秒）、`team-driver.ts`（公開の API だけを使う: `POST /api/games`（作成）、`POST /api/games/join`（有効な参加コードだけを使うため、無効なコードの試行回数の制限に当たらない）、`PUT /api/games/:gameId/assignments/:participantId`、`POST /api/games/:gameId/start`、`PUT /api/games/:gameId/weeks/:week/decisions/:role` と `POST /api/games/:gameId/weeks/:week/confirm`（どちらも 16〜128 文字の `Idempotency-Key` を付ける）、取り直しは `GET /api/games/:gameId/state`。資格情報は `Authorization: Bearer` で送る。最大想定の追加画面は同じ役割に 4 人まで、観察者 1 人を参加コードと観察者用コードで入れる。切断の模擬を含む）、`recorder.ts`（標本、台帳、区間 `warmup`・`normal`・`peak`、`reflectionMissing`）、`runner.ts` と `main.ts`（区間の進行、最大想定の追加画面は立ち上げ期間に参加させて 610 秒から取り直し、整合性の検査、要約の出力、終了コード 0・1・2）。結合の試験: 2 チーム数秒の実行がアプリケーションと PostgreSQL に対して「合格」で終わり、要約の必須の欄が揃う。同じ種で要求の列が一致する。測定器の飽和を模擬すると「無効」（終了コード 2）になる。B の試験を緑にする
- [x] Step 6: スライド B の確認とリファクタリング。短い試験（1 分・15 チーム）を手元で動かして閾値の判定と要約の形を確かめる（開発用の PostgreSQL は使わず、`localhost` の試験用データベースだけ。ポート 3000 と 5173 の開発サーバーは止めず、触れない）。重複を整理する
- [x] Step 7: スライド C（実ブラウザの反映の測定）の実装。`verification/load/render-latency.ts`: 負荷試験と同じプロセスの中で Playwright のライブラリ（`chromium.launch`）を使い、1 チーム 5 画面を開く。入力と週の確定は LoadRunner が HTTP で行い、各画面のページに `MutationObserver` と `page.exposeFunction` を入れて、新しい週の表示を `performance.now()` で記録する。標本 50 件（10 週 × 5 画面）、最近順位法の 95 パーセンタイルが 2 秒以内（`reflectionBrowserP95`）。トレース、画面の画像、動画を取らず、実行器とレポーターを使わず、ページのエラーは許可リスト方式の事象名と件数だけをログに出す。観察の仕組みを差し替えられる形にし、単体の試験（疑似のページでの測定、始点より前の観察は 0 に丸めて件数を記録、未反映は 10 秒の標本）を書く。実ブラウザを使う結合の試験は `verify:render`（Chromium が導入されている環境で動かす）
- [x] Step 8: スライド D（画面の試験）の試験を先に書き、実装する。`verification/e2e/playwright.config.ts`（`retries: 0`、`trace` と `screenshot` は失敗時のみで、接続先の検査の結果が外部接続なら無効、4 ブラウザのプロジェクト、Edge は `msedge`）、使い捨てのデータベースとアプリケーションを起動する `global-setup`（Lifecycle を再利用）、状態を公開の API で作る補助（`tests/u6/support/` ではなく `verification/e2e/support/`）、`keyboard-flow.e2e.ts`（6 工程をマウスなしで通す。AC5.5.1）、`main-operations.e2e.ts`（4 ブラウザで作成から週の確定まで。AC5.7.1）、`a11y.e2e.ts`（画面 × 状態の一覧に axe-core を動かす。コントラスト 4.5:1 を含む。AC5.5.2）、`status-indication.e2e.ts`（状態を示す要素の文字またはアクセシブルな名前が空でない。NFR8.4）、`japanese.e2e.ts`（表示された文言に英語の文が混じらない。出力の導線の日本語の説明。AC5.7.2）。ESLint で `page.waitForTimeout` の使用を禁止する規則を足し、規則を破ると落ちることを確かめる。Vitest の側に、`messages.ts` の英語の混入の検査を書く（NFR11.1）
- [x] Step 9: スライド D の確認とリファクタリング。Chromium で全部の画面の試験を動かして緑にする（Firefox、WebKit、Edge は CI の `e2e` ジョブで確かめる。手元に導入できない場合は `code-summary` に実行していないことを理由とともに記録する）。axe-core が見つけた違反は、`src/web` を直す前に一覧にして、あなたに報告する（U6 は業務機能を足さない。違反があれば前の Unit へ戻す）
- [x] Step 10: スライド E（CI）の試験を先に書く。ワークフローの定義の検査（YAML を解析する Vitest）: 最上位の `permissions` が `contents: read` だけ、`secrets.` の参照・`environment`・`id-token` がない、`retention-days`（トレースと画像 7、短い負荷試験の要約 7、本試験の要約 30）、トレースと画像は `if: failure()`、本試験の要約は `if: always()`、`schedule` が `ref: develop` を取得、`workflow_dispatch` が branch の入力（既定 `develop`）を持つ、`retries: 0`、並行実行の式（夜間と手動は実行ごとに一意で取り消さない）、変更の検出の対象のパスと基準、ジョブとワークフローの名前、`pull_request` の `types` に `edited` がある、使う actions が完全なコミットの識別子で固定されている。依存の置き場の検査（Playwright、axe-core とその連携が `devDependencies` にだけあり、版が固定）
- [x] Step 11: スライド E の実装（`gate` の判定）。`verification/ci/gate.ts`: ジョブの結果、`relevant`、起動の種類、対象の branch から、成功か失敗かを返す純粋な関数と、環境変数から呼ぶ入口。判定: `changes` が `success` でなければ失敗。`relevant` が `true` でなければ（`false` 以外の値を含めて）検証を要求する側に倒す。`pull_request` と `push` は `verify`、`e2e`、`a11y`、`load-smoke` を `success` 必須にし、`main` を対象にした PR は `load-main` も必須にする。`relevant` が `false` なら、`changes` 以外が `skipped` であることを確かめる。`schedule` と `workflow_dispatch` は `load-main` を必須にし、ほかの 4 ジョブの `skipped` を許す。起動の種類 × `relevant` × 対象の branch × 各ジョブの結果の組み合わせ表の試験を緑にする。`verification/ci/changes.ts`（起動の種類ごとの基準と対象のパス。基準が取れなければ真）と、`verification/ci/prod-deps.ts`（`npm ls --omit=dev --all --json` の結果に検証の依存が含まれないことを確かめる）も同じ流れで作る
- [x] Step 12: スライド E の実装（ワークフローと文書）。`.github/workflows/beer-game3.yml`（ジョブ `changes`、`verify`、`e2e`（4 ブラウザの行列）、`a11y`、`load-smoke`、`load-main`、`gate`。画面の配信が要るジョブ（`e2e`、`a11y`、`load-main`）は、`npm run build` を済ませてから動かす。実行機 `ubuntu-24.04`、Node.js 26、PostgreSQL 18 のサービスコンテナ、権限は `contents: read` だけ、actions は完全なコミットの識別子で固定。識別子は公式のリポジトリで確かめる）。リリース前の確認票（`docs/operation/` のうち名前に `beer-game3` を含む文書。1 つ前の世代と実機の Safari、確認した日・人・ブラウザの版・合否と所見の表）と、その存在と必須の列の見出しを確かめる Vitest。必須のチェック（`gate` の 1 つ）の設定の手順と戻し方を同じ文書の系列に書く（設定そのものは、この計画に含めず、Code Generation の完了後にあなたの承認を得て行う）。`apps/beer-game3/README.md` に検証の実行方法を足す
- [x] Step 13: 環境と構成。`npm run verify`（型検査、lint、整形の検査、カバレッジつきの全試験）を通す。カバレッジの閾値は下げない。`.prettierignore`、`tsconfig`、`eslint.config.js` に影響がないことを確かめる（`verification/` の整形と lint を通す）。本番の依存の検査（`prod-deps`）を実行する
- [x] Step 14: 設計文書と追跡。`cicd-pipeline.md`（`gate` の起動の種類ごとの判定、`edited`、`relevant` の倒し方）と `infrastructure-specification.md` ほか、実装で決まった差を設計文書へ反映する。`code-summary.md`、`traceability.json`、`source-manifest.json`、`unit-test-instructions.md` の最終の確認を書く。スライド A の順序の逸脱があれば、その確認の結果を `code-summary.md` に記録する。実行していない試験（Firefox、WebKit、Edge、10 分間の本試験、CI 上の動作）を、理由とともに記録する

## ストーリーと計画の対応

| ストーリー | 計画の Step |
| :--- | :--- |
| US5.3 通常負荷で応答し、15 チームを同時に支える（AC5.3.1） | Step 2、4、5、6、7、10、12、13 |
| US5.5 すべての画面をキーボードで操作できる（AC5.5.1、AC5.5.2） | Step 2、3、8、9 |
| US5.7 専用ソフトなしで、日本語の画面を主要なブラウザで使える（AC5.7.1、AC5.7.2） | Step 2、8、9、10、12 |

## 範囲の確認

- **この計画に含めない**: 稼働環境（staging、production）の作成とデプロイのワークフロー（後の Operation）。GitHub のリポジトリの設定（必須のチェックの設定。完了後にあなたの承認を得て行う）。10 分間の本試験の実行と合否の確認は、この Unit の実装では代表の手元実行（短い試験）で動作を確かめ、本試験そのものの合否は CI の `load-main`（リリース用 PR）で確かめる。
- **満たさない箇所があった場合**: 目標の数値は緩めない。測って原因を切り分け、前の Unit へ戻すかを、あなたに報告して決める（NFR3.6）。
