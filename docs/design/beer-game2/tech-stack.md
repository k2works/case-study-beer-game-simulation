---
type: Design
title: "技術スタック選定 - ビールゲームシミュレーション（v2）"
description: "技術スタックの一覧。バージョンとサポート期限、選定理由、設計と実装の差分、アップグレード計画を整理した正本。"
tags: [design]
status: draft
generated: { by: claude-code/claude-sonnet-5-5, at: 2026-11-09T08:26:14Z }
---

# 技術スタック選定 - ビールゲームシミュレーション（v2）

> **beer-game2（v2）の出発点**: 本書は beer-game（v1）の文書を複製したものです。v2 で改訂します。表中の「実装状況」「現状」は **v1 の状態**を表し、不足は v2 で解消する対象です。詳細は [ADR-001](../../adr/beer-game2/001-rebuild-as-beer-game2.md) を参照してください。

## 概要

本書は、ビールゲームシミュレーションの技術スタックを、バージョンとサポート期限とあわせて一覧にします。**`docs/` を正本**とし、実装済みの構成（`apps/beer-game/package.json`、`package-lock.json`、`Dockerfile`、`compose.yaml`、`infra/main.tf`、`.github/workflows`）から事実を集め、選定理由と差分を記録します。

- アーキテクチャは [バックエンド](./architecture-backend.md)、[フロントエンド](./architecture-frontend.md)、[インフラ](./architecture-infrastructure.md) を参照してください。
- バージョンは、2026-11-09 時点でインストールされている値（`npm ls`）です。`package.json` は `^` で範囲を指定しており、固定は `package-lock.json` が担います。
- **サポート期限は、公式の公開済みの予定に基づく値だけを書き、確定していないものは「要確認」としています。** 採用前に公式の情報で確認してください。

## 選定の方針

- 言語は TypeScript に統一し、バックエンド、フロントエンド、テスト、IaC 以外の運用スクリプトで共有する（チームの習熟度と型の共有を優先）。
- ORM は使わず、SQL マイグレーションと `pg` で直接扱う。週確定のトランザクションと行ロックを明示的に制御するため（[ADR-002](../../adr/beer-game/002-stateless-api-row-lock.md)）。
- フロントエンドは React と Vite の最小構成にし、ルーターと状態管理ライブラリは入れない（[ADR-006](../../adr/beer-game/006-spa-without-router-or-store.md)）。
- インフラは AWS のマネージドサービスを使い、Terraform で定義する。

## バックエンド

| カテゴリ | 技術 | バージョン | 用途 | サポート期限 |
| :--- | :--- | :--- | :--- | :--- |
| 実行環境 | Node.js（LTS） | 22（CI、Docker）。開発機は 24.11.0 | API サーバー、ワーカーの実行 | 22: 2027-04-30（メンテナンス LTS） |
| 言語 | TypeScript | 5.9.3 | バックエンド、フロントエンド、テスト | - |
| Web フレームワーク | Fastify | 5.12.7 | REST API、SSE | - |
| Fastify プラグイン | @fastify/cookie | 11.1.5 | Cookie の読み書き | - |
| Fastify プラグイン | @fastify/cors | 11.3.1 | CORS（許可しない設定） | - |
| Fastify プラグイン | @fastify/rate-limit | 10.3.0 | レート制限（プロセス内） | - |
| Fastify プラグイン | @fastify/static | 10.1.10 | 静的ファイル配信（開発・単体起動用） | - |
| 入力検証 | zod | 4.6.7 | リクエストの検証、イベントの検証 | - |
| DB ドライバ | pg（node-postgres） | 8.23.1 | PostgreSQL への接続とトランザクション | - |
| メッセージング | @aws-sdk/client-sqs | 3.1162.0 | 保持削除のキュー | - |
| 暗号 | `node:crypto`（標準） | Node に同梱 | HMAC、AES-256-GCM、乱数 | Node に準じる |
| TypeScript 実行 | tsx | 4.23.15 | 開発時の実行と監視、本番の起動（`npm start`） | - |

## データストア

| カテゴリ | 技術 | バージョン | 用途 | サポート期限 |
| :--- | :--- | :--- | :--- | :--- |
| RDBMS | PostgreSQL | 17（RDS、`compose.yaml`）。CI は 16 | ゲームの状態、イベント、保持削除の状態 | 16: 2028-11、17: 2029-11 |
| スキーマ管理 | SQL マイグレーション（手動適用） | `migrations/001`〜`005` | スキーマの定義 | - |
| ORM | なし | - | 直接の SQL | - |

## フロントエンド

| カテゴリ | 技術 | バージョン | 用途 | サポート期限 |
| :--- | :--- | :--- | :--- | :--- |
| UI ライブラリ | React / React DOM | 19.3.1 | SPA の画面 | - |
| ビルド・開発サーバー | Vite | 8.3.6 | バンドル、HMR、`/api` のプロキシ | - |
| ルーティング | なし | - | `App` の状態で画面を切り替える | - |
| 状態管理 | なし（`useState`） | - | 共有状態は `App` が保持 | - |
| スタイル | プレーンな CSS | - | 単一の `styles.css` | - |
| リアルタイム | EventSource（ブラウザ標準） | - | SSE の受信と、ポーリングへの切り替え | - |

## テスト・品質

| カテゴリ | 技術 | バージョン | 用途 | サポート期限 |
| :--- | :--- | :--- | :--- | :--- |
| テストランナー | Vitest | 4.1.12 | ユニット・統合テスト | - |
| カバレッジ | @vitest/coverage-v8 | 4.1.12 | 行カバレッジ | - |
| 画面テスト | @testing-library/react | 16.3.3 | コンポーネントのテスト | - |
| DOM 環境 | jsdom | 29.1.1 | 画面テストの実行環境 | - |
| E2E | Playwright（@playwright/test） | 1.64.1 | ブラウザでの受入テスト（Chromium 既定、Firefox・WebKit・Chrome・Edge は行列実行） | - |
| 静的解析 | ESLint / @eslint/js / typescript-eslint | 9.39.5 / 9.39.5 / 8.72.1 | 静的解析（警告 0 を要求） | - |
| 整形 | Prettier | 3.9.10 | 書式の検査 | - |
| 型定義 | @types/node、@types/react、@types/react-dom、@types/pg | 24.19.2、19.3.0、19.3.0、8.23.1 | 型の補完 | - |
| 開発補助 | concurrently / wait-on | 10.0.7 / 9.5.1 | `npm run dev` の並行起動と待ち合わせ | - |

## インフラ・運用

| カテゴリ | 技術 | バージョン | 用途 | サポート期限 |
| :--- | :--- | :--- | :--- | :--- |
| クラウド | AWS（ap-northeast-1） | - | 実行環境一式 | - |
| コンテナ | Docker（`node:22-alpine`） | Node 22 | API イメージ。ローカルの DB は `postgres:17-alpine` | Node 22 に準じる |
| 実行基盤 | ECS Fargate | - | API（常時 2、最大 4）、保持ワーカー | マネージド |
| 配信 | CloudFront、S3、ALB、Route 53 | - | 単一オリジンの配信 | マネージド |
| データベース | RDS for PostgreSQL | 17（`db.t4g.small`、Multi-AZ） | 本番のデータストア | 17: 2029-11 |
| 非同期 | SQS、EventBridge | - | 保持削除の依頼と定期起動 | マネージド |
| 秘密情報・暗号 | Secrets Manager、KMS | - | 接続情報と鍵の保管 | マネージド |
| 監視・通知 | CloudWatch（Logs、Alarm）、SNS、Budgets | - | ログ、アラーム、予算通知 | マネージド |
| IaC | Terraform / AWS プロバイダー | `>= 1.8.0` / `~> 5.0` | インフラの定義 | - |
| CI | GitHub Actions（`actions/checkout@v4`、`actions/setup-node@v4`） | - | 検証（形式・静的解析・型・テスト・E2E） | - |
| イメージ公開 | GitHub Container Registry | - | タグ時のイメージ公開 | - |
| ドキュメント | MkDocs、PlantUML、Mermaid | - | 設計書の公開と図 | - |

## 選定理由の要約

実装と設計から読み取れる根拠を整理したものです。**当時の検討記録（代替案の比較）は確認できていない**ため、「検討した代替」は一般的な候補との比較で、実際の議論の記録ではありません。採用の正式な理由は、レビュー時に確認してください。

| 領域 | 選定 | 主な理由 | 比較した一般的な候補 |
| :--- | :--- | :--- | :--- |
| 言語 | TypeScript | 全層で型を共有でき、純粋な計算（`simulateWeek`）もそのままテストできる | Java（Spring Boot）。画面との型の共有ができない |
| Web フレームワーク | Fastify | 軽量で、プラグインと SSE の扱いが明快。型が付く | Express（型と入力検証を別途用意する必要がある）、NestJS（規模に対して重い） |
| DB | PostgreSQL | 行ロックとトランザクション、JSONB、`LISTEN/NOTIFY` を使う設計に合う | DynamoDB（行ロックと複数行のトランザクションが扱いにくい） |
| DB アクセス | `pg` の直接利用 | 行ロックと明示的なトランザクションを制御する | Prisma や Drizzle（抽象化が、ロックと保存の差分更新の見通しを下げる） |
| ビルド | Vite | 開発時の HMR とプロキシが簡単 | webpack（設定が重い） |
| テスト | Vitest + Playwright | TypeScript のまま速く回せ、複数ブラウザの E2E を同じ言語で書ける | Jest（ESM と TypeScript の設定が煩雑） |
| 実行基盤 | ECS Fargate | サーバー管理が不要で、水平に増減できる | Kubernetes（規模に対して運用が重い）、Lambda（SSE と接続の維持に向かない） |

## 設計と実装の差分・要確認事項

| # | 内容 | 影響 | 扱い |
| :--- | :--- | :--- | :--- |
| 1 | **Node.js の版がそろっていない**。開発機は 24.11.0、CI と Docker は 22、`@types/node` は 24。`engines` と `.nvmrc` も無い | 型は 24 の API を許すが、本番は 22 で動く。24 でだけ動くコードが混ざっても、型検査で気づけない | `engines` と `.nvmrc` を置き、型の版を実行環境に合わせるか、実行環境を 24 に上げる |
| 2 | **Node 22 のサポートは 2027-04-30 まで**（メンテナンス LTS） | 期限後はセキュリティの修正を受けられない | 2027 年の前半までに、24 LTS へ上げる計画を立てる（Docker、CI、型を同時に更新） |
| 3 | PostgreSQL の版が環境で異なる（CI は 16、`compose.yaml` と RDS は 17、テスト用のコンテナも 16） | 版による挙動の差で、CI では通っても本番で失敗する可能性 | CI と開発用のコンテナを 17 に揃える |
| 4 | **スキーマ管理のツールが無い**。マイグレーションを番号順に手で適用する（README の手順） | 適用漏れや順序の誤りが起きやすく、環境ごとの版が追えない | マイグレーションの管理（履歴テーブルと適用の自動化）を導入するか検討する（スキーマ変更の手順なので要承認） |
| 5 | 本番の起動が `tsx`（TypeScript の直接実行）で、`Dockerfile` にビルド工程が無い。開発用の依存関係も含む | イメージが大きく、起動が遅く、攻撃面が広い | マルチステージでコンパイル済みの JavaScript を実行する形にする（[インフラ](./architecture-infrastructure.md) の差分 #2） |
| 6 | Terraform の手元の版は 1.5.7 だが、定義は `>= 1.8.0` を要求する | 手元では `terraform` を実行できない | Terraform を更新する、または版の固定ファイルを用意する |
| 7 | 依存関係の更新と脆弱性の検査を自動化する仕組みが、リポジトリで確認できない | 更新漏れに気づけない | 依存関係の更新の自動化と `npm audit` の CI への組み込みを検討する |

## アップグレード計画（案）

| 時期 | 対象 | 内容 |
| :--- | :--- | :--- |
| 2027 年前半（期限: 2027-04-30） | Node.js | 22 から 24 LTS へ。Docker、CI、`@types/node`、`engines` を同時に更新し、全テストと E2E を通す |
| 2028 年 | PostgreSQL | 16 のサポート終了（2028-11）。CI の 16 を先に 17 へ揃えておけば影響なし |
| 継続 | 依存パッケージ | メジャーの更新（React、Vite、Vitest、ESLint）は、ライブラリごとに変更点を確認して小さく行う |

## 出典

- `apps/beer-game/package.json`、`package-lock.json`、`npm ls`（2026-11-09 時点）
- `apps/beer-game/Dockerfile`、`compose.yaml`、`infra/main.tf`
- `.github/workflows/beer-game-u1.yml`、`docker-publish.yml`
- [バックエンドアーキテクチャ](./architecture-backend.md)、[フロントエンドアーキテクチャ](./architecture-frontend.md)、[インフラストラクチャアーキテクチャ](./architecture-infrastructure.md)
