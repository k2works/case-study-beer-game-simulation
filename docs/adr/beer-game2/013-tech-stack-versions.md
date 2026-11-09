---
type: ADR
title: "ADR-013: 技術スタックの版を、確認済みの値で固定する（Node 26 LTS、PostgreSQL 18、TypeScript 6.0）"
description: "実行環境と主要な依存関係の版を、公式の情報で確認した値で定め、全環境で統一する。"
tags: [adr]
status: draft
generated: { by: claude-code/claude-sonnet-5-5, at: 2026-11-09T09:01:21Z }
---

# ADR-013: 技術スタックの版を、確認済みの値で固定する（Node 26 LTS、PostgreSQL 18、TypeScript 6.0）

実行環境と主要な依存関係の版を、公式の情報で確認した値で定め、全環境で統一する。

日付: 2026-11-09

## ステータス

提案中（レビュー待ち）

## コンテキスト

v1 では、Node.js の版がそろっていなかった（開発機 24、CI と Docker は 22、型は 24）。PostgreSQL も、環境で 16 と 17 が混在していた。v2 の決定（ADR-001）では、Node を 24 LTS へ更新する想定だったが、2026-10-28 に **Node 26 が LTS になり**、24 はメンテナンスに入った。TypeScript の最新は 7.0.2 だが、typescript-eslint の対応は `<6.1.0` まで。

## 決定

- **Node.js 26 LTS**（EOL 2029-04-30）に、ローカル、CI、Docker、`@types/node` を統一する。`engines` と `.nvmrc` を置く。
- **PostgreSQL 18**（RDS の標準サポート 2031-02-28 まで）に、ローカル、CI、RDS を統一する。
- **TypeScript 6.0.x**（最新は 6.0.3）。typescript-eslint が 7 系に対応した時点で更新する。
- Terraform は 1.17 以上、AWS プロバイダーは `~> 6.0`。
- 実装の開始時に、最新の安定版へ更新し、`package-lock.json` で固定する。
- 導入する新しい依存関係（@fastify/helmet、react-router、node-pg-migrate、fast-check、@axe-core/playwright）は、導入時に承認を得る。

### 代替案

- Node 24 LTS: メンテナンスに入っており、サポート期限が短い（2028-04-30）。
- PostgreSQL 17: 新規のプロジェクトで、サポートが短い選択をする理由が無い。
- TypeScript 7: typescript-eslint が未対応で、静的解析が使えなくなる。

## 影響

### ポジティブ

- サポート期限が長く、環境間の不一致が無くなる。
- 互換性を、公式の情報（npm の `peerDependencies`、`engines`）で確認済み。

### ネガティブ

- 最新の版の組み合わせで、未知の不具合があるかもしれない（CI で確認する）。

## コンプライアンス

- ローカル、CI、Docker、`engines` の Node の版が一致すること。
- ローカル、CI、RDS の PostgreSQL のメジャーの版が一致すること。

## 備考

- 著者: claude-code
- 関連 ADR: [ADR-001](./001-rebuild-as-beer-game2.md)
- 参照: [技術スタック（v2）](../../design/beer-game2/tech-stack.md)
