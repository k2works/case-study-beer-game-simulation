---
type: Reference
title: "Release 1.0 の準備状況 - beer-game-scala（B15）"
description: "beer-game-scala の Release 1.0 に向けた、B15 時点の準備状況。許可リストの扱い、未承認の判断項目、AWS 未適用の項目、動いていないアラーム、未実施の確認。Release 1.0 のタグ・承認は行っていない。"
tags: [report, release]
status: draft
generated: { by: claude-code/claude-sonnet-5-5, at: 2026-11-28T00:00:00Z }
---

# Release 1.0 の準備状況（B15）

**これは承認の記録ではありません。Release 1.0 のタグ付け・承認は行っていません（人の判断）。`/goal` は承認ではありません。**

## 1. 受け入れの状況

| 項目 | 状況 |
| :--- | :--- |
| 共有 Gherkin（許可リスト） | 164 シナリオ・1093 ステップが緑（B15 で `security-baseline.feature` の 2 件を追加） |
| 許可リスト外の共有シナリオ | **8 件**: `projection-rebuild` 5 件、`metrics-and-alarms` の投影配下 3 件。投影表を持たない設計（状態は再生で得る）のため対象外にしている |
| 画面（`@ui`） | 27 シナリオ・183 ステップが Chromium・Firefox・WebKit で緑 |
| ブラウザ行列 | Edge・実機の Safari・スクリーンリーダー・色覚の確認は**未実施** |
| 計測 | 実 PostgreSQL 18.6 の手元計測のみ。AWS の値は**未測定**（[nfr_results.md](./nfr_results.md)） |
| NFR 検証表 | 84 件に判定あり。**未達 4 件**（NF-S8 Origin 検査、NF-S18 観察者の DB ロール分離、NF-O12、NF-O13）ほか |

## 2. 人の判断が要る項目（すべて未承認）

| # | 項目 | 内容 |
| :--- | :--- | :--- |
| 1 | **「許可リスト 100%」の定義** | 外れた 8 件を除外した 164 を 100% とするか、投影表を作って 8 件を通すか |
| 2 | 動いていないアラーム | 指標を出していないアラーム（MainOperationSuccess・AppendConflictRate・JvmHeap・DbPool・RetryExhausted）。`main-operation-stall` は指標が無いため、本番では**誤報する**恐れがある。出すか、アラームを外すか |
| 3 | 閾値 | アラームの閾値表は暫定値。SLO としての承認は無い |
| 4 | マイグレーション V004〜V007 | スキーマ変更（確認必須）。`/goal` の指示で先に導入した |
| 5 | 新しい依存関係 `doobie-hikari` | 本番の接続プール。承認が先のところを先に導入した |
| 6 | Terraform は Kotlin 版の複製 | 共有モジュールにしていない。`apply` は未実行 |
| 7 | エクスポートのスキーマ版名 | 名前を AI が決めた |
| 8 | 観察者の DB ロール分離（NF-S18） | 未実装。設計判断が要る |
| 9 | Origin 検査（NF-S8） | 未実装。Cookie に `Secure` 属性が無い・本文 64 KB 制限が無い点も同じ扱い |
| 10 | 依存関係の脆弱性検査・OpenAPI 契約テスト | 外部ツールの導入が要る（確認必須）。未実施 |
| 11 | リトライのジッタ・領収の 1 年保持 | 未実装 |
| 12 | 計画書・各 Bolt の承認 | B1〜B15 の計画・ゲートの承認は未記録 |

## 3. AWS には適用していない

Terraform（`infra/`）は `terraform validate` までで、`plan`・`apply` は未実行。コンテナはローカルの Docker のスモークテストまで。RPO・RTO の訓練、Fargate の起動時間、複数タスクでの動作、CloudWatch のアラームの実発報は**未確認**。

## 4. 次に人が決めること

1. 上の 1・2 を決める（Release 1.0 の範囲の定義）。
2. 3〜11 のうち、Release 1.0 に含めるものを選ぶ。
3. 承認するなら、人が計画・ゲート・タグを記録する。
