---
type: Plan
title: "Bolt 3 計画 - CI/CD とデプロイの定義（Kotlin 版）"
description: "beer-game-kotlin の Bolt 3 のステップ計画。JVM のコンテナ、起動モード、Terraform の最小構成の定義、マイグレーションの自動適用、スモークテスト、ロールバックの手順。AWS への適用はしない。承認待ち。"
tags: [plan]
status: draft
generated: { by: claude-code/claude-sonnet-5-5, at: 2026-11-14T23:21:42Z }
---

# Bolt 3 計画 - CI/CD とデプロイの定義

## 概要

| 項目 | 内容 |
| :--- | :--- |
| Bolt | B3（[リリース計画](./release_plan.md)） |
| Unit | U1 ウォーキングスケルトン（後半） |
| 所要（計画） | 2 稼働日（仮定） |
| ゲート密度 | **標準**（構造が決まっている。ただし**本番環境・デプロイ設定は確認必須**のため、定義のレビューは人が行う） |
| アプローチ | 序盤（[開発戦略](./development_strategy.md)）。**定義を、適用せずに、検証できる範囲で検証する**（`terraform validate`、ローカルのコンテナ、スモークテスト） |
| 状態 | **承認待ち**。本書は AI が提案したもの。ユーザーのゴール（U1）に従い、B1・B2 が未承認のまま、2026-11-15 に実行を開始した（B3 のステップ計画そのものは、人が承認していない） |

### 範囲の線引き（重要）

- **AWS への適用はしない**（`terraform apply` を実行しない。リソースを作らない）。適用・デプロイの実行は、別の承認ゲート（AWS アカウントと費用の判断）。
- **本番環境・デプロイ設定は確認必須**（プロジェクトの規約）。本書は**定義の作成まで**。ワークフローは、`workflow_dispatch` のみで、**自動で起動しない**ように定義する。
- 秘密情報（資格の鍵、DB のパスワードなど）は、リポジトリに置かない。AWS の Secrets Manager から注入する**定義**にとどめる。
- 実行環境の制約: ローカルの Terraform は 1.5.7（設計は 1.17 以上）。AWS の認証情報はローカルに無いため、**`terraform plan` はローカルでは実行できない見込み**（`validate` までを、作業用の新しい Terraform で行う）。`plan` が通ることは、**未確認**として扱う。

### ゴール

JVM のアプリケーションを、**再現できるコンテナ**にし、起動モード（`api`・`migrate`、将来の `retention`・`rebuild-projections`）を定義し、ステージング・本番の AWS 構成（Terraform）と、デプロイ・ロールバックの手順を、**適用せずに**定義する。

### 確認したい仮説

1. コンテナ（マルチステージ、JRE 25）が再現でき、ローカルで `api`・`migrate` が起動し、スモークテストが通るか。
2. JVM の起動時間は、目標（NF-P16: p95 30 秒）に収まるか。
3. 起動時の設定の検査（H2 の拒否、秘密情報が無ければ失敗）は、コンテナでも働くか。
4. beer-game2 のインフラ定義（Terraform）を、JVM に合わせて流用できるか。変更点は何か。

### 範囲外

AWS への適用、独自ドメイン・ACM・CloudFront の本番設定の完成（B14）、観測（メトリクス・アラーム。B13）、`retention`・`rebuild-projections` の実装（B11・B12。モード名の定義のみ）。

---

## ステップ計画

各ステップは、可能な範囲で**テスト（検証）を先に**書きます。**ゲートは、人の確認待ち**とし、承認済みとは書きません。

### Step 1: コンテナと起動モード（🔴🟢）

- [x] 1.1 🔴 コンテナのスモークテスト（`api` が `/ready` に応答、`migrate` がマイグレーションを適用して終了、**本番相当の設定で秘密が無ければ起動に失敗、`DB_KIND=h2` を拒否**）を先に書き、失敗を確認する
- [x] 1.2 🟢 `Dockerfile`（マルチステージ。実行イメージは JRE 25。非 root。H2 のドライバを含めない。ヘルスチェック）と、起動モード（`api`・`migrate`。`retention`・`rebuild-projections` はモード名の定義と、未実装の旨の明確な失敗）
- [x] 1.3 ローカルで、コンテナをビルドして起動し、スモークテストを通す。**起動時間を計測**（仮説 2）。イメージの内容（H2 を含まないこと、サイズ）を確認

**ゲート 1**: コンテナと起動モードを、人が確認する。**状態: 人の確認待ち（承認済みではない）。**

#### Step 1 の結果（2026-11-15）

**作ったもの**: `apps/beer-game-kotlin/Dockerfile`、`.dockerignore`、`scripts/container-smoke.sh`（恒久のスモークテスト）、`app/build.gradle.kts`（配布から H2 を除外）、`Main.kt`（未実装のモード）、`MainSpec.kt`（モードの単体テスト）。コミットしていない。AWS・ECR には触れていない。

**Red の確認（先に書いて失敗を確認）**
- 単体テスト（`MainSpec` に、未実装モード 2 件と、使えるモードの案内を追加）: 実装前に `./gradlew :app:test --tests 'beergame.app.MainSpec'` が「8 tests completed, 3 failed」で失敗した。
- スモークテスト: `Dockerfile` が無い状態で `./scripts/container-smoke.sh` を実行し、`failed to read dockerfile: open Dockerfile: no such file or directory` で失敗した。**注意**: スクリプトの検査項目そのもの（終了コード 78 など）の Red は、イメージが無いため確かめられていない（検査の中身は、実装後の Green で初めて動いた）。(c)(d) と未実装モードの終了コードは、単体テスト（`MainSpec`）でも別に押さえている。

**実装**
- 起動モード: `api`・`migrate` は既存。`retention`・`rebuild-projections` は名前だけ定義し、**設定を読む前に**「未実装です」を ERROR で記録して**終了コード 69**（sysexits の EX_UNAVAILABLE。64 使い方、70 起動失敗、78 設定の誤りと区別）。不明なモードの案内に 4 モードを列挙した。
- `Dockerfile`: ビルドは `eclipse-temurin:25-jdk-noble` で `./gradlew :app:installDist`、実行は `eclipse-temurin:25-jre-noble`（両タグとも `docker pull` で実在を確認）。依存の JAR（`lib/` の外部 JAR。32.3MB）とアプリの JAR（5 モジュール。1.16MB）を別の層に分けた。非 root（uid 10001）。`ENTRYPOINT ["/app/bin/app"]`、`CMD ["api"]`（モードは引数）。`JAVA_OPTS="-XX:MaxRAMPercentage=70 -XX:+ExitOnOutOfMemoryError"`（設計の初期案。ヒープの測定による決定は未実施）。`HEALTHCHECK`（interval 30s、timeout 3s、start-period 40s、retries 3）。**実行イメージに curl・wget が無い**ことを実測で確認したため、`bash` の `/dev/tcp` で `/api/v1/ready` に GET を送り、200 のときだけ healthy とした。
- **H2 の扱い**: H2 は `adapter-persistence` の `runtimeOnly` なので、そのままでは `installDist` の `lib/` に入る。`app/build.gradle.kts` で、`startScripts` のクラスパスと `distributions.main` から `h2-*.jar` を除外した（`:app:run` とテストの実行時の依存には残る）。`installDist` の `lib/` に H2 が無く、起動スクリプトのクラスパスにも無いことを確認。イメージ内でも `ls /app/lib | grep ^h2` が空。`APP_ENV=local DB_KIND=h2` はイメージで起動せず終了コード 70（ドライバ無し）。設計書の「本番のイメージに H2 を含めない案は未実施」を、本実装で実施した。

**実行したコマンドと結果（実測）**
- `docker build -t beer-game-kotlin:smoke .` → 成功（初回、依存の取得を含む 約 6 分 14 秒。ホストは amd64）。
- `RUNS=7 SKIP_BUILD=1 ./scripts/container-smoke.sh` → 「スモークテスト: すべて成功」。内訳: (b) migrate は終了コード 0 で「マイグレーションを適用しました」を記録（postgres:18-alpine に接続）。(c) 本番相当で鍵が無いと終了コード 78、ログに `CREDENTIAL_KEY` の名前が出てパスワードの値は出ない。(d) `APP_ENV=production DB_KIND=h2` は終了コード 78。(e) 未実装 2 モードは終了コード 69。(f) uid=10001、H2 無し。(a) `APP_ENV=production` の api が、PostgreSQL に接続して `/api/v1/ready` に 200、`/api/v1/health` に 200、HEALTHCHECK が healthy。SIGTERM（`docker stop -t 20`）で終了コード 143（JVM が停止フックを実行して終わる。強制終了の 137 ではない）。
- `./gradlew build`（JDK 25。ktlint・test・契約テスト・PMD の fixture と層ごとの検査・Kover を含む）→ BUILD SUCCESSFUL（3 分 32 秒）。PMD の「Found 17 violations」は fixture の期待どおりの違反。`JAVA_HOME=JDK 21 ./gradlew detektMain detektTest :app:detekt` → BUILD SUCCESSFUL。`@Suppress`・ベースラインは使っていない。

**起動時間（仮説 2。コンテナの開始から `/api/v1/ready` が 200 になるまで。マイグレーションは別に適用済み）**
- 7 回の実測（ms）: 4935、4189、5191、5552、4979、5978、4009。最小 4.0 秒、最大 6.0 秒（NF-P16 の p95 30 秒に対して大きな余裕）。**制約**: ホストでの `docker run -d` の呼び出し時間を含み、約 50ms 間隔のポーリング。ローカルの Docker Desktop（Intel Mac）の値で、ECS Fargate（1 vCPU / 2 GiB の初期案）の値ではない。7 件では p95 は言えない。Fargate での実測は未確認。

**イメージの内容**
- サイズ 494.6MB（ベースの `25-jre-noble` が 430.0MB。追加は依存 JAR 32.3MB、アプリ JAR 1.16MB、起動スクリプト 32.8kB）。非 root、H2 無し、curl・wget 無し、JDK・Gradle・ソースを含まない（実行ステージは JRE と成果物だけ）。

**設計書との食い違い・未決・未確認**
- 設計の「ENTRYPOINT [起動スクリプト, モード]」は、`ENTRYPOINT` に起動スクリプトを置き、モードは `CMD`（既定 `api`）で渡す形にした（上書きできる）。
- 未実施・未確認: 軽量な派生イメージ（Alpine など）の採否とサイズ・脆弱性の比較、ファイルシステムの読み取り専用（`--read-only` での起動の確認）、AppCDS、JVM のヒープ（70%）の測定、RDS の CA バンドル（beer-game2 の Dockerfile にある。JDBC の `sslmode` の方針と合わせて Step 2 以降で決める）、`/ready` が通知の受信の生存を含むか（B1 の実装の範囲で、本 Step では確認していない）、「マイグレーション未適用なら ready が 503」の確認、Trivy 等の脆弱性の検査、GitHub Actions 上のビルド。
- スモークテストの CI への組み込みは未実施（Step 3 の範囲）。SIGTERM の終了コードが 143 であることは、設計の「正常終了」の定義（0）と異なる。ECS の停止（SIGTERM 後の猶予）では問題にならない想定だが、アラームの条件に終了コードを使う場合は 143 を考慮する必要がある。人の判断を待つ。

### Step 2: Terraform の定義（🔵）

- [x] 2.1 beer-game2 の `apps/beer-game2/infra`（定義）を読み、**JVM に合わせた変更点**（ポート、ヘルスチェックのパス `/api/v1/ready`、環境変数 `DB_KIND=postgres`・`APP_ENV`、秘密情報の注入、CPU・メモリの初期案、起動猶予）を洗い出す
- [x] 2.2 `apps/beer-game-kotlin/infra/` に、最小構成（ネットワーク、RDS for PostgreSQL 18、ECR、ECS Fargate、ALB、CloudFront、S3、Secrets Manager、IAM、環境ごとの分離）の**定義**を作る。**リソースを作らない**。秘密の値を含めない。リモートの状態（S3 とロック）は設計書のとおり
- [x] 2.3 検証: `terraform fmt -check`、`terraform validate`（作業用の新しい Terraform。設計の `required_version` を満たす版を、公式の配布から作業用ディレクトリに取得して使う。**システムの Terraform は入れ替えない**）。**`terraform plan` は、認証情報が無いため未実行（未確認）**と記録

**ゲート 2**: Terraform の定義を、人が確認する（**本番環境・デプロイ設定は確認必須**）。**状態: 人の確認待ち（未承認）。**

#### Step 2 の結果（2026-11-15。AWS には接続・適用していない）

**成果物**: `apps/beer-game-kotlin/infra/`（`modules/` の network・rds・ecr・secrets・alb・web・ecs・github_oidc、`envs/staging`・`envs/production`、`.gitignore`、`*.tfvars.example`・`backend.hcl.example`（ダミーの値）、環境ごとの `.terraform.lock.hcl`）。

**実行したコマンドと結果（実測）**

| コマンド | 結果 |
| :--- | :--- |
| `terraform fmt -check -recursive`（`infra/`） | 差分なし（終了コード 0） |
| `terraform init -backend=false`（staging、production） | 成功。AWS プロバイダー **6.73.0**、random **3.9.1** を registry.terraform.io から取得（認証情報は不要） |
| `terraform validate`（staging、production） | **どちらも成功**（`The configuration is valid.`） |
| `terraform providers lock`（linux_amd64、darwin_arm64、darwin_amd64） | ロックファイルに 3 プラットフォームのハッシュを記録（CI の Linux でも `init` できるように） |
| `terraform plan` / `apply` / `destroy` | **実行していない**（認証情報が無い。**plan が通ることは未確認**） |

- 使った Terraform: **1.17.2**（作業用。`/private/tmp/.../scratchpad/tf/terraform`。`releases.hashicorp.com` の一覧で 1.17.2 の実在と、SHA256SUMS の一致を確認して取得）。システムの Terraform（1.5.7）は入れ替えていない。
- `required_version = ">= 1.17.0"`、AWS プロバイダー `~> 6.0`、random `~> 3.6`（設計書の「Terraform 1.17 以上、AWS プロバイダー ~> 6.0」。**設計書の値自体は beer-game2 の確認値の引き継ぎで、本書では registry で、6.x の最新が 6.73.0 であることだけ確認した**）。
- `.gitignore`: `.terraform/`・`*.tfstate*`・`backend.hcl`・`terraform.tfvars` を除外。`.terraform.lock.hcl` はコミット対象。
- 秘密・アカウント ID・実在のドメインは含めていない（`grep` で 12 桁の数字、アクセスキー形式、実ドメインが無いことを確認）。値は変数と `*.example` のダミーのみ。

**beer-game2（Node）から JVM（Kotlin）向けの変更点**

| 項目 | beer-game2 | beer-game-kotlin（本定義） | 根拠・状態 |
| :--- | :--- | :--- | :--- |
| 名前・タグ | `beer-game2-<env>` | `beer-game-kotlin-<env>`、VPC の CIDR は `10.30.0.0/16` | 区別のため |
| コンテナのポート | 3000 | **8080**（ALB、セキュリティグループ、タスク） | `ServerConfig.DEFAULT_PORT = 8080`（実装を確認） |
| ヘルスチェック | `/ready` | **`/api/v1/ready`** | 設計書の未決事項（B1 の実装のパス） |
| ALB のアイドルタイムアウト | 120 秒 | **60 秒** | 設計書 |
| 環境変数 | `NODE_ENV`、`APP_ENV=<名前>`、`ALLOWED_ORIGIN` | **`APP_ENV=staging｜production`**（AppEnv の 4 値）、**`DB_KIND=postgres`（固定）**、`DB_URL`（JDBC、`sslmode=require`、資格なし）、`HOST=0.0.0.0`、`PORT`、**`ALLOWED_ORIGINS`**、`MIGRATE_ON_START=false` | `ServerConfig.kt`・設計書。H2 の拒否の二重の防御 |
| 秘密情報（Secrets Manager → ECS の `secrets`） | `DATABASE_URL`、`CREDENTIAL_HMAC_KEY`、`IDEMPOTENCY_KEY` | **`DB_USER`・`DB_PASSWORD`（JSON のキーごと）、`CREDENTIAL_KEY`・`IDEMPOTENCY_KEY`・`RESPONSE_KEY`（Base64 の 32 バイト。3 つは別の値）** | `ServerConfig` が `local` 以外で必須とする |
| CPU・メモリ | 256 / 512 | api は **1 vCPU / 2 GiB**、migrate は 0.5 vCPU / 1 GiB | 設計書 ID2 の**初期案・実測で見直す**。migrate の値には設計書の根拠が無く、JVM が起動できる大きさの仮置き |
| 起動猶予 | `health_check_grace_period_seconds = 30` | **120 秒（初期案）** | JVM の起動時間は**未計測**（Step 1 の測定の後に見直す）。NF-P16 は p95 30 秒以下（提案） |
| 終了 | 指定なし | `stopTimeout = 40` 秒（初期案）、ALB の `deregistration_delay = 30` と整合 | 設計書「負荷分散との整合」。SIGTERM での正常終了はアプリ側 |
| 自動増減 | なし | 本番のみ **2〜4 タスク、CPU 60%**、スケールアウト 180 秒・スケールインの 300 秒のクールダウン（初期案） | 設計書。クールダウンの値は測定で決める |
| 起動モード | `command` で node のコマンドを指定 | **同じイメージに `command = ["api"]`・`["migrate"]`**（マイグレーションは別の 1 回限りのタスク定義） | `Main.kt` のモード。**Dockerfile の ENTRYPOINT との整合は未確認**（Step 1 は別のエージェントが作業中） |
| マイグレーション | node-pg-migrate | Flyway を `migrate` モードで実行 | 設計書 ID4 |
| 定期タスク（保持） | EventBridge Scheduler の保持タスク | **定義しない**（B11。モード名だけ） | 計画の範囲外 |
| 観測（合成監視・アラーム） | `observability` モジュール | **定義しない**（B13）。ロググループ（api・migrate）だけ | 計画の範囲外 |
| SQS | なし | なし | 設計書 |
| RDS | `db.t4g.micro`、DB 名 `beer_game2` | **`db.t4g.small`**、DB 名 `beer_game_kotlin`、所有者 `beergame_owner`。PostgreSQL 18、暗号化、PITR（7 日）、SSL 必須、本番は Multi-AZ・削除保護 | 設計書のコストの節 |
| DB ロール | 1 種類 | 用途別の 4 ロール（`beergame_writer`・`reader`・`observer`・`deleter`）は **NOLOGIN で V101 が作る**。**ログイン用のロールの分離は定義しない**（api も migrate も所有者の資格を使う） | 設計書。B3 は方針のみ（下の未決） |
| Terraform の状態 | S3 + DynamoDB のロック | **S3 + `use_lockfile`（S3 のロックファイル）。DynamoDB は使わない** | Terraform 1.10 以降の機能。設計書の「S3 とロック」の実現手段の選択（人の確認が要る） |
| プロバイダー | AWS `~> 5.0`、archive | AWS `~> 6.0`、random。archive（合成監視用）は不要。`aws_region.name` → `.region`（6.x の非推奨対応） | 設計書 |
| OIDC のデプロイロール | ECS を `*` | `UpdateService`・`DescribeServices` はこの環境のサービスに限定、ログの読み取りはこの環境のロググループに限定 | 最小権限の強化 |
| `github_repository` | 既定値あり | 既定値なし（必須の変数） | 実在の値を持ち込まない |

**設計書との食い違い・未決・未確認**

1. **ECS の置き場所**: 設計書の図は ECS を「プライベートサブネット」に置く。本定義は beer-game2 と同じく、**NAT を作らず、公開サブネットにパブリック IP つきで置き、セキュリティグループで ALB からのみ許可**する（費用）。プライベートに置くなら NAT または VPC エンドポイント（ECR・Secrets Manager・Logs・S3）の費用が要る。**人が決める**。
2. **KMS（顧客管理鍵）は定義していない**（設計書の構成要素にあるが、B3 の最小構成の一覧に無い）。Secrets Manager と S3 は AWS 管理の鍵。
3. **本番のブルー/グリーン（CodeDeploy）は定義していない**（設計書は本番をブルー/グリーン、ステージングをローリングとする）。両環境ともローリング + デプロイのサーキットブレーカー（失敗で自動の巻き戻し）。設計書の未決事項のとおり。
4. **DB のログイン用ロールの分離と、ロールごとの秘密**（設計書: ロールごとに別の秘密）は未定義。**マイグレーション用のユーザーの作り方も、設計書の未決のまま**（本定義は RDS のマスターを所有者として使う）。V101 と V102 の順序の注意（設計書）も残る。
5. **`prevent_destroy` は付けていない**（環境ごとに切り替えられないため）。本番の保護は、RDS の削除保護、S3 の `force_destroy = false`、最終スナップショット、秘密の復旧期間 30 日。
6. **タスク内の `stopTimeout`、猶予期間、CPU・メモリ、クールダウンの数値はすべて初期案で、実測の根拠が無い**（起動時間・ヒープ・GC は未計測）。`JAVA_TOOL_OPTIONS`（`-XX:MaxRAMPercentage` など）は、Dockerfile 側の担当として**本定義では渡していない**（要整合）。
7. **CloudFront の CSP** は beer-game2 の値の流用で、Kotlin 版の `web/` が満たすかは未確認。SSE のオリジン応答の待ち時間（60 秒）は設計書のとおり**実装開始時に確認**が要る。
8. **初回の適用の順序**: `image` は ECR のダイジェスト固定が必須（変数の検査あり）だが、ECR は同じ Terraform が作る。先に ECR だけを作ってイメージを push する手順（または仮のイメージ）が要る。手順書は Step 3 以降。
9. 生成した秘密（3 つの鍵、DB のパスワード、オリジン検証値）は **Terraform の状態に入る**。状態のバケットの暗号化とアクセス制限が前提（beer-game2 と同じ）。
10. **`terraform plan` は未実行（認証情報が無い）**。データソース（`aws_availability_zones`、`aws_ec2_managed_prefix_list`、既存の OIDC プロバイダー）の解決、名前の長さの制限（ALB 32 文字: `beer-game-kotlin-production-api` = 31 文字）、RDS 18 のパラメータグループのファミリー `postgres18`、`engine_version = "18"` の受理などは、**`validate` では確認できていない**。
11. `tflint`・`checkov` は未実行（ローカルに無い）。静的検査は `fmt` と `validate` の範囲。

**AWS への適用の前に、人が確認すべき項目（別の承認ゲート）**

- **費用**: Multi-AZ の RDS（`db.t4g.small`）、Fargate（本番は 2〜4 タスク、各 1 vCPU / 2 GiB）、ALB、CloudFront、Secrets Manager（4 本）、CloudWatch Logs。月額の概算は未実施（AWS の料金表で確認が要る）。
- **アカウント**: 環境ごとのアカウントの分離（設計書の未決）、OIDC プロバイダーが既にあるか（`create_oidc_provider`）、状態用の S3 バケットの作成（暗号化・バージョニング・パブリックアクセスのブロック）。
- **ドメイン**: 本番の独自ドメインと、us-east-1 の ACM 証明書、DNS の管理者。
- **IAM**: デプロイロールの権限（`RegisterTaskDefinition`・`RunTask` はリソースを絞れていない）、`iam:PassRole` の対象、OIDC の信頼の条件（リポジトリと GitHub Environment 名）。
- **セキュリティ**: ECS を公開サブネットに置く判断、ALB が HTTP（CloudFront からのみ到達、合言葉のヘッダー）である点、RDS の SSL 必須、秘密が状態に入る点、DB ロールの分離の方針。
- 上の「設計書との食い違い・未決・未確認」の 1〜11。

### Step 3: デプロイ・ロールバックの定義とスモークテスト（🟢）

- [x] 3.1 CI/CD の定義（ビルド → ECR への push → マイグレーション → ECS の更新 → スモークテスト → 失敗時のロールバック）。**`workflow_dispatch` のみ**（自動で起動しない）。AWS の資格は OIDC（秘密を持たない）。**実行しない**
- [x] 3.2 スモークテストの手順（ローカルのコンテナで実行できるもの）と、ロールバックの手順（直前のタスク定義へ戻す。マイグレーションの前方互換の注意: 読む版 → 書く版の 2 段階リリース）を、運用の文書にまとめる

**ゲート 3**: デプロイ・ロールバックの定義を、人が確認する（**本番環境・デプロイ設定は確認必須**）。**状態: 人の確認待ち（未承認）。**

#### Step 3 の結果（2026-11-15。AWS には接続・実行していない。ワークフローは一度も起動していない）

**成果物**

| 種別 | ファイル |
| :--- | :--- |
| ワークフロー（新規 4 本。`workflow_dispatch` のみ） | `.github/workflows/beer-game-kotlin-deploy-staging.yml`、`-deploy-production.yml`、`-rollback-staging.yml`、`-rollback-production.yml` |
| ワークフロー（既存に追加） | `.github/workflows/beer-game-kotlin.yml` に `container` ジョブ（`docker build` と `scripts/container-smoke.sh`。自動で起動。検証のみ・AWS 無関係。`timeout-minutes: 30`） |
| 運用の手順書（新規） | `docs/operation/beer-game-kotlin/deploy.md`、`rollback.md`、`container_local.md`（`index.md` と `mkdocs.yml` の nav に登録） |

**設計**: デプロイは、ビルド → ECR（不変タグ、以降ダイジェスト固定）→ タスク定義の登録（api と migrate）→ **migrate（1 回限りの ECS タスク。終了コード 0 でなければ中止）** → api の更新（ローリング + サーキットブレーカー）→ 静的ファイル（`web/dist` を S3 の `releases/<SHA>/` から `current/`）→ スモークテスト → 履歴の記録。失敗時は、直前のタスク定義と静的ファイルの版へ自動で戻す（マイグレーションは戻さない）。本番はステージングのダイジェストを昇格（ビルドしない）。ロールバックは、履歴（S3 の `deployments/`）から選び、`confirm_compatible`（旧イメージが現在のイベントを読めることの確認）を必須入力にした。2 段階リリース（NF-O11、N-1 互換）と戻せないケースは、ワークフローのコメントと `rollback.md` に記載。値（ロール ARN・リージョン・クラスタ名など）はすべて `vars` から取り、ワークフローに書いていない。

**検証の結果（実測）**

| 検証 | 結果 |
| :--- | :--- |
| 5 本の YAML の構文（`ruby -ryaml`） | すべて成功 |
| トリガー | デプロイ 2 本・ロールバック 2 本は **`workflow_dispatch` のみ**（`push`・`pull_request`・`schedule` なし。`push` はデプロイ（staging）にコメントアウトで残した）。`beer-game-kotlin.yml` は `pull_request`・`push`・`workflow_dispatch`（`container` ジョブを追加） |
| コンテナのスモークテスト | `SKIP_BUILD=1 RUNS=1 IMAGE=beer-game-kotlin:smoke ./scripts/container-smoke.sh` を実行: **全項目成功**（api の `/api/v1/ready`・`/api/v1/health` が 200、HEALTHCHECK が healthy、migrate が終了コード 0、秘密なし・H2 の拒否は 78、未実装モードは 69、非 root、SIGTERM は 143）。起動時間 5775 ms（1 回） |
| `actionlint`・`shellcheck` | ローカルに無く**未実行** |
| `apps/beer-game-kotlin/` | 変更なし（スクリプトの修正は不要だった） |

**AWS で実行していない**: デプロイ・ロールバックのワークフローは、AWS・ECR・GitHub Actions のいずれでも実行していない。OIDC、`aws ecs`、`aws s3` の呼び出しの動作は未確認。

**人が AWS 適用時に設定するもの**

- GitHub Environment: `staging`、`production`（名前は OIDC の信頼の条件と一致させる）。**`production` には必須のレビュアー（保護ルール）**。
- Variables（両環境）: `AWS_ROLE_ARN`（`deploy_role_arn`）、`AWS_REGION`、`ECR_REPOSITORY`、`ECS_CLUSTER`、`ECS_SERVICE`、`API_TASK_FAMILY`、`MIGRATE_TASK_FAMILY`、`WEB_BUCKET`、`DISTRIBUTION_ID`、`TASK_SG`（`task_security_group_id`）、`TASK_SUBNETS`（`task_subnet_ids` をカンマ区切り）、`STAGING_URL`（staging）・`PRODUCTION_URL`（production）。本番はさらに `STAGING_ECR_REPOSITORY`。Secrets は使わない。
- 本番のデプロイロールに、ステージングの ECR の読み取りを許可（昇格のため。**Step 2 の `github_oidc` の権限は、自環境の ECR のみで、未対応**）。
- 前提の AWS 準備（アカウント、OIDC プロバイダー、状態用 S3、ドメイン、Terraform の適用順）は、Step 2 の「AWS への適用の前に、人が確認すべき項目」を参照。手順書には創作していない。

**設計書との食い違い・未決・未確認**

1. 設計書は本番を「ブルー/グリーン（CodeDeploy）」とするが、Step 2 の Terraform はローリング更新（サーキットブレーカー）で、ワークフローも合わせた。**どちらにするかは未決**。
2. 設計のスモークテストは「作成・参加・SSE・ポーリング・自動確定」だが、デプロイ後は **`/api/v1/ready` と `/api/v1/health` の確認だけ**。業務のスモークは**未実装**。
3. Step 2 のデプロイロールの権限と、ワークフローの呼び出しの**突合は未実施**（例: 昇格に要る `ecr:BatchGetImage` の他環境への許可、`ecs:RunTask` の `iam:PassRole`、`ecs:DescribeTasks`、ログの読み取り）。権限不足は AWS での実行で初めて分かる。
4. 初回のデプロイ: `image` は ECR のダイジェスト固定が必須だが、ECR は同じ Terraform が作る（Step 2 の未決 8）。先に ECR だけを作る手順は、**まだ手順書に書いていない**（Step 2 の項目を参照するにとどめた）。
5. ステージングと本番の ECR が同一アカウントであること（昇格）は**未確認の前提**。
6. 2 段階リリースの「書く版」を設定で切り替える仕組み（設計の未決）は未実装。N-1 互換の CI ジョブは雛形のまま。
7. `aws-actions/configure-aws-credentials@v5`、`amazon-ecr-login@v2`、`setup-java`、`gradle/actions` は SHA を確認できておらず**版のタグ（未固定）**。`checkout`・`setup-node` は既存の固定済みの SHA を再利用。
8. CI の `container` ジョブの所要は、ローカルの実測（初回ビルド約 6 分、スモークテスト数分）からの見積もりで、GitHub Actions 上の実行は**未確認**。
9. 履歴を S3 の Web バケットの `deployments/` に置く設計（beer-game2 の踏襲）は、Step 2 の IAM（`WebBucket` の権限）で足りる見込みだが、バケットポリシーとの突合は未確認。静的ファイルの公開先は、CloudFront のオリジンの設定（`current/`）との整合が未確認。

### Step 4: 検証と終了（✅）

- [ ] 4.1 全テストと静的解析（B2 の工程）が緑のままであること。コンテナのスモークテストの結果
- [ ] 4.2 設計書（インフラ設計、運用要件）の更新と、`validating-design` の完了時の実施。Bolt 終了報告（`bolt_3_report.md`）。人の確認待ちの項目と、**AWS への適用の判断（別ゲート）**の一覧

---

## 完了条件（Definition of Done）

- [ ] コンテナがビルドでき、ローカルでスモークテストが通る（`api`・`migrate`、H2 の拒否、秘密が無ければ起動失敗）。起動時間を計測した
- [ ] Terraform の定義があり、`terraform fmt -check` と `validate` が通る。**`plan` は未実行（認証情報が無い）と記録**されている
- [ ] デプロイ・ロールバックの定義があり、**自動で起動しない**（`workflow_dispatch` のみ）。**AWS には適用していない**ことが明記されている
- [ ] `validating-design` を実施済み
- [ ] コードを、人が全行理解して承認した（**未実施。人の確認待ち**）。AWS への適用は、**別の承認ゲート**で判断する

## リスクと対策

| リスク | 影響 | 対策 |
| :--- | :---: | :--- |
| ローカルの Terraform が古く（1.5.7）、`validate` が設計の版で行えない | 中 | 作業用に、公式の配布から新しい版を取得して使う（システムの入れ替えはしない） |
| `terraform plan` が認証情報なしで実行できない | 中 | 未実行として記録し、AWS 適用のゲートで確認する |
| 定義が誤って、実際の AWS に作用する | 高 | `apply` を実行しない。ワークフローは `workflow_dispatch` のみ。秘密を含めない |
| JVM の起動が遅く、目標（p95 30 秒）を超える | 中 | 計測して記録。超える場合は、CPU・メモリ・ヘルスチェックの猶予で調整案を出す |

## 更新履歴

| 日付 | 更新内容 | 更新者 |
| :--- | :--- | :--- |
| 2026-11-15 | 初版作成（AI が提案。**ステップ計画は人の承認待ち**。ゴール U1 に従い実行を開始） | claude-code/claude-sonnet-5-5 |
