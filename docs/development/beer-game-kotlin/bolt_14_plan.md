---
type: Plan
title: "Bolt 14 計画 - 本番の定義（Kotlin 版）"
description: "beer-game-kotlin の Bolt 14（Unit U5 の最後）のステップ計画。定期タスク（retention・verify-projections）、ブルー/グリーン、独自ドメイン・ACM・TLS、セキュリティヘッダー、復元の手順、運用手順書の定義。AWS には適用しない。/goal U5 に基づく自律実行の記録。ゲートは未承認。"
tags: [plan]
status: draft
generated: { by: claude-code/claude-sonnet-5-5, at: 2026-11-18T02:00:00Z }
---

# Bolt 14 計画 - 本番の定義

> **承認の状態について**: 本書は、ユーザーの `/goal U5`（Unit U5 を完了する）に基づいて、AI が計画を書いたうえで実装した記録です。**判断項目とゲートの個別の承認は、受けていません（すべて未承認）。** 結果は [bolt_14_report](./bolt_14_report.md)。**AWS への適用はしません**（Terraform・設定・手順書の「定義」まで。適用は人の別ゲート。リスク R10）。

## 概要

| 項目 | 内容 |
| :--- | :--- |
| Bolt | B14（[リリース計画](./release_plan.md)）。U5 の最後 |
| 対象 | US6.2（AC6.2.1〜AC6.2.5）、NF-S9、NF-S15、NF-O11、NF-R3、NF-R4、RPO・RTO の机上確認 |
| アプローチ | 定義は、検査できる形（ファイルを読んで期待と突き合わせる Spec、復元スクリプトのドライラン）で先に書き、定義を足して緑にする。AWS 上の動作は未確認と明記する |
| 仮説 | 本番へ安全に出し、戻し、復元できる**定義**になっている。ただし「定義がある」ことと「動く」ことは別で、実機の確認は適用後 |
| 前提 | B11・B13 の完了（確認済み） |

## 前の Bolt が「B14 に残す」とした項目

| 出どころ | 項目 | この Bolt での扱い |
| :--- | :--- | :--- |
| B11 | EventBridge の 5 分ごとの起動 | **定義する**（`modules/ecs`。EventBridge Scheduler、`rate(5 minutes)`） |
| B11 | `retention` のタスク定義 | **定義する**（`modules/ecs` の `batch_tasks`） |
| B11 | 削除ロール（`beergame_deleter`）のログインユーザー設定 | **一部**。B11 の実装は `DB_DELETER_ROLE`（接続のたびに `SET ROLE`）なので、**別のログインユーザーは作らず**、タスクの環境変数 `DB_DELETER_ROLE` で定義する。所有者のログインが `SET ROLE` できるか（`GRANT ... WITH SET TRUE`）は **人が AWS 上で確認**（未確認） |
| B11 | 通知の経路（放棄したゲームのアラーム） | **定義する**（B13 の `retention-abandoned` に、`retention` のタスクが出すメトリクスがつながる。新しい心拍のアラームを足す） |
| B11 | コンテナでの `retention` 実行 | **しない（未実施）**。ローカルのコンテナでは `container-smoke.sh` が扱わない。AWS 上の初回実行で確認（運用手順書の適用前の確認） |
| B12 | `rebuild-projections`・`verify-projections` の ECS タスク定義 | **定義する**（`verify-projections` は日次の起動、`rebuild-projections` は人が手動で `run-task`） |
| B12 | 日次検査のスケジュール（研修のない時間帯）とアラーム | **定義する**（UTC 18:00 = 日本時間 03:00。アラームは B13 の `projection-*`。検査が動かないことは心拍で知る） |
| B12 | 運用手順書への「再構築では周辺ストアと削除の進行は復元されない」旨の追記 | **追記する**（[復元の手順書](../../operation/beer-game-kotlin/restore.md)、設計書 B 手順） |
| B12 | 書く版の切り替え方（環境変数か設定サービスか）の提案 | **提案を判断項目に書く**（実装はしない。判断項目 9） |
| B13 | `retention`・`verify-projections` の ECS 定期タスク | 上と同じ |
| B13 | 検査ジョブが止まったときの心拍アラーム | **定義する**（`AlarmCatalog` に 2 規則。Terraform と一致） |
| B13 | 環境の `terraform validate`/`plan` の準備（ロックファイル、版） | **一部**。ロックファイルを更新（`archive` を追加し、4 つのプラットフォームのハッシュ）。`validate` は、`required_version` を一時的に緩めた**作業用の複製**（手元は 1.5.7）で実施。`plan` は AWS の認証が無く**未実施**。実環境は 1.17 以上が要る |
| B13 | `training_alarms_enabled` の運用 | **手順書に書く**（運営者の予定表との連携は未実施のまま） |
| B3 | Terraform の最小構成に対する残り（独自ドメイン・ACM・ブルー/グリーン・KMS・DB ログインロールの分離） | 独自ドメイン・ACM・ブルー/グリーンは**定義する**。**KMS・DB ログインロールの分離・プライベートサブネットは定義しない**（人の判断が要る。R10） |
| R10 | AWS 適用の判断・費用・アカウント・IAM | **人が決める**。この Bolt では適用しない |

## 判断項目（AI の提案どおりに進める。未承認）

| # | 項目 | 案 |
| :-: | :--- | :--- |
| 1 | スキーマ・契約・画面の変更 | **なし**（マイグレーション、`openapi.yaml`、Web は触らない） |
| 2 | ブルー/グリーンの方式 | **提案: ECS の組み込みのブルー/グリーン**（`deployment_configuration.strategy = BLUE_GREEN`、`advanced_configuration`。プロバイダー 6.73 のスキーマで `validate` 済み）。設計書は CodeDeploy だが、組み込みは (a) CodeDeploy のアプリ・デプロイグループ・appspec が要らず、(b) `update-service` でタスク定義を指定する既存のワークフローの形が変わらず、(c) ロールバックも同じ操作になる。**代替**: CodeDeploy（実績が長い。リスナールールの扱いと appspec の管理が増える）。**ステージングはローリング**（設計どおり） |
| 3 | 切り替えと戻し | 新しい版（green）を別の対象グループで起動し、健全を確かめてから切り替える。**待ち時間（bake）は 10 分**（初期案）。その間に重大のアラーム（`http-5xx-rate-critical`、`no-healthy-targets`）が鳴れば、**自動で旧版へ戻す**。切り替えは全量（カナリアなし。2〜4 タスクの小さなサービスで、段階の切り替えの利点が小さいため）。**AWS 上で未確認** |
| 4 | 対象グループが 2 つになる影響 | `no-healthy-targets` のアラームは、2 つの対象グループの正常数の**最大**を見る（片側だけだと、使っていない側が 0 で、切り替えのたびに誤報になる。**実装中に見つけた設計の穴**）。ALB のリスナールールの転送先は ECS が書き換えるので、Terraform は差分を無視する |
| 5 | 独自ドメインと ACM | 新しいモジュール `modules/domain`（Route 53 のホストゾーンは**すでにある前提**。ACM の証明書を us-east-1 で DNS 検証、A/AAAA の別名）。TLS 1.2 以上は CloudFront の `minimum_protocol_version = TLSv1.2_2021`（既存）。**CloudFront → ALB は HTTP のまま**（合言葉のヘッダーで限定。ALB を HTTPS にするには、オリジン用のドメインと証明書が要る。**人の判断が要る未決**として手順書に残す） |
| 6 | セキュリティヘッダー | **アプリ（Ktor）側は B1 で実装済み**（`Observability.kt`。CSP・HSTS・nosniff・Referrer-Policy・Cache-Control を全応答に。`HttpInfrastructureSpec` が検査）。この Bolt では実装を足さず、**CloudFront 側**（既存）に `Permissions-Policy` を足し、両者の整合（HSTS の max-age）と TLS の設定を、`ProductionDefinitionSpec` で検査する。Web の CSP（`style-src 'self'`）は、ソースに `style=` と `<style>` が無いことの静的な確認まで。**実ブラウザでの CSP の確認は未実施** |
| 7 | 定期タスク | EventBridge Scheduler。`retention` は `rate(5 minutes)`、`verify-projections` は `cron(0 18 * * ? *)`（UTC 18:00）。再試行 0（失敗は心拍で知る。同じ起動を重ねない）。`rebuild-projections` は定期にしない。起動の ARN は版を付けない（最新の有効な版）ので、**デプロイ・ロールバックのワークフローが 4 つの family を同じイメージへそろえる**。有効・無効は `scheduled_tasks_enabled` |
| 8 | 心拍のアラーム | `projection-verify-heartbeat`（日次、`ProjectionMismatchGames` の欠測で発報）、`retention-heartbeat`（1 時間、`RetentionAbandonedGames` の欠測で発報）。ともに警告。値は 0 以上なので「0 未満」の条件は成り立たず、**欠測を超過とみなす**ことだけが理由 |
| 9 | 書く版の切り替え（実装しない） | **提案: 環境変数 `WRITE_SCHEMA_VERSION`（タスク定義の環境）**。変更は本番の環境変数の変更なので承認ゲートに乗り（ブルー/グリーンで、新しい設定の版が旧版と並んで起動し、待ち時間の間に戻せる）、設定サービスを増やさない。代替: 設定サービス（AppConfig など。実行中に切り替えられるが、構成要素と IAM が増え、書く版が「いつ変わったか」の記録が別になる）。実装は B15 以降（アプリの設定の読み取りとスキーマの書き分けが要る） |
| 10 | デプロイ前のスナップショット | 本番のデプロイの、マイグレーションの前に、手動のスナップショット（`<RDS>-pre-<SHA 8 桁>`）を取る。復元点。**手動のスナップショットは自動で消えない**ので、7 日より古いものをワークフローで消す（削除したゲームのデータが、バックアップに最大 7 日を超えて残らない。NF-S16。**実装中に見つけた設計の穴**） |
| 11 | ステージングの自動デプロイ（AC6.2.1） | `workflow_run`（main の CI `beer-game-kotlin` の成功後）で、ステージングのデプロイを起動する。**リポジトリの変数 `BEER_GAME_KOTLIN_AUTO_DEPLOY` が `'true'` のときだけ**動く（未設定の間は、起動してもジョブを飛ばす）。人が、AWS の準備を終え、手動で 1 回成功させてから設定する。**本番は自動にしない**（`workflow_dispatch` のみ。環境の保護ルールで承認）。**シークレット・環境の保護は未設定**（人が行う） |
| 12 | 復元の手順 | `scripts/restore-pitr.sh`（既定はドライラン。`--execute` で新しいインスタンスへの復元と完了待ちだけ。切り替えは人）。手順書 `restore.md`。復元後の整合検査（`retention` → `verify-projections`）。**机上確認の結果: RPO 0 は、Multi-AZ のフェイルオーバーでは成り立つが、PITR では成り立たない（復元可能な最新時刻が数分遅れる）。RTO 15 分は、PITR の新しいインスタンスの作成で収まる保証がない**（実測が要る）。設計の「パターン 4 の RTO」の扱いを、人が決める |
| 13 | 運用手順書 | `production.md`（適用前の確認、本番のデプロイ・戻し、定期タスク、アラームの対応、インシデント）、`restore.md`（復元・RPO/RTO・訓練の様式）。既存の `deploy.md`・`rollback.md`・`observability.md`・`index.md`、設計書 `operation.md` を更新 |

## ステップ

1. 計画書（本書）。`ProductionDefinitionSpec`（定義を読んで、期待と突き合わせる）と、`AlarmsSpec` の心拍の試験を先に書き、Red にする
2. アラーム: `AlarmCatalog` に心拍の 2 規則、`alarms.tf` に同じ値（`ObservabilityDefinitionSpec` が一致を検査）
3. Terraform: `modules/ecs`（定期タスク、スケジューラー、ブルー/グリーン）、`modules/alb`（2 つ目の対象グループ）、`modules/observability`（正常数の最大）、`modules/domain`（新規）、`modules/rds`（バックアップの時間帯）、`modules/github_oidc`（スナップショット）、`modules/web`（`Permissions-Policy`）、環境（production・staging）、ロックファイル。`terraform fmt`・`validate`
4. ワークフロー: ステージングの自動起動、本番のスナップショットとブルー/グリーンの待ち方、定期タスクの family、ロールバック
5. `scripts/restore-pitr.sh`（ドライランの試験つき）
6. 運用手順書と設計書
7. 全検査、報告書、`release_plan.md` の進捗表、Unit U5 の総括

## 更新履歴

| 日付 | 内容 | 更新者 |
| :--- | :--- | :--- |
| 2026-11-18 | `/goal U5` に基づく自律実行のため、計画を書いて実装した。**判断項目・ゲートは未承認** | claude-code/claude-sonnet-5-5 |
| 2026-11-19 | ユーザーが、判断項目とゲートを承認した（指示: 「Boltゲートの承認」。範囲の選択: U3（B7・B8）・U4（B4・B9・B10）・U5（B11〜B14）・U6（B15）。内容の選択: 「判断項目とゲートのみ」）。判断項目（ブルー/グリーン方式の提案を含む）は AI の提案どおりの決定として承認された。**この承認に含まれない**: デモ項目の人の実操作、コードの全行理解、AWS への適用（独自ドメイン・ACM・ブルー/グリーンの実施・復元の訓練を含む。別の承認ゲート） | user（記録: claude-code/claude-sonnet-5-5） |
