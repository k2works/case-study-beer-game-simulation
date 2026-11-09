---
type: ADR
title: "ADR-008: 保持期間後の削除を SQS と所有者別ワーカーの Saga で実行する"
description: "保持期間を過ぎたゲームは、ゲーム単位の削除要求を所有者ごとに発行し、全所有者の完了を確認して初めて完了とする。"
tags: [adr]
status: draft
generated: { by: claude-code/claude-sonnet-5-5, at: 2026-11-09T07:45:25Z }
---

# ADR-008: 保持期間後の削除を SQS と所有者別ワーカーの Saga で実行する

保持期間を過ぎたゲームは、ゲーム単位の削除要求を所有者ごとに発行し、全所有者の完了を確認して初めて完了とする。

日付: 2026-11-09

## ステータス

提案中（実装済みの決定を事後に記録したもの。レビュー待ち）。削除対象に漏れがある（後述）。

## コンテキスト

ゲームの記録は、作成時に決めた保持期間（1〜3650 日）の後に削除する必要がある。データはゲーム本体、参加者の資格、学習用の投影など、複数の所有者に分かれている。1 つの処理が他の所有者のデータを直接消すと、所有の境界を壊す。失敗した場合の再試行と、完了の判定も必要になる。

- 参考: [データモデル設計](../../design/beer-game/data-model.md)

## 決定

- 保持方針（`retention_policies`）を持ち、期限に達したゲームごとに削除の Saga（`deletion_sagas`）を開始する。
- コーディネーターが、所有者（`u1-walking-skeleton`、`u2-session-continuity`、`u3-learning-view`）ごとの SQS キューへ削除要求を送る（トランザクショナル・アウトボックス経由）。
- 各所有者のワーカーが、自分のデータだけを冪等に削除し、完了通知を完了キューへ送る。
- 全所有者が完了した場合にだけ Saga を完了とする。失敗は自動で再試行（最大 5 回）し、超えれば手動の再試行（進行役が実行）とする。無効な通知は隔離キューへ送る。
- 削除の証跡は、ゲーム ID のダイジェストだけを持つ受領記録（`deletion_receipts`）として一定期間残す。
- コーディネーターと所有者ワーカーは、EventBridge で定期起動する ECS タスクとする。

### 変更箇所

- `apps/beer-game/src/retention/*`（`retention-service.ts`、`postgres-retention.ts`、`sqs-worker.ts`、`owner-deletion.ts`、`worker-main.ts`）
- `apps/beer-game/migrations/004_u4_retention.sql`
- `apps/beer-game/infra/main.tf`（SQS、EventBridge、ECS タスク）

### 代替案

- 保持の管理者が全データを直接削除する: 所有の境界を壊し、1 つの失敗で全体が止まる。
- 各所有者が独自の予定で削除する: 完了の状態と失敗の再試行を一貫して観測できない。
- データベースの有効期限（TTL）機能に任せる: 複数のストアと所有者にまたがる完了の判定ができない。

## 影響

### ポジティブ

- 保持の方針の正本と、削除の完了判定が 1 か所になる。
- 失敗の再試行、隔離、証跡が仕組みとして用意される。

### ネガティブ

- Saga、キュー、ワーカー、受領記録と、構成要素が多い。
- 現状の削除対象には漏れがある。`outbox_events` と `idempotency_records` は、どの所有者の削除にも含まれていない（`retention_policies` も削除対象外で、証跡として残す意図かは未確認）。

## コンプライアンス

- **未達**: 保持期間後に、ゲームに関するデータが残らないこと。上記の漏れを解消するか、残す範囲を保持方針として明文化する（[データモデル設計](../../design/beer-game/data-model.md) の差分 #3）。
- 削除の統合テストが通ること（`tests/u4/retention-pg.integration.test.ts`、`tests/u4/retention-api.integration.test.ts`）。

## 備考

- 著者: claude-code（事後記録）。承認者: 未定
- 関連コミット: 未コミット（U4 の作業ツリー）
- 関連 ADR: ADR-003、ADR-005
- 元の設計記録: `aidlc/.../inception/domain-design/decisions.md` の ADR-004
