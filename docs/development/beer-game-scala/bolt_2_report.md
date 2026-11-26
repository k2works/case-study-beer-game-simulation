---
type: Reference
title: "Bolt 2 終了報告 - CI・テスト基盤（Scala 版）"
description: "beer-game-scala の Bolt 2 の結果。CI の 3 ジョブ、行カバレッジのゲート、追記専用権限の否定テストの達成状況と、未了の項目（OpenAPI 契約テスト、プロジェクトごとのしきい値）。"
tags: [report, plan]
status: draft
generated: { by: claude-code/claude-sonnet-5-5, at: 2026-11-26T08:10:00Z }
---

# Bolt 2 終了報告（Scala 版）

| 項目 | 内容 |
| :--- | :--- |
| Bolt | B2（U1。[リリース計画](./release_plan.md)） |
| 状態 | **一部完了。** 人のゲートは未承認。OpenAPI 契約テストと依存関係・秘密情報の検査は未了 |

## 完了条件の達成状況

| 完了条件 | 結果 |
| :--- | :--- |
| 違反コードを置くと CI が失敗する | 達成（fixture 検査を `check` ジョブで実行） |
| 3 ジョブ（`check`・`integration`・`acceptance`）が GitHub Actions で緑 | 達成（`.github/workflows/beer-game-scala.yml`） |
| 行 80% のゲートが有効 | 達成（全体 86.7%。`scripts/coverage.sh`） |
| 追記専用権限の否定テスト | 達成（PostgreSQL 専用 V003。UPDATE・DELETE・TRUNCATE は 42501） |
| 仕様と実装をずらすと契約テストが落ちる | **未了**（OpenAPI の契約テストは新しい依存関係を要し、承認が先） |
| scoverage のプロジェクトごとのしきい値（SR3） | 達成（自作ツールで、`source` のパスから算出。全体 80%・domain 90%（実測 94.7%）・application 85%（実測 93.3%）。domain 97% は目安のまま） |
| 依存関係・秘密情報の検査を CI に含める（SR13） | **未了** |

## 人の判断が要る項目

- OpenAPI 契約テストの依存関係の導入（外部ライブラリ。確認必須）
- GitHub Actions の `sbt/setup-sbt@v1` は版を固定していない（固定するか）
- CI の 3 ジョブの実行時間の計測結果の扱い（B2 の仮説）

## Living Documentation

CI の定義とスクリプトが手順の正で、手順書へは複製していない。用語集・図の生成は未導入。
