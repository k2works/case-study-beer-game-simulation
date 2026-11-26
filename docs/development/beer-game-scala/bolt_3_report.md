---
type: Reference
title: "Bolt 3 終了報告 - 入力と週確定の完成・観測（Scala 版、Release 0.1）"
description: "beer-game-scala の Bolt 3 の結果。許可リスト 27 シナリオ・155 ステップの緑、観測（構造化ログ・/ready）、止まったゲームの書き込み拒否、画面の AC2.3.1。"
tags: [report, plan]
status: draft
generated: { by: claude-code/claude-sonnet-5-5, at: 2026-11-26T08:10:00Z }
---

# Bolt 3 終了報告（Scala 版）

| 項目 | 内容 |
| :--- | :--- |
| Bolt | B3（U1。[リリース計画](./release_plan.md)。Release 0.1 相当） |
| 状態 | **実装と記録は完了。人のゲート・Release 0.1 の承認は未記録** |

## 完了条件の達成状況

| 完了条件 | 結果 | 根拠 |
| :--- | :--- | :--- |
| U1 の許可リストの 100% が green | 達成 | `allowlist.txt` の 27 シナリオ・155 ステップ。Undefined・Pending なし |
| AC6.1.1（構造化ログ）、AC6.1.2、AC6.1.4（`/ready` の実接続確認） | 達成 | 共有の `observability.feature` を許可リストに追加。DB 停止時に `/ready` が 503 |
| 止まったゲームの書き込み拒否（N-H7） | 達成 | `runningGame`・`runningSession` の停止検査 |
| 画面（AC2.3.1） | 達成 | `./scripts/ui-acceptance.sh`。共有の Web を、Scala のバックエンド（H2、ポート 3100）に向けて 1 シナリオ・8 ステップが緑 |
| CI 緑 | 確認待ち | 直近のコミット `0b369950` の実行を確認する |

## 人の判断が要る項目

- Release 0.1 のタグ付けと承認（AI は付けていない）
- `@ui` の残り 26 シナリオは未対応（B4 以降）。**範囲外**として許可リストに入れていない
- 本番相当の PostgreSQL へ接続する `Main` は未対応（AWS 適用と同じ別ゲート）

## Living Documentation

観測の仕様は共有の Gherkin が正で、複製していない。ログの項目（相関 ID・操作・状態・所要時間）の判断理由は、コードのコメントに残した。
