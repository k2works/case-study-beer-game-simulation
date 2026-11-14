# CI の構成 - beer-game3

beer-game3 の CI は、U6 で作った `.github/workflows/beer-game3.yml` です。この工程では新しいワークフローを足さず、その構成を、Build and Test が記録した検証コマンドとの対応で確定します。設計の詳細は `construction/u6-nfr-verification/infrastructure-design/cicd-pipeline.md` にあります。

出典: `build-and-test-summary.md`、`test-results.md`、`code-summary.md`（U6）、`team.md`（`develop` 統合、`main` はリリース時の merge、Node.js 26、PostgreSQL 18、formatter・linter・type-check を CI で実行し失敗したら merge しない）、`ci-pipeline-questions.md`（Q1、Q2）。

## 構成の要点

| 項目 | 内容 |
| :--- | :--- |
| ツール | GitHub Actions。`ubuntu-24.04`、Node.js 26、PostgreSQL 18（サービスコンテナ、`postgres:18.6`） |
| ブランチの方針 | `develop` で統合、`main` はリリース時の merge。PR の対象は `develop` と `main`、push は `develop` と `main`。夜間の定期実行は `develop` を取得 |
| 権限 | 最上位に `permissions: contents: read` だけ。シークレットなし、デプロイなし |
| 外部の actions | 完全なコミットの識別子で固定。更新は人が確認して手作業 |
| 成果物の置き場 | この工程では作らない・公開しない（Q1 の A）。コンテナのイメージと置き場（ECR を前提）は Deployment Pipeline と Environment Provisioning で決める |
| 設定の変更 | 必須のチェック（`gate`）の設定は、あなたの承認を得てから行う（手順は `docs/operation/beer-game3/required-check.md`） |

## ジョブと、Build and Test の検証コマンドの対応

| ジョブ | 動かす内容 | Build and Test の対応 |
| :--- | :--- | :--- |
| `changes` | beer-game3 の変更の有無 | - |
| `verify` | `npm run verify`（型検査、lint、整形、カバレッジつきの全試験）、本番の依存の検査 | `verify`（959 件、行 94.5%）、`verify:prod-deps` |
| `e2e`（4 ブラウザ） | キーボードの通しと主要な操作 | `e2e`（Chromium、Firefox、WebKit。Edge は CI で初めて動く） |
| `a11y` | axe-core、状態の表示、日本語表示 | `e2e -- --project=chromium` |
| `load-smoke` | 1 分の短い負荷試験 | `verify:load:smoke` |
| `load-main` | 10 分の本試験 + 最大想定 3 分 | `verify:load:main`（手元で合格） |
| `gate` | 上の結果を集約（必須のチェックはこの 1 つ） | - |

## 未確認で、最初の実行で確かめること

Edge（`msedge`）の導入、Linux の WebKit のキーボード操作、`gate` と並行実行と保持日数の実際の動作、`setup-node` の Node.js 26。夜間と手動の実行は、ワークフローが `main` に入るまで動かない。最初のリリース用 PR の `load-main` が、リリースの本試験の証拠になる。

## 未解決の指摘（引き継ぎ）

U6 のレビューの Major 2 件（接続先の検査と `PGHOST`、キーボード試験の抜け道）と Minor 3 件は、CI の最初の実行の前に直すのが望ましい。`quality-gates.md` に記録する。
