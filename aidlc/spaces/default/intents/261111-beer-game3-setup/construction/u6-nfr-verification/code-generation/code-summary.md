# コード生成の要約 - U6 u6-nfr-verification

U6 は新しい業務機能を足さず、非機能の検証の仕組みと beer-game3 専用の CI を作りました。`src/` は変えていません。

## 作成・変更したファイル

| 区分 | ファイル |
| :--- | :--- |
| 共有の部品 | `apps/beer-game3/verification/shared/`（`roles`、`secret`、`target-guard`、`child-env`、`rng`、`stats`、`config`、`thresholds`、`summary`、`contrast`、`language`） |
| 負荷試験 | `apps/beer-game3/verification/load/`（`http`、`recorder`、`read-only`、`schema-adapter`、`consistency`、`lifecycle`、`virtual-client`、`team-driver`、`render-latency`、`runner`、`main`、`render-check`） |
| CI の補助 | `apps/beer-game3/verification/ci/`（`gate`、`changes`、`prod-deps`） |
| 画面の試験 | `apps/beer-game3/verification/e2e/`（設定、`global-setup`、5 つの `*.e2e.ts`、`support/`） |
| Vitest の試験 | `apps/beer-game3/tests/u6/`（14 ファイル、`support/pg.ts`） |
| ワークフロー | `.github/workflows/beer-game3.yml`（`changes`、`verify`、`e2e`（4 ブラウザ）、`a11y`、`load-smoke`、`load-main`、`gate`） |
| 文書 | `docs/operation/beer-game3/release-checklist.md`、`required-check.md`、`apps/beer-game3/README.md` |
| 設定 | `package.json`（スクリプトと devDependencies）、`package-lock.json`、`tsconfig.json`、`eslint.config.js`、`.gitignore`、`.prettierignore` |

## 主な実装の決定

- 依存は `devDependencies` にだけ、版を固定して追加: `@playwright/test` 1.65.1、`@axe-core/playwright` 4.14.0、`axe-core` 4.14.0、`yaml` 2.9.1（ワークフローの解析用）。本番の依存に含まれないことは `verify:prod-deps` で確認。
- 使う actions は、公式のリポジトリで確かめた完全なコミットの識別子で固定: `actions/checkout` v7.0.1、`actions/setup-node` v7.1.0、`actions/upload-artifact` v7.0.2。PostgreSQL のサービスコンテナは `postgres:18.6`。
- `gate` は起動の種類ごとに判定する: `schedule` と `workflow_dispatch` は `load-main` の成功を必須にし、他の 4 ジョブの `skipped` を許す。`pull_request` の種別に `edited` を足した。`relevant` は文字列の `false` だけを「関係なし」とし、それ以外は検証を要求する側へ倒す。（Infrastructure Design の第 2 回レビューの新規指摘 3 件を反映）
- 追加の閾値 `unexpectedResponses`: 429 と想定外の 4xx を 0 件にする（`rate_limited` を失敗として数えるセキュリティ設計の規則の実装）。
- 実ブラウザの測定は、負荷試験と同じプロセスの Playwright のライブラリで動かし、トレース・画像・動画を取らない。
- 要約に `verify-summary.md`（ジョブの要約用）も書き、ワークフローが `GITHUB_STEP_SUMMARY` に追記する。`actions/cache` は使わず、`setup-node` の npm キャッシュで足りる。

## 試験と結果

| 試験 | 結果 |
| :--- | :--- |
| 赤（Step 2）: 実装前に `vitest run tests/u6/features tests/u6/unit` | 11 スイートすべてが失敗（`Cannot find module '../../../verification/...'`）。画面の試験も設定がなく失敗 |
| `vitest run tests/u6` | 14 ファイル、241 件が通過 |
| `npm run e2e -- --project=chromium` | 65 件が通過（画面の通し、主要な操作、axe-core の 20 状態、状態の表示、日本語表示） |
| Firefox、WebKit | `main-operations` が通過。Firefox は `keyboard-flow` も通過 |
| `npm run verify`（最終） | 型検査、lint、整形、カバレッジつきの全試験が通過。84 ファイル、959 件。行のカバレッジ 94.5%（閾値 80% は変えていない） |
| `verify:load:smoke`（1 分、15 チーム） | 判定は合格。通常負荷の取り直しの 95 パーセンタイル 160 ミリ秒、5xx・タイムアウト・接続失敗 0 件、15 ゲームの整合性に崩れ 0 件、測定器のイベントループの遅れ（99 パーセンタイル）12 ミリ秒 |
| `verify:render`（実ブラウザ） | 合格。20 標本、95 パーセンタイル約 754 ミリ秒（上限 2000） |

## src/web の検査の結果

axe-core は、20 の画面 × 状態の組すべてで違反 0 件（`color-contrast` も実際に動いた）。意図的に悪いページで違反が出ることも確かめた。グラフの系列の色は背景に対して 3:1 以上。`messages.ts` に英語の文はない。前の Unit へ戻す事項はなく、`src/web` の修正はしていない。

## 実行していない試験とその理由

| 試験 | 理由 |
| :--- | :--- |
| Edge（`msedge`） | macOS の手元に導入されていない。CI の `e2e (edge)` ジョブで確かめる |
| WebKit の `keyboard-flow` | macOS の WebKit は既定でボタンにタブで移動しないため、手元では動かせない。Linux の CI の `e2e (webkit)` で確かめる |
| 10 分間の本試験（`load-main`、最大想定の区間を含む約 14 分） | 手元では 1 分の短い試験と実ブラウザの確認だけを動かした。最大想定の区間（追加 195 台と観察者）の経路は、結合の試験が `peakSeconds=0` のため、エンドツーエンドでは未検証。CI のリリース用プルリクエストの `load-main` で確かめる |
| GitHub Actions 上の動作 | ワークフローは YAML の定義の検査（Vitest）だけで検証した。`gate`、並行実行、保持日数、`msedge` の導入、`setup-node` の Node.js 26 は、最初のプルリクエストの実行で確かめる。夜間と手動の実行は、ワークフローが `main` に入るまで動かない |

## 計画からの逸脱

- 順序の逸脱: スライド A〜E の振る舞いの試験は Step 2 で先に書いて赤を確かめたが、`verification/e2e/support/api.ts` だけは画面の試験より先に書いた。画面の試験そのものは、設定がない状態で赤を確かめた。
- macOS では役割の選択（ネイティブのリスト）にキーが届かないため、`chooseOption` を矢印キー → 値が変わらなければ `selectOption` の順にした。Linux の CI では矢印キーだけで動く想定で、未確認。
- ローカルでは Node.js 24 が既定のため、すべて Node.js 26.13 で実行した。既存の停止中の Docker コンテナ `beer-game3-pg`（ポート 55432）を起動したままにしてある。使い捨てのデータベース `bg3_verify_*` は残っていない。ポート 3000 と 5173 には触れていない。

## 設計文書の更新

`cicd-pipeline.md`（起動の種類ごとの `gate`、`edited`、`relevant` の扱い、実装で決まった差）、`infrastructure-specification.md`、`observability-design.md`（実装の差）、`unit-test-instructions.md`（最終の確認）。

## あなたへの確認事項

1. `gate` を `develop` と `main` の必須のチェックにする設定は未実施。`docs/operation/beer-game3/required-check.md` の手順で、あなたの承認を得てから行う。
2. `release-checklist.md` のリリース 0.1 の欄は、全ブラウザが「未確認」。リリース前に記入する。
3. 最初のプルリクエストで、CI だけで動く経路（Edge の導入、Linux の役割の選択、WebKit のタブ移動）を確かめる。
