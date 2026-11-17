---
type: Plan
title: "Bolt 11 計画 - 保持と削除（Kotlin 版）"
description: "beer-game-kotlin の Bolt 11（Unit U5 の 1 つ目）のステップ計画。保持方針に基づく期限検出、game_roots の連鎖削除、再試行と通知、受領記録、削除予定日の表示。/goal U5 に基づく自律実行の記録。ゲートは未承認。"
tags: [plan]
status: draft
generated: { by: claude-code/claude-sonnet-5-5, at: 2026-11-17T17:00:00Z }
---

# Bolt 11 計画 - 保持と削除

> **承認の状態について**: 本書は、ユーザーの `/goal U5`（Unit U5 を完了する）に基づいて、AI が計画を書いたうえで実装した記録です。**判断項目とゲートの個別の承認は、受けていません（すべて未承認）。** 実装の結果は [bolt_11_report](./bolt_11_report.md)。

## 概要

| 項目 | 内容 |
| :--- | :--- |
| Bolt | B11（[リリース計画](./release_plan.md)）。U5 の 1 つ目 |
| 対象 | AC5.1.1〜5.1.5（US5.1） |
| アプローチ | インサイドアウト。日本語 Gherkin（`@api`、`@ui` 1 件）→ ドメイン（`RetentionPolicy`、`RetentionSaga` の純粋な `decide`/`evolve`）→ 永続化（Flyway V006・V103、連鎖削除、権限の否定テスト）→ アプリケーション（掃引・問い合わせ）→ HTTP・契約 → UI。TDD（Red → Green） |
| 仮説 | `game_roots` の 1 回の DELETE で、`game_id` を持つ全表から行が消える。失敗は何も消さず、再試行で最終的に一度だけ削除される |

## 判断項目（AI の提案どおりに進める。未承認）

| # | 項目 | 案 |
| :-: | :--- | :--- |
| 1 | 保持の起点（M5） | **作成時**（設計の暫定どおり。`GameCreated` の発生時刻）。終了時起点の案は採らない。人の確認が要る（R12） |
| 2 | スキーマ変更 | 設計書にある表だけ。共通の `V006__retention.sql`（`retention_policies`、`deletion_runs`、`deletion_attempts`、`deletion_receipts`）と、PostgreSQL 専用の `V103__retention_roles.sql`（`beergame_deleter`・`beergame_writer`・`beergame_reader` の GRANT）。**マイグレーションの追加は確認必須で、承認は未取得** |
| 3 | 投影 | `retention_policies` は `GameCreated` の投影（`ProjectionTable.RETENTION_POLICIES`）。`delete_after = retention_starts_at + retentionDays 日`。**B12 の再構築の対象** |
| 4 | サガの状態 | `Pending`・`InProgress(attempt, leaseUntil)`・`Failed(attempt, nextAttemptAt, failureCode)`・`Completed` に、**`Abandoned(attempt, failureCode)`** を足す（設計の `Failed` は次の試行の時刻を必ず持つため、5 回目の失敗を表せない）。永続化は `status = FAILED` かつ `next_attempt_at IS NULL` |
| 5 | クラッシュの回復 | `InProgress` は貸出期限（既定 30 分）を持つ。期限を過ぎた `IN_PROGRESS` は、次の掃引で次の試行として再開する（再起動後の復元。NF-R12） |
| 6 | 再試行 | 最大 5 回。バックオフは 5 分 × 2^(試行-1) に揺らぎ（ポートから渡す。ドメインは乱数を読まない）。5 回目の失敗で `Abandoned`（再試行をやめ、エラーのログと**終了コード 1**。通知の経路は B14 の運用） |
| 7 | 削除のトランザクション | 1 ゲームにつき、`DELETE FROM game_roots`、`deletion_runs`・`deletion_attempts` の削除、`deletion_receipts` への挿入を **1 トランザクション**で行う。開始と失敗の記録は別のトランザクション |
| 8 | 受領記録 | `game_reference_digest` は、ゲーム ID の鍵付き HMAC-SHA256（資格の鍵。用途の接頭辞つき）。`expires_at = recorded_at + 365 日`。ゲーム ID を含まない。1 年後の掃除は、掃引の中で行う（期限切れの受領記録の削除） |
| 9 | 起動モード | `retention` を実装する（掃引を 1 回行って終了。EventBridge が 5 分ごとに起動）。終了コード 0 正常、1 放棄したゲームあり、70 起動の失敗。DB のロール切替は `DB_DELETER_ROLE`（`SET ROLE`。B9 の `DB_OBSERVER_ROLE` と同じ） |
| 10 | 問い合わせ | `GET /games/{gameId}/retention`（進行役だけ。他は同じ 403）。保持日数・保持開始・削除予定日・状態（`SCHEDULED`・`IN_PROGRESS`・`FAILED`・`ABANDONED`）・試行回数・最後の失敗の分類・バックアップの残存日数（7）を返す。`POST …/retry` は実装しない（自動の再試行が AC5.1.3 を満たすため。手動の再試行は未実施） |
| 11 | 読み取り | 投影の読み取り（`ProjectedGame.retention`）に、`retention_policies` と `deletion_runs` を足す。読み取りロールに SELECT を与える |
| 12 | 画面 | S09 保持状態（`/games/:id/retention`）。削除予定日・保持日数・状態・「バックアップには、削除後も最大 7 日残ります」。コンソールの「保持状態を見る」から開く。振り返り（S08）の見出しの近くに削除予定日を示す |
| 13 | 時間の経過の表現 | 受入は、掃引に渡す時計を、実時間にオフセットを足した値へ差し替える。実際の待機はしない |
| 14 | 全表の検査 | `information_schema.columns` から `game_id` 列を持つ全表を取り、削除後に当該ゲームの行が 0 であることを、H2 と PostgreSQL の統合テストと、受入で確かめる |

## ステップ

1. 計画書（本書）と受入シナリオ（`features/retention/*.feature`）を書き、Red にする
2. ドメイン（`Retention.kt`）と投影（`retentionPolicies`）、生きた文書
3. 永続化（V006・V103、`JdbcRetentionStore`、投影の読み取り、`RolePrivilegesSpec`、全表の検査）
4. アプリケーション（`RetentionSweeper`、`Ports.retention`）
5. HTTP・契約（`GET /games/{gameId}/retention`）、起動モード `retention`、Terraform・Dockerfile・コンテナのスモークとの整合
6. 画面（S09、S08 の削除予定日）、`@ui` 1 件
7. 全検査、報告書、`release_plan.md` の進捗表

## 更新履歴

| 日付 | 内容 | 更新者 |
| :--- | :--- | :--- |
| 2026-11-17 | `/goal U5` に基づく自律実行のため、計画を書いて実装した。**判断項目・ゲートは未承認** | claude-code/claude-sonnet-5-5 |
