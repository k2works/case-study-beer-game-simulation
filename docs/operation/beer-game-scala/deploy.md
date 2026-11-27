---
type: Playbook
title: "デプロイ手順書 - beer-game-scala"
description: "コンテナのビルドと起動モード、マイグレーション、ステージング・本番へのデプロイ、スモークテスト、失敗時の対応。AWS では未実行。"
tags: [operation, deploy]
status: draft
generated: { by: claude-code/claude-sonnet-5-5, at: 2026-11-27T11:00:00Z }
---

# デプロイ手順書

> **状態: 定義のみ（AWS 未実行）。** コンテナの検証は、ローカルの Docker で実行済み（`apps/beer-game-scala/scripts/container-smoke.sh`）。

## イメージ

- ビルド: `docker build -t beer-game-scala apps/beer-game-scala`（マルチステージ。JDK 25 + sbt で `sbt app/dist`、実行は JRE 25）。非 root（UID 10001）。
- 起動モード（第 1 引数。既定 `api`）: `api`・`migrate`・`retention`・`verify`。設定の誤りは、項目名だけをログに出して終了コード 78。不明なモードは 64。
- 設定（環境変数）: `APP_ENV`（staging・production）・`PORT`・`DB_URL`・`DB_USER`・`DB_PASSWORD`・`BGS_CREDENTIAL_KEY`。秘密情報は Secrets Manager から注入する（リポジトリに置かない）。本番相当では H2 を拒否する。

## 手順（ステージング → 本番）

1. イメージをビルドし、ECR へ公開する（**未実施**。ECR の公開は適用の一部）。ステージングで検証したダイジェスト（`@sha256:…`）を、本番の `image` に指定する。
2. **マイグレーション**: 1 回限りのタスク（モード `migrate`）を、アプリの起動前に実行する。冪等（2 回目も成功する）。共通の DDL と、PostgreSQL 専用（追記専用のロールと権限。V003）の両方を適用する。**スキーマの変更を含むデプロイは、マイグレーションの承認が先**。
3. API サービスを更新する。ステージングは ROLLING（サーキットブレーカーで自動で戻す）、本番は BLUE_GREEN（新しい版を別の対象グループで起動し、健全を確かめてから切り替え、待ち時間の間は旧版を残す）。
4. スモークテスト: `/api/v1/ready` が 200、ゲームの作成が 201（`container-smoke.sh` と同じ確認）。
5. 定期タスク（EventBridge Scheduler）: `retention`（保持期限後の削除）、`verify`（整合の検査。日次）。api 自身の定期の掃引は止める（`BGS_RETENTION_INTERVAL_MINUTES=0`・`BGS_VERIFY_INTERVAL_HOURS=0`。二重に動かさない）。

## ローカルでの確認

`apps/beer-game-scala/scripts/container-smoke.sh`（Docker が要る）: migrate（冪等）、api が PostgreSQL に接続して `/ready` が 200 になりゲームを作成できること、秘密情報・H2 の拒否（終了コード 78）、retention・verify、非 root、起動時間。AWS には接続しない。

## 失敗時の対応

- `migrate` が失敗: api を更新しない。ログ（`/ecs/<name>/migrate`）を見て原因を直す。マイグレーションは冪等で、部分的に適用された状態でも、再実行で続きから進む（Flyway）。
- api が `/ready` に応答しない: ブルー/グリーンなら、切り替え前に止まる（旧版が残る）。[ロールバック手順書](./rollback.md)を参照。
- 終了コード 78: 設定の誤り。ログの項目名（`DB_URL` など）を確認する。値はログに出ない。
