# 試験結果 - beer-game3（Build and Test）

実行日: 2026-11-14。実行環境: macOS（8 CPU、32 GB）、Node.js 26.13.0、PostgreSQL 18.6（Docker の `beer-game3-pg`、`localhost:55432`）。CI（GitHub Actions）では実行していない（ワークフローは `main` と PR の最初の実行まで未確認）。

## ビルド

| コマンド | 結果 |
| :--- | :--- |
| `npm --prefix apps/beer-game3 run build` | 成功。`tsc` と `vite build`（33 モジュール、`dist/web/index.html`、JS 272 kB、CSS 3 kB） |
| `npm --prefix apps/beer-game3 run verify:prod-deps` | 成功。本番の依存に検証のための依存は含まれない |

## 単位・結合・画面の試験

| コマンド | 結果 |
| :--- | :--- |
| `DATABASE_URL=... npm --prefix apps/beer-game3 run verify`（型検査、lint、整形、カバレッジつきの全試験。U1〜U6 のユニット別コマンドを内包） | 成功。84 ファイル、959 件が通過、失敗 0、スキップ 0。行のカバレッジ 94.5%（2255/2386）、文 94.68%、分岐 86.15%、関数 97.13%。閾値（行 80%）は変えていない |
| `DATABASE_URL=... npm --prefix apps/beer-game3 run e2e -- --project=chromium` | 成功。65 件（キーボードの通し、主要な操作、axe-core の 20 状態、状態の表示、日本語表示） |
| `... run e2e -- --project=firefox` | 成功。2 件（主要な操作、キーボードの通し） |
| `... run e2e -- --project=webkit main-operations` | 成功。1 件（主要な操作） |

## 負荷試験

| 試験 | 結果 |
| :--- | :--- |
| 短い試験（1 分、15 チーム）`verify:load:smoke` | 合格。取り直し 95 パーセンタイル 146 ミリ秒（通常負荷、4572 件）、サーバーの異常・タイムアウト・接続失敗 0 件、15 ゲームの整合性に崩れ 0 件、測定器のイベントループの遅れ（99 パーセンタイル）12 ミリ秒 |
| 本試験（通常負荷 10 分 + 最大想定 3 分、実ブラウザ 1 チーム）`verify:load:main`、約 13 分 | **合格**。下の表。出力は `apps/beer-game3/test-results/main-run.log`（要約の JSON）。対象のコミット `0ec1b32`、branch `develop` |

本試験の主な実測（95 パーセンタイル）:

| 指標 | 実測 | 閾値 |
| :--- | :--- | :--- |
| 入力の確定（600 件） | 243 ミリ秒 | 1 秒 |
| 週確定後の反映（仮想の利用者、560 件） | 955 ミリ秒 | 2 秒 |
| 週確定後の反映（実ブラウザ 5 画面 × 10 週、50 件） | 721 ミリ秒 | 2 秒 |
| 取り直し（通常負荷、42000 件） | 174 ミリ秒 | 500 ミリ秒 |
| 取り直し（最大想定 270 台、47770 件） | 647 ミリ秒（99 パーセンタイル 1038 ミリ秒） | 1 秒 |
| サーバーの異常、タイムアウト、接続失敗、想定外の応答 | すべて 0 件 | 0 件 |
| 整合性（15 ゲーム） | 崩れ 0 件 | 0 件 |
| 測定器のイベントループの遅れ（99 パーセンタイル） | 12.1 ミリ秒 | 100 ミリ秒（超えたら無効） |

注: 手元の macOS での実測で、リリースの判断の証拠ではない（設計どおり、証拠は CI の `load-main` の要約）。

## 実行していない試験

| 試験 | 理由 | 担当 |
| :--- | :--- | :--- |
| Edge（`msedge`）の画面の試験 | macOS の手元に導入されていない | CI の `e2e (edge)`（ci-pipeline） |
| WebKit の `keyboard-flow` | macOS の WebKit は既定でボタンにタブで移動しない | CI の `e2e (webkit)`（Linux）（ci-pipeline） |
| 1 つ前の世代のブラウザと実機の Safari | 手作業の確認票（`docs/operation/beer-game3/release-checklist.md`）。リリース 0.1 の欄は「未確認」 | リリースの前の確認（deployment-execution） |
| GitHub Actions 上の動作（`gate`、並行実行、保持日数、`msedge` の導入） | ワークフローは定義の検査（Vitest）だけで検証 | ci-pipeline |
| 夜間と手動の本試験 | ワークフローが `main` に入るまで動かない | ci-pipeline、Operation |
| SAST、DAST、HTTPS と HSTS の実環境の確認 | 稼働環境がない | environment-provisioning、deployment-pipeline、performance-validation |

## 失敗と不具合

ビルドと実行した試験の失敗はありません。実行中に 1 件の手違いがありました: 画面の試験に `DATABASE_URL` を渡さずに実行して設定の読み込みで失敗した（環境変数の指定漏れ。渡して再実行し成功）。

## 未解決の指摘（U6 のレビューより）

接続先の検査の `PGHOST` の穴（Major）、キーボード試験が OS を問わず代替の選択に切り替わる抜け道（Major）、Minor 3 件。承認時にフォローアップとして残した。
