package beergame.app

import beergame.application.AlarmCatalog
import io.kotest.core.spec.style.FunSpec
import io.kotest.matchers.shouldBe
import io.kotest.matchers.string.shouldContain
import io.kotest.matchers.string.shouldNotContain
import java.io.File
import java.util.concurrent.TimeUnit

/*
 * B14 の本番の定義の検査（AC6.2.1〜AC6.2.5、NF-S9、NF-S15、NF-R4、NF-O11）。AWS には適用しないので、
 * 定義（Terraform・ワークフロー・手順のスクリプト）が、アプリの実装・アラームの表・設計の値と一致していることを、ファイルを読んで検査する。
 */

private val APP = File("..")
private val WORKFLOWS = File("../../../.github/workflows")
private const val SCRIPT_TIMEOUT_SECONDS = 20L
private const val HSTS_MAX_AGE = 31_536_000
private const val TARGET_GROUP_NAME_LIMIT = 32

/** Terraform の定義。`terraform fmt` の桁そろえに左右されないよう、連続する空白は 1 つにする。 */
private fun infra(path: String): String = File(APP, "infra/$path").readText().replace(Regex("[ \t]+"), " ")

private fun workflow(name: String): String = File(WORKFLOWS, name).readText()

private fun quoted(text: String): Set<String> = Regex("\"([a-z-]+)\"").findAll(text).map { it.groupValues[1] }.toSet()

/** ワークフローの `on:` の直下のキー（`  push:` など。コメントは含めない）。 */
private fun triggers(text: String): Set<String> =
    text
        .substringAfter("\non:\n")
        .lineSequence()
        .takeWhile { it.isEmpty() || it.startsWith(" ") }
        .mapNotNull { Regex("^ {2}([a-z_]+):").find(it)?.groupValues?.get(1) }
        .toSet()

private data class ScriptResult(
    val exitCode: Int,
    val output: String,
)

private fun runRestoreScript(vararg args: String): ScriptResult {
    val process =
        ProcessBuilder(listOf("bash", File(APP, "scripts/restore-pitr.sh").path) + args)
            .redirectErrorStream(true)
            .start()
    val output = process.inputStream.bufferedReader().readText()
    process.waitFor(SCRIPT_TIMEOUT_SECONDS, TimeUnit.SECONDS)
    return ScriptResult(process.exitValue(), output)
}

class ProductionDefinitionSpec :
    FunSpec({
        context("定期のタスク（B11・B12・B14）") {
            val ecs = infra("modules/ecs/main.tf")
            val variables = infra("modules/ecs/variables.tf")

            test("[AC6.2.1] Given ECS のタスク定義 When 起動モードを集める Then アプリの Main.kt の MODES と同じ（5 つ）") {
                val modes =
                    quoted(
                        File(
                            APP,
                            "app/src/main/kotlin/beergame/app/Main.kt",
                        ).readText().substringAfter("MODES = setOf(").substringBefore(")"),
                    )
                val defined = Regex("command\\s*=\\s*\\[\"([a-z-]+)\"]").findAll(ecs).map { it.groupValues[1] }.toSet()

                defined shouldBe modes
                modes.size shouldBe 5
            }

            test("[AC6.2.1] Given スケジュール When 対象を見る Then 起動するのは retention と verify-projections だけ。再構築は人が手動で走らせる") {
                val schedules = ecs.substringAfter("schedules = {").substringBefore("}")

                quoted(schedules) shouldBe setOf("retention", "verify-projections")
                ecs shouldContain "for key in [\"retention\", \"verify-projections\"]"
            }

            test(
                "[AC5.1.2] Given retention のタスク When 環境を見る Then 削除用のロール beergame_deleter へ SET ROLE する",
            ) {
                ecs shouldContain "{ name = \"DB_DELETER_ROLE\", value = var.deleter_role }"
                variables.substringAfter("variable \"deleter_role\"") shouldContain "default = \"beergame_deleter\""
            }

            test("[B11] Given スケジュールの既定 When 見る Then 保持は 5 分ごと、整合の検査は日次（UTC 18:00 = 日本時間 03:00。研修のない時間）") {
                variables.substringAfter("variable \"retention_schedule\"") shouldContain
                    "default = \"rate(5 minutes)\""
                variables.substringAfter("variable \"verify_schedule\"") shouldContain
                    "default = \"cron(0 18 * * ? *)\""
            }

            test("[NF-O4] Given 心拍のアラーム When 見る Then 検査の周期より長く、結果のメトリクスの欠測で発報する") {
                val verify = AlarmCatalog.named("projection-verify-heartbeat")
                val retention = AlarmCatalog.named("retention-heartbeat")

                verify.window.periodSeconds shouldBe 86_400
                retention.window.periodSeconds shouldBe 3_600
                (retention.window.periodSeconds > 2 * 300) shouldBe true
            }

            test("[NF-O11] Given 失敗の通知 When 見る Then スケジュールは再試行しない（心拍で知る。同じ起動を重ねない）") {
                ecs shouldContain "maximum_retry_attempts = 0"
            }
        }

        context("ブルー/グリーン（AC6.2.2・AC6.2.3）") {
            val production = infra("envs/production/main.tf")
            val staging = infra("envs/staging/main.tf")
            val ecs = infra("modules/ecs/main.tf")
            val alarms = infra("modules/observability/alarms.tf")

            test("[AC6.2.2] Given 環境 When 更新方式を見る Then 本番は BLUE_GREEN、ステージングは既定のローリング") {
                production shouldContain "deployment_strategy = \"BLUE_GREEN\""
                staging shouldNotContain "BLUE_GREEN"
            }

            test("[AC6.2.3] Given ECS のサービス When 見る Then サーキットブレーカーはローリングのときだけ。ブルー/グリーンは待ち時間とアラームで戻す") {
                ecs shouldContain "for_each = var.deployment_strategy == \"ROLLING\" ? [1] : []"
                ecs shouldContain "for_each = var.deployment_strategy == \"BLUE_GREEN\" ? [1] : []"
                ecs shouldContain "rollback = true"
            }

            test("[AC6.2.3] Given 本番の戻しのアラーム When 名前を見る Then 実在する重大のアラーム（5xx・正常なタスク 0）") {
                val names =
                    Regex(
                        "\"\\\$\\{local.name}-([a-z0-9-]+)\"",
                    ).findAll(production.substringAfter("deployment_alarm_names"))
                        .map {
                            it.groupValues[1]
                        }.toList()

                names shouldBe listOf("http-5xx-rate-critical", "no-healthy-targets")
                AlarmCatalog.named("http-5xx-rate-critical").severity.name shouldBe "CRITICAL"
                alarms shouldContain "\"\${var.name}-no-healthy-targets\""
            }

            test("[AC6.2.3] Given 2 つの対象グループ When 正常数のアラームを見る Then 両方の最大を見る（使っていない側が 0 でも誤報しない）") {
                alarms shouldContain "MAX(["
                production shouldContain
                    "alternate_target_group_arn_suffix = module.alb.alternate_target_group_arn_suffix"
            }

            test("[AC6.2.2] Given 本番の名前 When 対象グループの名前を作る Then 32 文字の上限に収まる") {
                ("beer-game-kotlin-production" + "-api2").length shouldBe TARGET_GROUP_NAME_LIMIT
            }
        }

        context("TLS・セキュリティヘッダー（NF-S9・NF-S15）") {
            val web = infra("modules/web/main.tf")
            val api = File(APP, "adapter-http/src/main/kotlin/beergame/http/Observability.kt").readText()

            test(
                "[NF-S9] Given CloudFront のヘッダーポリシー When 見る Then HSTS（1 年）、nosniff、DENY、CSP、Permissions-Policy",
            ) {
                web shouldContain "access_control_max_age_sec = $HSTS_MAX_AGE"
                web shouldContain "include_subdomains = true"
                web shouldContain "content_type_options"
                web shouldContain "frame_option = \"DENY\""
                web shouldContain "frame-ancestors 'none'"
                web shouldContain "default-src 'self'"
                web shouldContain "Permissions-Policy"
            }

            test(
                "[NF-S9] Given API と CloudFront When HSTS を比べる Then 同じ max-age（アプリ側は HttpInfrastructureSpec）",
            ) {
                api shouldContain "max-age=$HSTS_MAX_AGE; includeSubDomains"
            }

            test("[NF-S15] Given 独自ドメイン When 視聴者の証明書を見る Then ACM の証明書で TLS 1.2 以上（TLSv1.2_2021）。HTTP は https へ寄せる") {
                web shouldContain "\"TLSv1.2_2021\""
                web shouldContain "viewer_protocol_policy = \"redirect-to-https\""
                web shouldContain "viewer_protocol_policy = \"https-only\""
            }

            test("[NF-S15] Given 本番 When ドメインを見る Then 必須で、証明書はドメインのモジュール（us-east-1）が作る") {
                val production = infra("envs/production/main.tf")
                val variables = infra("envs/production/variables.tf")

                variables shouldContain "本番では独自ドメインが必須です"
                production shouldContain "acm_certificate_arn = module.domain.certificate_arn"
                infra("modules/domain/main.tf") shouldContain "provider = aws.us_east_1"
            }
        }

        context("復元（AC6.2.5・NF-R3・NF-R4）") {
            val rds = infra("modules/rds/main.tf")
            val production = infra("envs/production/main.tf")

            test("[AC6.2.5] Given RDS When バックアップを見る Then 自動バックアップ 7 日（時点復旧）、暗号化、バックアップの時間は日次の検査の前") {
                rds shouldContain "backup_retention_period = 7"
                rds shouldContain "storage_encrypted = true"
                infra("modules/rds/variables.tf") shouldContain "default = \"17:00-17:30\""
            }

            test("[NF-R3] Given 本番の RDS When 見る Then Multi-AZ の同期スタンバイ、削除保護、最終スナップショットあり") {
                production shouldContain "multi_az = true"
                production shouldContain "deletion_protection = true"
                production shouldContain "skip_final_snapshot = false"
            }

            test("[AC6.2.5] Given 復元のスクリプト When ドライランする Then 復元・待機・切り替え・確認の手順を表示し、AWS には何もしない") {
                val result =
                    runRestoreScript(
                        "--instance",
                        "db-a",
                        "--new-instance",
                        "db-b",
                        "--target-time",
                        "2026-12-01T10:00:00Z",
                    )

                result.exitCode shouldBe 0
                result.output shouldContain
                    "aws rds restore-db-instance-to-point-in-time --source-db-instance-identifier db-a " +
                    "--restore-time 2026-12-01T10:00:00Z --db-instance-identifier db-b"
                result.output shouldContain "aws rds wait db-instance-available --db-instance-identifier db-b"
                result.output shouldContain "（ドライラン: 実行していません。"
                result.output shouldContain "保持削除を 1 回実行する"
                result.output shouldContain "verify-projections"
            }

            test("[AC6.2.5] Given スナップショットの指定 When ドライランする Then スナップショットから復元するコマンドになる") {
                val result =
                    runRestoreScript("--instance", "db-a", "--new-instance", "db-b", "--snapshot", "db-a-pre-0123abcd")

                result.exitCode shouldBe 0
                result.output shouldContain
                    "aws rds restore-db-instance-from-db-snapshot --db-snapshot-identifier db-a-pre-0123abcd"
            }

            test("[AC6.2.5] Given 不正な指定 When 実行する Then 終了コード 2（復元先が元と同じ、時刻の形式が違う、指定が無い）") {
                runRestoreScript("--instance", "db-a", "--new-instance", "db-a", "--latest").exitCode shouldBe 2
                runRestoreScript(
                    "--instance",
                    "db-a",
                    "--new-instance",
                    "db-b",
                    "--target-time",
                    "昨日",
                ).exitCode shouldBe
                    2
                runRestoreScript("--instance", "db-a", "--new-instance", "db-b").exitCode shouldBe 2
            }
        }

        context("デプロイの定義（AC6.2.1・AC6.2.2）") {
            val staging = workflow("beer-game-kotlin-deploy-staging.yml")
            val production = workflow("beer-game-kotlin-deploy-production.yml")

            test("[AC6.2.1] Given ステージングのデプロイ When 起動を見る Then main の CI の成功後に自動。有効化は変数（未設定の間は飛ばす）") {
                triggers(staging) shouldBe setOf("workflow_dispatch", "workflow_run")
                staging shouldContain "vars.BEER_GAME_KOTLIN_AUTO_DEPLOY == 'true'"
                staging shouldContain "workflows: [beer-game-kotlin]"
                staging shouldContain "branches: [main]"
            }

            test("[AC6.2.2] Given 本番のデプロイ When 起動を見る Then 手動のみ（push・schedule・workflow_run なし）で、保護された環境、ダイジェスト指定") {
                triggers(production) shouldBe setOf("workflow_dispatch")
                production shouldContain "environment: production"
                production shouldContain "digest:"
                production shouldContain "同じダイジェストのイメージを本番の ECR へ昇格"
            }

            test("[AC6.2.5] Given 本番のデプロイ When 順序を見る Then スナップショット（復元点）の後に、マイグレーション") {
                val snapshot = production.indexOf("デプロイ前のスナップショット")
                val migrate = production.indexOf("name: マイグレーション（migrate タスク）")

                (snapshot in 1 until migrate) shouldBe true
            }

            test("[NF-S16] Given 手動のスナップショット When 保持を見る Then 7 日を過ぎたものを消す（削除後のバックアップは最大 7 日）") {
                production shouldContain "7 days ago"
                production shouldContain "aws rds delete-db-snapshot"
                infra("modules/github_oidc/main.tf") shouldContain "rds:DeleteDBSnapshot"
            }

            test("[AC6.2.4] Given デプロイ When 順序を見る Then マイグレーションの失敗では api を更新しない（拡張 → 互換 → 縮小）") {
                production shouldContain "デプロイを中止します"
                (production.indexOf("name: マイグレーション") < production.indexOf("name: api サービスの更新")) shouldBe true
            }

            test(
                "[AC6.2.3] Given 4 つのワークフロー When 定期のタスクを見る Then デプロイもロールバックも、retention・verify-projections を同じイメージへそろえる",
            ) {
                val names = listOf("deploy-staging", "deploy-production", "rollback-staging", "rollback-production")
                names.forEach { name ->
                    val text = workflow("beer-game-kotlin-$name.yml")
                    text shouldContain "RETENTION_TASK_FAMILY"
                    text shouldContain "VERIFY_TASK_FAMILY"
                }
            }
        }
    })
