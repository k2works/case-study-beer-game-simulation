---
type: Reference
title: "Unit U5 総括 - 削除・再構築・観測・本番の定義（B11〜B14、Kotlin 版）"
description: "beer-game-kotlin の Unit U5（B11〜B14）の終了の記録。達成の全体像、成果物、未実施・未承認の一覧、人の確認が要る項目の統合一覧、U5 が完了と言える範囲と言えない範囲、次への申し送り。"
tags: [report, plan]
status: draft
generated: { by: claude-code/claude-sonnet-5-5, at: 2026-11-18T05:30:00Z }
---

# Unit U5 総括（削除・再構築・観測・本番の定義。B11〜B14、Kotlin 版）

| 項目 | 内容 |
| :--- | :--- |
| Unit | U5。Bolt は B11（保持と削除）、B12（投影の再構築・整合検査・スキーマ進化）、B13（観測の完成）、B14（本番の定義） |
| 期間 | 2026-11-17〜18（連続したセッション。**人の検証時間を含まない**ため、計画との比較に使わない） |
| 実行の根拠 | ユーザーの `/goal U5`（自律実行）。**判断項目とゲートの個別の承認ではない** |
| 状態 | **実装と定義は完了（B11・B12 は実装、B13・B14 は定義と検証まで）。AWS には何も適用していない。判断項目・ゲート・新しいマイグレーション（V006・V103）は未承認** |
| 個別の報告 | [B11](./bolt_11_report.md)、[B12](./bolt_12_report.md)、[B13](./bolt_13_report.md)、[B14](./bolt_14_report.md) |

この総括は、事実と、人が判断・検証すべき点を示すものです。**承認の記録ではありません。「U5 が承認された」とは書けません。**

## 1. 達成の全体像

| Bolt | ゴール | 機械的に確認できたこと | 確認できていないこと |
| :--- | :--- | :--- | :--- |
| B11 | 保持と削除（AC5.1.*） | 受入 11 件（期限前は消さない、期限後は連鎖削除で `game_id` を持つ全表に行が残らない、失敗は何も消えず再試行、5 回で放棄）。PostgreSQL の連鎖削除と権限の否定テスト。受領記録がゲームを特定しない | コンテナ・AWS での `retention` の実行、手動の再試行（実装しない判断）、保持の起点（暫定のまま） |
| B12 | 投影の再構築・整合検査・スキーマ進化 | `events` から投影を再構築し結果が一致、排他ロック（PostgreSQL）、整合の日次検査、アップキャスト、N-1 互換 | 本物のタグでの N-1 互換、別プロセスでの排他の実機、書く版の切り替えの設定（未実装） |
| B13 | 観測の完成（AC6.1.3・6.1.5・6.1.6） | EMF のメトリクス、アラームの評価と訓練（模擬で、研修中の停止を 60 秒以内に検知）、Terraform の定義 | CloudWatch・SNS・Synthetics での動作、通知の配送の時間 |
| B14 | 本番の定義（AC6.2.*） | 定期タスク・心拍・ブルー/グリーン・ドメイン・TLS・ヘッダー・復元の定義と、`ProductionDefinitionSpec`（26 件）による突き合わせ。復元スクリプトのドライラン | AWS での全動作、ブルー/グリーンの切り替えと戻し、復元の訓練（RPO・RTO の実測） |

全体の検査（B14 の終了時点）: `ktlintCheck pmdMain pmdTest test acceptanceTest koverVerify`、`:adapter-persistence:integrationTest :app:integrationTest`、JDK 21 の detekt（違反 0）が成功。`terraform fmt -check` 成功、モジュールと環境（版を緩めた作業用の複製）の `validate` 成功。

## 2. 成果物（主なもの）

| 領域 | 場所 |
| :--- | :--- |
| ドメイン・アプリケーション | `domain/.../RetentionSaga.kt`、`application/.../RetentionSweeper`・`Metrics.kt`・`Alarms.kt`・`AlarmCatalog.kt`（21 規則。重大 12・警告 9）、投影の再構築・整合検査 |
| 永続化 | `V006__retention.sql`、`V103__retention_roles.sql`、`JdbcRetentionStore`、再構築・検査のストア |
| 起動モード | `api`・`migrate`・`retention`・`rebuild-projections`・`verify-projections` |
| Terraform（適用なし） | `infra/modules/{network,alb,ecr,ecs,github_oidc,rds,secrets,web,observability,domain}`、`infra/envs/{staging,production}` |
| ワークフロー・スクリプト | CI、デプロイ・ロールバック（ステージング・本番）、`scripts/{container-smoke,n1-compat,restore-pitr}.sh` |
| 運用手順書 | `docs/operation/beer-game-kotlin/`: `deploy`・`rollback`・`observability`・`production`・`restore`・`container_local` |

## 3. 人の確認が要る項目の統合一覧

| # | 区分 | 項目 | 出どころ |
| :-: | :--- | :--- | :--- |
| 1 | AWS への適用 | 適用の判断・費用・アカウント・IAM（R10）。`terraform plan`（1.17 以上）、ロックファイルの `init` | B3・B13・B14 |
| 2 | 方式の決定 | ブルー/グリーンを ECS の組み込み方式にするか、設計書どおり CodeDeploy か。**本番で初めて動く** | B14 |
| 3 | 設計の決定 | RPO 0 の範囲（PITR では 0 にならない）。障害パターン 4 の RTO（15 分に収まる保証がない）に別の値を置くか | B14 |
| 4 | 設計の決定 | CloudFront → ALB を HTTPS にするか（オリジン用のドメインと証明書）。KMS・プライベートサブネット・DB ログインロールの分離 | B3・B14 |
| 5 | マイグレーション | V006（保持）・V103（権限の GRANT）の承認。削除用のロールへの `SET ROLE`（所有者に `WITH SET TRUE` が要るか） | B11・B14 |
| 6 | 保持 | 保持の起点（作成時が暫定。終了時起点の案）。バックアップ 7 日と手動のスナップショットの扱い | B11・B14 |
| 7 | 運用の決定 | 研修中だけ通知する運用（`training_alarms_enabled`）の自動化。オンコール・連絡窓口・停止の依頼の連絡手段。通知先のメール | B13・B14 |
| 8 | 閾値 | 提案の値（競合率・再試行・GC・プール、ブルー/グリーンの待ち時間 10 分）の実測での見直し。GC は区間の平均で近似 | B13・B14 |
| 9 | 設定 | 書く版の切り替え（環境変数 `WRITE_SCHEMA_VERSION` の提案。未実装）。再構築中のコマンドの応答（待つか 503 か） | B12・B14 |
| 10 | GitHub の設定 | Environment・変数・`production` の保護ルール・`BEER_GAME_KOTLIN_AUTO_DEPLOY`。**すべて未設定** | B3・B14 |
| 11 | 訓練 | 復元の訓練（RPO・RTO の実測）、ロールバックの訓練、アラームの実機の訓練 | B13・B14 |
| 12 | 未実装 | SSE・再生・投影の更新時間などの指標、業務のスモークテスト、手動の再試行 | B11・B13 |

## 4. U5 が完了と言える範囲と言えない範囲

- **言える**: ローカル・CI 相当の検査で、削除・再構築・整合検査・観測のメトリクスとアラームの評価・本番の定義が、期待どおりに動くことと、定義と実装・設計の値が一致していること。
- **言えない**: AWS 上で、定期タスク・ブルー/グリーン・アラーム・復元が動くこと。RPO 0・RTO 15 分の達成。研修中の停止を 1 分以内に通知まで届けること。**「本番へ出せる」とは言えず、「出すための定義がそろった」までである。**

## 5. 次への申し送り

- 次は B15（仕上げ）。計画の承認済み項目に従う。性能の実測（NF-P18 など）、書く版の切り替えの実装、業務のスモークテストが候補。
- AWS の適用は、上の 1〜4・10 を人が決めてから。適用後の最初の作業は、[本番の運用手順書](../../operation/beer-game-kotlin/production.md) の「適用の前に、人が確認する項目」。
