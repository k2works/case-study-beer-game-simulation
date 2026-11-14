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

        listOf("retention", "rebuild-projections").forEach { mode ->
            test("[B3-1] Given 未実装の起動モード「$mode」 When 起動する Then 未実装の旨を記録し、終了コード 69 で終わる（設定を読む前に断る）") {
                val logs = Logs()

                val exit = runMain(listOf(mode), emptyMap(), logs)

                exit shouldBe 69
                val text = logs.text()
                text shouldContain mode
                text shouldContain "未実装"
                logs.records.single().result shouldBe "unimplemented"
                logs.records.single().level shouldBe "ERROR"
            }
        }

        test("Given 不明な起動モード When 起動する Then 使えるモードを全て案内する") {
            val logs = Logs()

            runMain(listOf("unknown"), local(), logs) shouldBe 64

            val text = logs.text()
            listOf("api", "migrate", "retention", "rebuild-projections").forEach { text shouldContain it }
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
