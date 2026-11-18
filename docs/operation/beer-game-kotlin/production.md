---
type: Playbook
title: "本番の運用手順書 - beer-game-kotlin"
description: "本番の適用前の確認、独自ドメイン・TLS、ブルー/グリーンのデプロイと戻し、定期タスク（retention・verify-projections）、アラームの対応、インシデント、書く版の切り替え。Terraform・ワークフローは定義のみで、AWS には未適用・未実行。"
tags: [operation, production, deploy]
status: draft
generated: { by: claude-code/claude-sonnet-5-5, at: 2026-11-18T03:00:00Z }
---

# 本番の運用手順書

> **状態: 定義のみ。AWS には何も適用していない・実行していない。** 設計は [運用要件](../../design/beer-game-kotlin/operation.md)・[インフラストラクチャ](../../design/beer-game-kotlin/architecture-infrastructure.md)。計画と結果は [Bolt 14 計画](../../development/beer-game-kotlin/bolt_14_plan.md)・[終了報告](../../development/beer-game-kotlin/bolt_14_report.md)。**適用の判断・費用・アカウント・IAM は人が決める**（リスク R10）。以下の手順は、適用の後に人が行うもので、**順序と内容は、定義から導いた案であり、AWS 上で一度も実行していない**。

関連: [デプロイ](./deploy.md)（ステージング・本番の共通の流れ）、[ロールバック](./rollback.md)（2 段階リリースと戻せないケース）、[復元](./restore.md)、[観測](./observability.md)。

## 1. 適用の前に、人が確認する項目

Terraform は `apps/beer-game-kotlin/infra/`。**手元の Terraform は 1.5.7 で、環境の `required_version`（1.17 以上）を満たさない**。`validate` は、版を緩めた作業用の複製で成功を確認した。`plan` は未実施。

| # | 確認する項目 | 内容 |
| :-: | :--- | :--- |
| 1 | Terraform の版と `plan` | 1.17 以上で `terraform init`（ロックファイルは更新済み。4 つのプラットフォーム）、`validate`、`plan` を人が確認する |
| 2 | ECS のブルー/グリーン | プロバイダー 6.73 のスキーマ（`deployment_configuration`、`advanced_configuration`）で `validate` した。**AWS 上の切り替え・待ち時間・アラームでの自動の戻しは未確認**。ステージングはローリングなので、**本番で初めて動く**。本番の初回は、利用者の少ない時間に、手動で起動して確かめる |
| 3 | ホストゾーンとドメイン | Route 53 のホストゾーンは**すでにある前提**（`hosted_zone_id`）。ドメインの取得・委任は人が行う。ACM の DNS 検証が済むまで、適用が待つ |
| 4 | CloudFront → ALB の暗号化 | 現在は HTTP（合言葉のヘッダー `X-Origin-Verify` で限定）。TLS 1.2 以上は、利用者と CloudFront の間。**ALB を HTTPS にするには、オリジン用のドメインと証明書が要る。この判断は未決** |
| 5 | 削除用のロールへの `SET ROLE` | `retention` は、`DB_DELETER_ROLE=beergame_deleter` で接続のたびに `SET ROLE` する。RDS の所有者のログインが、V101 が作ったロールに `SET ROLE` できるか（PostgreSQL 16 以降は、`GRANT beergame_deleter TO <所有者> WITH SET TRUE` が要る場合がある）を、**ステージングで最初に 1 回確かめる**。できなければ、`retention` は失敗し、`retention-heartbeat` ではなく `retention-abandoned` 側で気づく |
| 6 | 定期タスクの初回 | 適用の直後は、`scheduled_tasks_enabled = false` で作り、`run-task` で `retention`・`verify-projections` を 1 回ずつ実行して、終了コード 0 とメトリクス（`RetentionAbandonedGames`・`ProjectionMismatchGames`）が出ることを確かめてから `true` にする。**コンテナ上での `retention` の実行は、まだ一度も確かめていない** |
| 7 | GitHub の設定 | Environment `staging`・`production` と変数（[デプロイ](./deploy.md)）。追加: `RETENTION_TASK_FAMILY`・`VERIFY_TASK_FAMILY`（両方）、`RDS_INSTANCE`（本番）。**`production` に必須のレビュアーを設定する**。リポジトリの変数 `BEER_GAME_KOTLIN_AUTO_DEPLOY` は、ステージングを手動で 1 回成功させてから `true` にする。**これらは未設定**（人が行う） |
| 8 | 費用 | ブルー/グリーンの切り替えの間は、タスクが 2 倍になる。Multi-AZ、高解像度メトリクス、Synthetics。**費用の見積もりは未実施** |
| 9 | KMS・プライベートサブネット・DB ログインロールの分離 | B3 の未決のまま。**この Bolt でも定義していない** |
| 10 | 通知先 | `critical_alarm_emails`・`warning_alarm_emails`（変数）。購読の確認のメールを、宛先が承認する。オンコールの体制は組織の判断（未決） |

## 2. 独自ドメインと TLS

| 項目 | 定義 |
| :--- | :--- |
| 証明書 | `modules/domain`: ACM（us-east-1）、DNS 検証（Route 53 のレコード）、検証の完了を待つ |
| 別名 | A と AAAA の別名を CloudFront へ（`aliases` は `modules/web`） |
| TLS | 利用者と CloudFront の間は `TLSv1.2_2021`（TLS 1.2 以上）。HTTP は https へ寄せる（`redirect-to-https`）。`/api/*` は `https-only`。本番は独自ドメインが必須（`variables.tf` の検証） |
| セキュリティヘッダー | CloudFront: CSP、HSTS（1 年・サブドメイン）、nosniff、`X-Frame-Options: DENY`、Referrer-Policy、`Permissions-Policy`。API（アプリ）: 全応答に CSP（`default-src 'none'`）、HSTS、nosniff、Referrer-Policy、`Cache-Control: no-store`。CloudFront の設定が `override` のため、`/api/*` の CSP は CloudFront の値が優先される |
| 検査 | `ProductionDefinitionSpec`（定義の整合）、`HttpInfrastructureSpec`（アプリのヘッダー）。**実ブラウザでの CSP の確認と、`curl -I` による公開後のヘッダーの確認は、適用後**（次の 5 の確認に含める） |

適用後の確認（人）:

```bash
curl -sI https://<ドメイン>/ | grep -i -E "strict-transport|content-security|x-content-type|referrer|permissions|x-frame"
curl -sI https://<ドメイン>/api/v1/health | grep -i -E "strict-transport|content-security|x-content-type|referrer|cache-control"
openssl s_client -connect <ドメイン>:443 -tls1_1 </dev/null 2>&1 | grep -i -E "alert|handshake failure"   # TLS 1.1 が拒否されること
```

## 3. 本番のデプロイ（ブルー/グリーン）

[デプロイ](./deploy.md) の「本番」の手順に従う。この Bolt で変わった点:

1. **デプロイ前のスナップショット**: マイグレーションの前に、`<RDS>-pre-<SHA 8 桁>` の手動のスナップショットを取り、利用可能になるまで待つ（復元点。[復元](./restore.md)）。7 日より古い `-pre-` のスナップショットは、同じ手順で削除する（削除したゲームのデータが、バックアップに最大 7 日を超えて残らないように。NF-S16）。
2. **api の更新はブルー/グリーン**: 新しいタスク定義を `update-service` で指定すると、ECS が新しい版（green）を、もう一方の対象グループで起動する。健全（`/api/v1/ready`）を確かめてから、ALB のリスナールールを切り替える。切り替えの後の**待ち時間（bake。既定 10 分）**の間は旧版（blue）が残る。待ち時間の間に、デプロイのアラーム（`http-5xx-rate-critical`、`no-healthy-targets`）が鳴ると、**自動で旧版へ戻る**。ワークフローは `rolloutState` を 15 秒ごとに最大 30 分見て、`COMPLETED` で次へ、`FAILED`・`ROLLED_BACK` なら失敗にする。
3. **定期のタスクを同じイメージへ**: `retention`・`verify-projections` のタスク定義も、同じダイジェストの新しい版を登録する（スケジュールは、版を付けない ARN で、最新の有効な版を使う）。

見るもの（デプロイ中）: ECS のサービスのイベント、`/ecs/<名前>/api` のログ、ダッシュボードの 5xx・応答時間・正常なタスクの数。**切り替えの前後で、使っていない側の対象グループの正常数が 0 になるのは正常**（アラームは 2 つの最大を見る）。

注意:

- マイグレーションとタスクの切り替えの間（1〜数分）は、定期タスクが新しいイメージ・旧スキーマで動きうる。失敗しても、次の起動（`retention` は 5 分後）で戻る。
- イベントの形を変えるリリースは、2 段階（[ロールバック](./rollback.md)）。**書く版を上げたあとは、旧イメージへ戻せない**。

## 4. 本番のロールバック

| 状況 | 手段 |
| :--- | :--- |
| 待ち時間（bake）の間に問題が出た | アラームでの自動の戻しを待つか、ECS のサービスの更新を止めて旧版へ戻す（コンソールまたは `aws ecs stop-service-deployment`。**操作の詳細は AWS 上で未確認**）。旧版が残っているので、切り替えだけで戻る |
| 待ち時間の後に問題が出た | `beer-game-kotlin-rollback-production`（手動。保護ルールの承認。`confirm_compatible=true` が必須）。直前の版を、**もう一度ブルー/グリーンで**展開し直す（待ち時間つき）。定期のタスクも、戻す先のイメージへそろえる |
| 戻せない（書く版を上げた後） | 戻さずに前進する、または復元（[復元](./restore.md)。データを失う）。人が判断する |

マイグレーションと、イベントは戻さない（[ロールバック](./rollback.md)）。

## 5. 定期のタスク

| タスク | 起動 | 内容 | 失敗の知り方 |
| :--- | :--- | :--- | :--- |
| `retention` | 5 分ごと（EventBridge Scheduler） | 保持期限に達したゲームを、1 ゲームずつ連鎖削除する。5 回失敗したゲームは再試行をやめる（終了コード 1） | `retention-abandoned`（重大）。タスクが動かないときは `retention-heartbeat`（警告。1 時間、メトリクスが無い） |
| `verify-projections` | 日次（UTC 18:00 = 日本時間 03:00。研修のない時間） | 投影を `events` から作り直した結果と比べる（読み取りだけ） | `projection-mismatch`・`projection-lag`（重大）。動かないときは `projection-verify-heartbeat`（警告。1 日） |
| `rebuild-projections` | **人が手動** | 投影を `events` から作り直す。研修中は、運営者を通じて進行役へ停止を依頼してから（[復元](./restore.md) の B） | — |

手動の実行（独自のスクリプトは作らない。ECS の `run-task` を使う。値は `terraform output` から）:

```bash
aws ecs run-task --cluster <ecs_cluster> --launch-type FARGATE \
  --task-definition <verify_projections_task_family> \
  --network-configuration "awsvpcConfiguration={subnets=[<task_subnet_ids>],securityGroups=[<task_security_group_id>],assignPublicIp=ENABLED}"
# rebuild-projections は、対象のゲームを引数で渡す（省略すると全ゲーム）
aws ecs run-task ... --task-definition <rebuild_projections_task_family> \
  --overrides '{"containerOverrides":[{"name":"rebuild-projections","command":["rebuild-projections","<ゲーム ID>"]}]}'
```

終了コード: `retention` は 0（正常）・1（再試行をやめたゲームあり）・70（掃引の失敗）。`verify-projections` は 0（整合）・1（不整合）・70（一覧を読めない）。ログは `/ecs/<名前>/<モード>`。

**再構築で復元されないもの**: `rebuild-projections` は、`events` から投影を作り直すだけである。**周辺ストア（`display_profiles`＝表示名、`credentials`＝資格、`browser_sessions`、`idempotency_records`、`participation_attempts`）と、削除の受領記録（`deletion_receipts`）・削除の進行（`deletion_runs`・`deletion_attempts`）は、イベントから復元されない**。これらが壊れたときは、再構築でなく、DB の復元（[復元](./restore.md) の A）を使う。

## 6. アラームの対応（B14 で加わるもの）

既存のアラームと初動は [観測](./observability.md)。ここでは、B14 で加わったものと、ブルー/グリーンで変わる点。

| アラーム | 重大度 | 条件 | 初動 |
| :--- | :--- | :--- | :--- |
| `retention-heartbeat` | 警告 | `retention` の結果のメトリクスが 1 時間無い | EventBridge Scheduler の状態（`ENABLED` か）、ECS のタスクの履歴（失敗したタスクの停止理由）、`/ecs/<名前>/retention` のログを見る。`SET ROLE` の失敗（1 の 5）を疑う |
| `projection-verify-heartbeat` | 警告 | 日次の検査のメトリクスが 1 日無い | 同上（`verify-projections`）。終了コード 70（一覧を読めない）はメトリクスを出さない |
| `no-healthy-targets` | 重大 | 2 つの対象グループの正常数の最大が 1 未満 | ブルー/グリーンの途中なら、ECS のサービスのイベントで、新しい版（green）の起動の失敗を見る。アラームで自動の戻しが走る |

## 7. インシデント

障害のパターンと初動は [運用要件](../../design/beer-game-kotlin/operation.md) の「障害対応設計」（16 件）。本番で、この Bolt が加える手段:

| 状況 | 手段 |
| :--- | :--- |
| 直近のデプロイが原因 | 4 のロールバック |
| 投影の不一致 | 5 の `rebuild-projections`（研修中は停止を依頼） |
| `events` の破損・誤操作 | [復元](./restore.md) の A |
| DB・AZ の障害 | Multi-AZ の自動のフェイルオーバー（確認: `/api/v1/ready`、接続プールの再接続）。**アプリの再接続の挙動は、AWS 上で未確認** |
| 削除の失敗（放棄） | `retention-abandoned`。失敗コードを確認し、原因を直してから再試行する |

連絡: 研修中の停止の依頼は、運営者を通じて進行役へ（依頼の文言は設計書のパターン 13）。**連絡窓口とオンコールの体制は、組織の判断で未決**。

## 8. 書く版の切り替え（提案。未実装）

イベントの新しい `schema_version` を書き始める切り替え（2 段階の 2 段階目）を、どこで持つかの AI の提案: **環境変数 `WRITE_SCHEMA_VERSION`（タスク定義の環境）**。本番の環境変数の変更なので承認ゲートに乗り、ブルー/グリーンで、旧版と並んで新しい設定の版が起動し、待ち時間の間は戻せる。**アプリは、この環境変数をまだ読まない**（B15 以降）。代替の設定サービスは、実行中に切り替えられるが、構成要素と IAM が増える。判断は人。

## 9. 未確認（この Bolt の定義で、実行していないもの）

- AWS への適用、`terraform plan`、1.17 以上の Terraform での `validate`。
- ブルー/グリーンの切り替え・待ち時間・アラームでの自動の戻し・手動の戻し、`describe-services` の `rolloutState` の挙動。
- EventBridge Scheduler からの起動、`retention` の `SET ROLE`、コンテナ上での `retention`・`verify-projections` の実行。
- ACM の DNS 検証、CloudFront の別名、TLS 1.1 の拒否、公開後のヘッダー、実ブラウザの CSP。
- GitHub Actions の実行（`workflow_run` の起動を含む）。`actionlint`・`shellcheck` は未実行（ローカルに無い）。YAML の構文は確認した。
- 復元の訓練（[復元](./restore.md)）。
