package beergame.app

import beergame.http.LogRecord
import beergame.http.LogSink
import io.kotest.core.spec.style.FunSpec
import io.kotest.matchers.shouldBe
import io.kotest.matchers.string.shouldContain
import io.kotest.matchers.string.shouldNotContain
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.util.Base64
import java.util.UUID

private class Logs : LogSink {
    val records = java.util.concurrent.CopyOnWriteArrayList<LogRecord>()

    override fun emit(record: LogRecord) {
        records += record
    }

    fun text(): String = records.joinToString("\n") { it.toJsonLine() }
}

private fun local(vararg extra: Pair<String, String>): Map<String, String> =
    mapOf(
        "APP_ENV" to "local",
        "DB_KIND" to "h2",
        "PORT" to "0",
        "DB_URL" to "jdbc:h2:mem:${UUID.randomUUID()};MODE=PostgreSQL;DATABASE_TO_LOWER=TRUE;DB_CLOSE_DELAY=-1",
    ) + extra

private fun get(
    port: Int,
    path: String,
): HttpResponse<String> =
    HttpClient
        .newHttpClient()
        .send(HttpRequest.newBuilder(URI("http://127.0.0.1:$port$path")).build(), HttpResponse.BodyHandlers.ofString())

class MainSpec :
    FunSpec({
        test("[NF-S3] Given 本番相当の設定で秘密情報が無い When 起動する Then 終了コード 78 で、サーバーを起動しない。ログに足りない設定の名前が出る（値は出ない）") {
            val logs = Logs()
            val env = mapOf("APP_ENV" to "production", "DB_KIND" to "postgres", "DB_PASSWORD" to "hunter2-password")

            val exit = runMain(listOf("api"), env, logs)

            exit shouldBe 78
            val text = logs.text()
            text shouldContain "CREDENTIAL_KEY"
            text shouldContain "IDEMPOTENCY_KEY"
            text shouldContain "RESPONSE_KEY"
            text shouldNotContain "hunter2"
            logs.records.single().level shouldBe "ERROR"
        }

        test("[7.6] Given production で DB_KIND=h2 When 起動する Then 終了コード 78（H2 を許さない）") {
            val logs = Logs()
            val secrets =
                listOf("CREDENTIAL_KEY", "IDEMPOTENCY_KEY", "RESPONSE_KEY")
                    .mapIndexed { i, name ->
                        name to
                            Base64.getEncoder().encodeToString(ByteArray(32) { (it + i).toByte() })
                    }.toMap()
            val env =
                mapOf("APP_ENV" to "production", "DB_KIND" to "h2", "ALLOWED_ORIGINS" to "https://beer.example.com") +
                    secrets

            val exit = runMain(listOf("api"), env, logs)

            exit shouldBe 78
            logs.text() shouldContain "H2"
        }

        test("Given 不明な起動モード When 起動する Then 終了コード 64") {
            runMain(listOf("unknown"), local(), Logs()) shouldBe 64
        }

        test("[B11/AC5.1.2] Given マイグレーション済みの local When retention モードを実行する Then 削除する対象が無くても 0 で終わり、結果を記録する") {
            val env = local()
            runMain(listOf("migrate"), env, Logs()) shouldBe 0
            val logs = Logs()

            runMain(listOf("retention"), env, logs) shouldBe 0

            logs.records.single().operation shouldBe "retention"
            logs.text() shouldContain "削除 0 件"
        }

        test("[B11/NF-R12] Given マイグレーション前の local When retention モードを実行する Then 掃引できず 70 で終わる（次の起動で再試行する）") {
            val logs = Logs()

            runMain(listOf("retention"), local(), logs) shouldBe 70

            logs.records.single().level shouldBe "ERROR"
            logs.records.single().operation shouldBe "retention"
        }

        test("[B12/NF-R15] Given マイグレーション済みの local When rebuild-projections モードを実行する Then ゲームが無くても 0 で終わり、結果を記録する") {
            val env = local()
            runMain(listOf("migrate"), env, Logs()) shouldBe 0
            val logs = Logs()

            runMain(listOf("rebuild-projections"), env, logs) shouldBe 0

            logs.records.single().operation shouldBe "rebuild-projections"
            logs.text() shouldContain "再構築 0 ゲーム"
        }

        test("[B12] Given 形が不正なゲーム ID When rebuild-projections モードを実行する Then DB に触れず 64 で終わる") {
            val logs = Logs()

            runMain(listOf("rebuild-projections", "not-a-uuid"), local(), logs) shouldBe 64

            logs.records.single().result shouldBe "usage"
            logs.text() shouldContain "not-a-uuid"
        }

        test("[B12] Given 存在しないゲーム ID When rebuild-projections モードを実行する Then そのゲームの失敗を記録し 1 で終わる") {
            val env = local()
            runMain(listOf("migrate"), env, Logs()) shouldBe 0
            val logs = Logs()

            runMain(listOf("rebuild-projections", UUID.randomUUID().toString()), env, logs) shouldBe 1

            logs.records.map { it.result } shouldBe listOf("game.failed", "ok")
        }

        test(
            "[B12/NF-R12] Given マイグレーション前の local When 再構築と検査のモードを実行する Then 一覧を読めず 70 で終わる",
        ) {
            listOf("rebuild-projections", "verify-projections").forEach { mode ->
                val logs = Logs()

                runMain(listOf(mode), local(), logs) shouldBe 70

                logs.records.single().level shouldBe "ERROR"
                logs.records.single().operation shouldBe mode
            }
        }

        test("[B12/NF-R15] Given マイグレーション済みの local When verify-projections モードを実行する Then ゲームが無ければ不一致 0 で、0 で終わる") {
            val env = local()
            runMain(listOf("migrate"), env, Logs()) shouldBe 0
            val logs = Logs()

            runMain(listOf("verify-projections"), env, logs) shouldBe 0

            logs.records.single().operation shouldBe "verify-projections"
            logs.text() shouldContain "不一致 0"
        }

        test("Given 不明な起動モード When 起動する Then 使えるモードを全て案内する") {
            val logs = Logs()

            runMain(listOf("unknown"), local(), logs) shouldBe 64

            val text = logs.text()
            listOf("api", "migrate", "retention", "rebuild-projections", "verify-projections").forEach {
                text shouldContain it
            }
        }

        test("[US6.1] Given local の migrate モード When 実行する Then マイグレーションを適用して 0 で終わる") {
            val logs = Logs()

            runMain(listOf("migrate"), local(), logs) shouldBe 0

            logs.text() shouldContain "マイグレーションを適用しました"
        }

        test("[US6.1] Given local（H2）の設定 When 起動する Then 実際のソケットで、/health・/ready が 200 を返す。H2 の起動は警告として記録される") {
            val logs = Logs()

            startApi(parseLocal(), logs).use { running ->
                val ready = get(running.port, "/api/v1/ready")
                val health = get(running.port, "/api/v1/health")

                ready.statusCode() shouldBe 200
                health.statusCode() shouldBe 200
                ready.headers().firstValue("x-correlation-id").isPresent shouldBe true
                ready.headers().firstValue("X-Content-Type-Options").get() shouldBe "nosniff"
            }

            val startup = logs.records.first { it.operation == "startup" }
            startup.level shouldBe "WARN"
            val message = checkNotNull(startup.message) { "startup のメッセージがない" }
            message shouldContain "APP_ENV=local"
            message shouldContain "DB_KIND=h2"
        }
    })

private fun parseLocal(): ServerConfig =
    when (val loaded = ServerConfig.load(local())) {
        is arrow.core.Either.Right -> loaded.value
        is arrow.core.Either.Left -> error("読み込めるはず: ${loaded.value}")
    }
