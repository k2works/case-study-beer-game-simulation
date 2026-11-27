---
type: Index
title: "beer-game-scala - 運用"
description: "beer-game-scala の運用ドキュメントの一覧。デプロイ・本番・復元・ロールバック・観測。AWS には一度も適用していない（定義のみ）。"
tags: [operation, index]
status: draft
generated: { by: claude-code/claude-sonnet-5-5, at: 2026-11-27T11:00:00Z }
---

# beer-game-scala — 運用

> **状態: 定義のみ。AWS には一度も適用していない。** 本番の設定・AWS への適用・復元の訓練は、人の承認が先です（[Bolt 14 計画](../../development/beer-game-scala/bolt_14_plan.md)）。手順の多くは [beer-game-kotlin の運用手順書](../beer-game-kotlin/index.md) と同じ構成です（Terraform は Kotlin 版を複製して適応した）。

| ドキュメント | 概要 | 状況 |
| :--- | :--- | :--- |
| [デプロイ手順書](./deploy.md) | イメージのビルド、起動モード、マイグレーション、ステージング・本番のデプロイ、スモークテスト | 定義のみ（AWS 未実行）。コンテナはローカルで検証済み |
| [本番の定義](./production.md) | Terraform の構成、必要な変数、独自ドメイン・TLS・セキュリティヘッダー、ブルー/グリーン、適用前の確認項目 | 定義のみ（`terraform validate` 済み。適用していない） |
| [ロールバック手順書](./rollback.md) | 直前の版へ戻す手順、戻せないケース | 定義のみ |
| [復元の手順書](./restore.md) | データベースの復元（時点復旧・スナップショット）、復元後の確認、RPO・RTO の机上確認 | 定義のみ。訓練は未実施 |
| [観測](./observability.md) | メトリクス（EMF）、アラームの表、出ていない指標、通知 | 定義のみ。**一部の指標は未出力** |
