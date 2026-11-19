---
type: Design
title: "技術スタック選定 - ビールゲームシミュレーション（v2）"
description: "v2 の技術スタック。公式の情報で確認した版とサポート期限、v1 との違い、新規の依存関係、互換性の確認結果を整理した正本。"
tags: [design]
status: draft
generated: { by: claude-code/claude-sonnet-5-5, at: 2026-11-09T09:01:23Z }
---

# 技術スタック選定 - ビールゲームシミュレーション（v2）

## 概要

本書は、beer-game2（v2）の技術スタックを、バージョンとサポート期限とあわせて一覧にします。**`docs/` を設計の正本**とします。

beer-game（v1）の [技術スタック](../beer-game/tech-stack.md) を出発点に、「踏襲し、版だけ更新する」方針（[ADR-001](../../adr/beer-game2/001-rebuild-as-beer-game2.md)）で改訂しました。

- **バージョンとサポート期限は、2026-11-09 に、公式の情報源で確認した値**です（npm のレジストリ、Node.js の公式リリーススケジュール、endoflife.date、Docker Hub、Terraform Registry）。
- 版は、実装の開始時に、最新の安定版へ更新して固定します（`package-lock.json`）。
- 新しく導入する依存関係は、**導入時に承認を得ます**（プロジェクトの規約）。

## 選定の方針

- 言語は TypeScript に統一し、バックエンド、フロントエンド、テストで型を共有する。
- ORM は使わず、SQL と `pg` で直接扱う（行ロックと版つきの更新を明示するため。[ADR-002（v1）](../../adr/beer-game/002-stateless-api-row-lock.md)）。
- 依存関係は少なく保つ。**標準の機能で足りるものは、依存関係を足さない**（ログは Fastify 組み込みの Pino、メトリクスは JSON の EMF 形式、層の依存の検査は ESLint 標準のルール）。
- インフラは AWS のマネージドサービスを使い、Terraform で定義する。

## 確認した重要な事項（v1 の選定との違い）

| # | 事項 | 確認結果 | v2 の判断 |
| :--- | :--- | :--- | :--- |
| 1 | Node.js の LTS | **Node 26（Lithium）が 2026-10-28 から Active LTS**（EOL 2029-04-30）。24（Krypton）は 2026-10-20 からメンテナンス（EOL 2028-04-30）。22（Jod）は EOL 2027-04-30 | **Node 26 LTS を採用**。v1 の計画（24 へ更新）より新しい LTS が出たため |
| 2 | TypeScript | 最新は 7.0.2。ただし **typescript-eslint 8.72.1 の対応は `<6.1.0`** | **6.0.x**（最新は 6.0.3）を採用。typescript-eslint が 7 に対応した時点で更新する |
| 3 | PostgreSQL | 18 が最新（RDS の標準サポートは 2031-02-28 まで）。17 は 2030-02-28 まで | **PostgreSQL 18** を採用（新規のプロジェクトのため、サポートの長い最新の版） |
| 4 | Terraform の AWS プロバイダー | 最新は 6.x（v1 は `~> 5.0`） | **`~> 6.0`** へ更新。更新時に `plan` の差分を確認する |
| 5 | Vitest | 5.1.0（v1 は 4.1.12）。Node は `^22.12 \|\| ^24 \|\| >=26` に対応 | 5.x を採用 |
| 6 | ESLint | 10.14.0（v1 は 9.39）。typescript-eslint は ESLint 10 に対応 | 10.x を採用 |
| 7 | `@fastify/rate-limit` | 11.2.2（v1 は 10.3.0） | 11.x を採用（メジャーの変更点を確認） |

## バックエンド

| カテゴリ | 技術 | v2 の版 | v1 の版 | 用途 | サポート期限 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| 実行環境 | Node.js（LTS） | **26** | 22（CI、Docker）/ 24.11.0（開発機） | API、保持の定期タスク、マイグレーション | 2029-04-30 |
| 言語 | TypeScript | **6.0.3** | 5.9.3 | バックエンド、フロントエンド、テスト | -（7 系は、typescript-eslint の対応待ち） |
| Web フレームワーク | Fastify | 5.12.8 | 5.12.7 | REST API、SSE、組み込みの Pino ログ | - |
| Fastify プラグイン | @fastify/cookie | 11.1.5 | 11.1.5 | Cookie | - |
| | @fastify/cors | 11.4.1 | 11.3.1 | CORS（許可しない設定） | - |
| | @fastify/rate-limit | 11.2.2 | 10.3.0 | レート制限 | - |
| | **@fastify/helmet（新規）** | 13.2.0 | — | セキュリティヘッダー（CSP、HSTS、`nosniff`、Referrer-Policy） | - |
| 入力検証 | zod | 4.6.7 | 4.6.7 | リクエスト・イベントの検証 | - |
| DB ドライバ | pg（node-postgres） | 8.23.1 | 8.23.1 | PostgreSQL への接続 | - |
| **マイグレーション（新規）** | node-pg-migrate | 9.0.0 | （手動適用） | スキーマの履歴管理と適用（`pg` と同じ接続） | - |
| TypeScript 実行 | tsx | 4.23.15 | 4.23.15 | 開発時の実行。**本番はコンパイル済みの JavaScript を実行する**（`tsx` を使わない） | - |
| ログ | Pino（Fastify 組み込み） | Fastify に同梱 | （使っていない） | 構造化 JSON ログ。`redact` で資格・表示名を除外 | - |
| メトリクス | CloudWatch EMF（JSON 形式） | 依存関係なし | （無し） | 応答時間、エラー率、確定の競合など | - |

AWS SDK（SQS）は、キューを廃止するため、**依存関係に含めません**（[インフラ](./architecture-infrastructure.md)）。

## データストア

| カテゴリ | 技術 | v2 の版 | v1 の版 | 用途 | サポート期限 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| RDBMS | PostgreSQL | **18**（RDS、Docker、CI を統一） | 17（RDS、compose）/ 16（CI） | ゲームの状態、イベント、保持削除の状態 | 18: 2030-11-14（RDS の標準サポートは 2031-02-28） |
| スキーマ管理 | node-pg-migrate（SQL / TypeScript） | 9.0.0 | 手動 | 履歴テーブルで管理。拡張 → 互換 → 縮小 | - |
| ORM | なし | - | なし | 直接の SQL | - |

## フロントエンド

| カテゴリ | 技術 | v2 の版 | v1 の版 | 用途 | サポート期限 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| UI ライブラリ | React / React DOM | 19.3.1 | 19.3.1 | SPA の画面 | - |
| ビルド・開発サーバー | Vite | 8.3.6 | 8.3.6 | バンドル、HMR、`/api` のプロキシ | - |
| **ルーティング（新規）** | react-router | 8.5.1 | なし | URL とゲームの対応。再読み込みでの復帰 | - |
| 状態管理 | なし（`useState` と画面ごとのカスタムフック） | - | なし | — | - |
| スタイル | CSS（設計トークン） | - | プレーンな CSS | 単一のスタイルと、設計トークン | - |
| リアルタイム | EventSource（ブラウザ標準） | - | 同左 | SSE の受信と、ポーリングへの切り替え | - |

## テスト・品質

| カテゴリ | 技術 | v2 の版 | v1 の版 | 用途 |
| :--- | :--- | :--- | :--- | :--- |
| テストランナー | Vitest | 5.1.0 | 4.1.12 | ユニット・統合テスト |
| カバレッジ | @vitest/coverage-v8 | 5.1.0 | 4.1.12 | 行・関数・文・分岐 |
| 画面テスト | @testing-library/react | 16.3.3 | 16.3.3 | コンポーネントのテスト |
| DOM 環境 | jsdom | 31.0.0 | 29.1.1 | 画面テストの実行環境 |
| E2E | @playwright/test | 1.65.0 | 1.64.1 | 実ブラウザでの受入テスト |
| **アクセシビリティの自動検査（新規）** | @axe-core/playwright | 4.14.0 | なし | コントラスト、名前、役割などの自動検査（E2E で実行） |
| **プロパティベーステスト（新規）** | fast-check | 4.10.2 | なし | `simulateWeek` の性質（決定論性、保存則、非負）の検証 |
| 静的解析 | ESLint / typescript-eslint | 10.14.0 / 8.72.1 | 9.39.5 / 8.72.1 | 静的解析（警告 0）。**層の依存は `no-restricted-imports` で検査**（依存関係の追加なし） |
| 整形 | Prettier | 3.9.10 | 3.9.10 | 書式の検査 |
| 型定義 | @types/node、@types/react、@types/react-dom、@types/pg | 26.6.6 ほか | 24.19.2 ほか | 型の補完（`@types/node` は実行環境の版に合わせる） |
| 開発補助 | concurrently / wait-on | 10.0.7 / 9.5.1 | 同左 | `npm run dev` の並行起動と待ち合わせ |

## インフラ・運用

| カテゴリ | 技術 | v2 の版・設定 | v1 | 用途 |
| :--- | :--- | :--- | :--- | :--- |
| クラウド | AWS（ap-northeast-1） | - | 同左 | 実行環境一式 |
| コンテナ | Docker | `node:26-alpine`、ローカルの DB は `postgres:18-alpine` | `node:22-alpine` / `postgres:17-alpine` | API イメージ。**マルチステージ（ビルド後の JavaScript だけを含める）** |
| イメージの保管 | **ECR**（不変のタグ、スキャン） | - | GHCR（インフラは ECR 想定） | イメージ |
| 実行基盤 | ECS Fargate | - | 同左 | API、保持の定期タスク、マイグレーション |
| 配信 | CloudFront、S3、ALB、Route 53、ACM | 独自ドメイン、TLS 1.2 以上 | 既定の証明書 | 単一オリジンの配信 |
| データベース | RDS for PostgreSQL | 18（Multi-AZ、PITR） | 17 | 本番のデータストア |
| 秘密情報・暗号 | Secrets Manager、KMS | 鍵の複数の版 | 単一の鍵 | 接続情報と鍵 |
| 観測 | CloudWatch（Logs、Metrics、Alarms、Dashboard、Synthetics）、SNS、Budgets | - | ALB の接続数のアラーム 1 件 | ログ、メトリクス、合成監視、通知 |
| 定期起動 | EventBridge | - | 同左（SQS は廃止） | 保持の期限検出 |
| IaC | Terraform / AWS プロバイダー | **1.17 以上** / `~> 6.0` | `>= 1.8.0` / `~> 5.0` | インフラの定義。**リモートの状態（S3 とロック）、環境ごとに分離** |
| CI | GitHub Actions | 各アクションの最新の major を、コミット SHA で固定 | `@v4` | 検証、ビルド、デプロイ（OIDC） |
| CI の検査 | `npm audit`、gitleaks、Trivy、Checkov（または同等のもの） | CI のツール（実行時の依存関係ではない） | なし | 依存関係、秘密情報、コンテナ、IaC の検査 |
| ドキュメント | MkDocs、PlantUML、Mermaid | - | 同左 | 設計書の公開と図 |

## 新しく導入する依存関係（導入時に承認を得る）

| 依存関係 | 用途 | 代替（導入しない場合） | 導入の判断 |
| :--- | :--- | :--- | :--- |
| @fastify/helmet | セキュリティヘッダー | `onSend` フックで自前に設定する | 公式のプラグインで、保守されている。導入を推奨 |
| react-router | URL ルーティング | 自前の最小のルーター | 再読み込みでの復帰に必須。広く使われているため導入を推奨 |
| node-pg-migrate | マイグレーションの管理 | 番号つきの SQL と、履歴テーブルを自前で実装 | 履歴と適用を標準化できる。導入を推奨 |
| fast-check | プロパティベーステスト | 手書きの網羅 | 週次計算の性質の検証に有効。開発依存のみ |
| @axe-core/playwright | アクセシビリティの自動検査 | 手動の確認のみ | コントラストの自動検査の欠落を埋める。開発依存のみ |

## 選定理由の要約

| 領域 | 選定 | 主な理由 |
| :--- | :--- | :--- |
| 言語・実行環境 | TypeScript、Node 26 LTS | 全層で型を共有でき、純粋な計算をそのままテストできる。最新の LTS で、サポートが長い |
| Web フレームワーク | Fastify | 軽量で、プラグインと SSE の扱いが明快。ロガーを組み込みで持つ |
| DB | PostgreSQL 18 | 行ロックとトランザクション、JSONB、`LISTEN/NOTIFY` を使う設計に合う |
| DB アクセス | `pg` の直接利用 | 行ロックと版つきの更新を制御する |
| フロントエンド | React、Vite、react-router | SPA の最小構成。URL で復帰できる |
| テスト | Vitest、Testing Library、Playwright、fast-check、axe | 速い単体・統合、実ブラウザの E2E、性質の検証、アクセシビリティ |
| 実行基盤 | ECS Fargate | サーバー管理が不要で、水平に増減できる |

当時の検討記録（代替案の比較）は、v1 と同様に確認できていないため、「選定理由」は設計と実装から読み取れる根拠です。

## v1 の差分への対応

| # | v1 の差分 | v2 の対応 |
| :--- | :--- | :--- |
| 1 | Node.js の版がそろっていない（24.11.0 / 22 / `@types/node` 24）。`engines` と `.nvmrc` が無い | **Node 26 LTS に統一**。`engines`、`.nvmrc`、Docker、CI、`@types/node` を同じ版にする |
| 2 | Node 22 のサポートが 2027-04-30 まで | 26 LTS（2029-04-30）へ |
| 3 | PostgreSQL の版が環境で異なる（CI は 16） | **18 に統一**（ローカル、CI、RDS） |
| 4 | スキーマ管理のツールが無い | node-pg-migrate を導入する |
| 5 | 本番が `tsx` で、Dockerfile にビルド工程が無い | コンパイル済みの JavaScript を、マルチステージで実行する |
| 6 | Terraform の手元の版が定義より古い | 版を `required_version` で固定し、CI でも同じ版を使う。`.terraform-version` を置く |
| 7 | 依存関係の更新と脆弱性検査の自動化が無い | CI に `npm audit` ほかを加え、依存関係の更新を自動化する（Dependabot または Renovate） |

## アップグレード計画

| 時期 | 対象 | 内容 |
| :--- | :--- | :--- |
| 実装の開始時 | 全体 | 上の版へ更新し、`package-lock.json` で固定。CI で Node 26、PostgreSQL 18 の組み合わせを確認する |
| TypeScript 7 が typescript-eslint に対応した時 | TypeScript | 6.0.x から 7 系へ。型検査の速度が上がる見込み |
| 2028-04（Node 24 の EOL）以降 | — | 影響なし（26 を使用） |
| 2029-04（Node 26 の EOL）の前 | Node.js | 次の LTS（28）へ |
| 継続 | 依存パッケージ | メジャーの更新は、変更点を確認して小さく行う |

## 未決事項

- `@fastify/rate-limit` の状態を共有する方法（参加・復帰の専用の制限）。
- ログの検索・保持の期間と、メトリクスの粒度（費用との兼ね合い）。
- Dependabot と Renovate のどちらを使うか。

## 出典

- npm レジストリ（各パッケージの最新の版、`peerDependencies`、`engines`）、2026-11-09
- Node.js の公式リリーススケジュール（nodejs/Release の `schedule.json`）、`https://nodejs.org/dist/index.json`
- endoflife.date（PostgreSQL、Amazon RDS for PostgreSQL、Terraform）、Docker Hub（`node:26-alpine`、`postgres:18-alpine`）、Terraform Registry（`hashicorp/aws`）
- v1 の [技術スタック](../beer-game/tech-stack.md)、[バックエンドアーキテクチャ（v2）](./architecture-backend.md)、[フロントエンドアーキテクチャ（v2）](./architecture-frontend.md)、[インフラ（v2）](./architecture-infrastructure.md)
- [ADR-001](../../adr/beer-game2/001-rebuild-as-beer-game2.md)、[ADR-013](../../adr/beer-game2/013-tech-stack-versions.md)
