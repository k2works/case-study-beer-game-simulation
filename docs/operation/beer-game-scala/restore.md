---
type: Playbook
title: "復元の手順書 - beer-game-scala"
description: "データベース全体の復元（時点復旧・スナップショット）、復元後の確認（削除の再実行と整合の検査）、RPO・RTO の机上確認。AWS では未実行。"
tags: [operation, restore, backup]
status: draft
generated: { by: claude-code/claude-sonnet-5-5, at: 2026-11-27T11:00:00Z }
---

# 復元の手順書

> **状態: 定義のみ。復元の訓練は一度も実施していない（AWS が無い）。** 手順は `apps/beer-game-scala/scripts/restore-pitr.sh`（既定はドライラン。AWS の認証も要らない）。投影表を持たない設計なので、「投影の再構築」の手順は無い。状態はイベントの再生で復元される。

## バックアップ

RDS の自動バックアップ（保持期間は定義のとおり）と、削除前の最終スナップショット（本番）。

## 手順（ドライランで確認する）

```
apps/beer-game-scala/scripts/restore-pitr.sh --instance beer-game-scala-production \
  --new-instance beer-game-scala-production-restore (--target-time <UTC> | --latest | --snapshot <ID>)
```

1. 新しいインスタンスへ復元する（元は残す）。
2. 切り替える（**人が判断する**）: api の台数を 0 にして書き込みを止める → 名前を付け替える → api を戻す。
3. **復元後の確認（必須）**: ① `retention` を 1 回実行する（復元で、削除済みのゲームが再び現れないようにする） ② `verify` を実行する（イベントのストリームの整合。不一致があれば調べる） ③ 進行中だったゲームを確認し、運営者へ連絡する。
4. 元のインスタンスは、確認が済むまで残す。

## RPO・RTO の机上の確認

| 項目 | 目標 | 机上の確認 |
| :--- | :--- | :--- |
| RPO | 5 分（時点復旧） | RDS の PITR は、最大 5 分前まで戻せる（AWS の仕様）。**実測はしていない** |
| RTO | 1 時間（案） | 新しいインスタンスの作成・切り替え・確認の合計。**訓練は未実施。値は未確認** |

## 未確認

復元の訓練・所要時間・Terraform の状態の整理（名前の付け替え後）は、AWS 上で未確認。
