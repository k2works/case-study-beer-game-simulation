---
type: Reference
title: "Bolt 14 終了報告 - コンテナ・デプロイ・本番の定義（Scala 版）"
description: "beer-game-scala の Bolt 14 の結果。本番相当の設定と起動モード、コンテナ、Terraform の定義、運用手順書。AWS には適用していない。U5 の完了。"
tags: [report, plan]
status: draft
generated: { by: claude-code/claude-sonnet-5-5, at: 2026-11-27T12:00:00Z }
---

# Bolt 14 終了報告（Scala 版）

| 項目 | 内容 |
| :--- | :--- |
| Bolt | B14（U5。計画は [bolt_14_plan](./bolt_14_plan.md)。**計画は着手前に書いたが、承認は得ていない**） |
| 期間 | 2026-11-27（`/goal orchestrating-development U5`。計画は 1 日） |
| 状態 | **定義とローカルの検証は完了。AWS には適用していない。計画・本番の設定・人のゲートの承認は未記録** |

承認の記録ではありません。`/goal` は承認ではありません。

## 完了条件の達成状況

| 完了条件 | 結果 | 根拠 |
| :--- | :--- | :--- |
| 本番相当の設定と起動モード | 達成 | `AppConfig`（環境変数から作る。本番・ステージングは PostgreSQL・`BGS_CREDENTIAL_KEY` が必須。H2 は拒否。不足は項目名だけを示して終了コード 78）。`Main` の起動モード `api`・`migrate`・`retention`・`verify`（不明は 64）。`AppConfigSpec` |
| コンテナ（マルチステージ・非 root・ヘルスチェック） | 達成 | `Dockerfile`。依存の JAR は、build.sbt の自作タスク `app/dist` で集める（新しいプラグインを足さない） |
| コンテナのスモークテスト（ローカルの Docker） | 達成 | `scripts/container-smoke.sh`: migrate（冪等）、api が PostgreSQL 18 に接続して `/ready` が 200・ゲームの作成が 201、秘密情報・H2 の拒否（78）、retention・verify、非 root（UID 10001）、起動時間 |
| 起動時間 | 実測 | コンテナの開始から `/ready` が 200 になるまで、5 回で **約 18〜23 秒**（17.9・22.5・19.6・20.0・19.2 秒。Docker Desktop。マイグレーションの適用を除く）。**Fargate での値は未測定**。目標値は未定 |
| Terraform の定義（`terraform validate`） | 達成 | `infra/`（Kotlin 版を複製して適応）。staging・production とも、Terraform 1.17（Docker）で成功。**`apply` は未実行** |
| アラームの表と Terraform の一致 | 達成 | `AlarmTerraformSpec`（閾値・期間・評価の回数・重大度・指標を検査。**Terraform の閾値を壊すと落ちることを確認**） |
| 運用手順書 | 達成（定義のみ） | `docs/operation/beer-game-scala/`（デプロイ・本番・ロールバック・復元・観測）、`scripts/restore-pitr.sh`（既定はドライラン） |
| RPO・RTO の机上の確認 | 実施（机上） | 復元の手順書。**訓練は未実施。値は未確認** |
| CI 緑 | push 後に記録 | |

## 新しい依存関係・設計判断（**未承認。人の判断が要る**）

| 項目 | 内容 |
| :--- | :--- |
| **新しい依存関係** `doobie-hikari`（app） | 本番の接続プール。承認が先のところを、`/goal` の指示で先に導入した |
| `build.sbt` の変更 | `exportJars := true`（全プロジェクト）と、自作タスク `dist`（依存の JAR の集約） |
| Terraform は Kotlin 版の複製 | 共有モジュールにしていない。名前・環境変数・モード・指標を差し替えた（`beer-game-scala`、`BGS_CREDENTIAL_KEY`、`verify`、`Http5xxRate` ほか）。Kotlin 版の `rebuild-projections`・`idempotency/response` の鍵・`ALLOWED_ORIGINS`・削除専用ロールは外した |
| 定期の掃引の二重の防止 | api の中の定期の掃引（`BGS_RETENTION_INTERVAL_MINUTES`・`BGS_VERIFY_INTERVAL_HOURS`）は、本番では 0（Scheduler の定期タスクが担う） |
| 定期タスクの結果の指標 | `retention` は `RetentionAbandonedGames`、`verify` は `StreamMismatchGames` を EMF で出す。EMF に `Environment` の次元を足した（アラームの対象を環境ごとに分けるため） |
| 起動モード名 | Kotlin 版の `verify-projections` を `verify` にした（投影表が無い） |

## 適用前の確認項目・未了（**重要**）

1. **機能しないアラームがある**: アプリが出している指標は、要求ごとの EMF（`Http5xxRate`・`ResponseTime`・`RequestCount`）と、定期タスクの結果だけ。`MainOperationSuccess`・`AppendConflictRate`・`JvmHeapUsedPercent`・`DbPoolUtilizationPercent`・`RetryExhausted` を使うアラームは、定義したが、**指標が出るまで機能しない**。欠測を異常と扱う `main-operation-stall` は、**指標が無いと誤報になる**。適用の前に、指標を出すか、アラームを無効にする判断が要る（B13 の判断項目と同じ）。
2. **削除専用ロール**: 保持削除は所有者の接続で動く（追記専用ロール V003 は DELETE を持たない）。本番で分けるか判断が要る。
3. **観察者専用 DB ロール・接続プールの分離**は未実装（B9）。
4. **CI**: `terraform validate`・コンテナのスモークテストを CI に載せていない（実行時間と Docker の判断が要る）。依存関係の脆弱性検査も未了（B2 から）。
5. **ECR へのイメージの公開・独自ドメイン・証明書・AWS 上の復元訓練・Fargate での起動時間**は、すべて未実施。
6. **ブルー/グリーン**（ECS の組み込み方式）は、Kotlin 版の定義の複製で、AWS 上で動作を確かめていない。

## 手順についての注記

- `AppConfigSpec`・`AlarmTerraformSpec`・`EmfSpec` は、実装と同時に書き、**先に Red を確認していない**（TDD の逸脱）。AlarmTerraformSpec は、閾値を壊すと落ちることを確認した。
- 起動時間の最初の計測（40〜190 秒）は、同時に重い処理（Terraform のプロバイダー取得）が走り、確認ごとに curl のコンテナを起動する方式だったため、信頼できなかった。常駐の curl コンテナに `docker exec` する方式に直して取り直した（上の表の値）。

## Living Documentation

| 観点 | 判断 |
| :--- | :--- |
| 書く | 本番の定義・適用前の確認項目・機能しないアラームを、運用手順書とこの報告に残した |
| 生成・書かない | アラームの表は、コード（`Alarms`）を正とし、Terraform との一致をテストで検査する（手で複製して放置しない）。用語集・図は未導入 |
| 設計文書との複製 | 設計書に、起動モード・本番の設定・Terraform の構成をまだ反映していない |

## U5 について

B11〜B14 の実装と記録は完了した。**AWS への適用は、人の承認が先**。B15（仕上げ）の前提として、機能しないアラームの扱い・許可リストの 100% の定義（外れた 8 シナリオ）・投影表の要否の判断が要る。
