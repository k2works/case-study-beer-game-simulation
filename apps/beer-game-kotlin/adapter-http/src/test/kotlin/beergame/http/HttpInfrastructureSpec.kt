package beergame.http

import beergame.application.Ports
import io.kotest.core.spec.style.FunSpec
import io.kotest.matchers.shouldBe
import io.kotest.matchers.string.shouldContain
import io.kotest.matchers.string.shouldNotContain
import io.ktor.client.HttpClient
import io.ktor.client.request.HttpRequestBuilder
import io.ktor.client.request.get
import io.ktor.client.request.header
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.client.statement.HttpResponse
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.contentType
import io.ktor.server.testing.ApplicationTestBuilder
import io.ktor.server.testing.testApplication
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.util.UUID

private const val API = "/api/v1"
private const val PROBLEM_JSON = "application/problem+json"
private const val KIT_BODY = """{"kind":"KIT","finalWeek":3,"demand":[4,4,8]}"""

private fun json(text: String): JsonObject = Json.parseToJsonElement(text).jsonObject

private fun JsonObject.str(name: String): String = getValue(name).jsonPrimitive.content

// Ktor の suspend 関数を呼ぶ土台は、suspend の関数型の値にする（detekt 1.23.8 が、Ktor の suspend 関数の呼び出しを検出できず、
// suspend の修飾を冗長と誤判定するのを避ける。`@Suppress` も設定の緩和も使わない）
private val readText: suspend HttpResponse.() -> String = { bodyAsText() }

private val postRequest: suspend HttpClient.(String, HttpRequestBuilder.() -> Unit) -> HttpResponse =
    { url, block -> post(url, block) }

private suspend fun HttpResponse.problem(): JsonObject = json(readText())

private class Harness(
    val ports: Ports = stubPorts(),
    val databaseUp: Boolean = true,
    val settings: HttpSettings = testSettings(),
    val logs: CapturingLogSink = CapturingLogSink(),
    val probeFails: Boolean = false,
)

private fun withApp(
    harness: Harness = Harness(),
    block: suspend ApplicationTestBuilder.(CapturingLogSink) -> Unit,
) = testApplication {
    application {
        beerGameModule(
            HttpDeps(
                ports = harness.ports,
                database =
                    DatabaseProbe {
                        check(!harness.probeFails) { "接続できない" }
                        harness.databaseUp
                    },
                settings = harness.settings,
                logs = harness.logs,
                clock = { FIXED_NOW },
            ),
        )
    }
    block(harness.logs)
}

private suspend fun ApplicationTestBuilder.createGame(
    body: String = KIT_BODY,
    key: String? = "k1",
    configure: HttpRequestBuilder.() -> Unit = {},
): HttpResponse =
    client.postRequest("$API/games") {
        key?.let { header("Idempotency-Key", it) }
        contentType(ContentType.Application.Json)
        setBody(body)
        configure()
    }

class HttpInfrastructureSpec :
    FunSpec({
        test("[US6.1/AC6.1.4] Given 資格なし When GET /health Then 200 の ok（データベースを見ない。生存だけ）") {
            withApp(Harness(databaseUp = false)) {
                val response = client.get("$API/health")

                response.status shouldBe HttpStatusCode.OK
                json(response.bodyAsText()).str("status") shouldBe "ok"
            }
        }

        test("[US6.1/AC6.1.4] Given データベースと通知の受信が生きている When GET /ready Then 200 の ok") {
            withApp {
                val response = client.get("$API/ready")

                response.status shouldBe HttpStatusCode.OK
                json(response.bodyAsText()).str("status") shouldBe "ok"
            }
        }

        test("[US6.1/AC6.1.4] Given データベースに接続できない When GET /ready Then 503（type つき）。/health は 200 のまま") {
            withApp(Harness(databaseUp = false)) {
                val ready = client.get("$API/ready")

                ready.status shouldBe HttpStatusCode.ServiceUnavailable
                ready.headers[HttpHeaders.ContentType]?.startsWith(PROBLEM_JSON) shouldBe true
                val body = ready.problem()
                body.str("type") shouldBe "/problems/app.not_ready"
                body.str("code") shouldBe "app.not_ready"
                body.getValue("checks").jsonObject.str("database") shouldBe "false"
                body.getValue("checks").jsonObject.str("notifier") shouldBe "true"
                client.get("$API/health").status shouldBe HttpStatusCode.OK
            }
        }

        test("[US6.1/AC6.1.4] Given 通知の受信が生きていない When GET /ready Then 503（ChangeNotifier.isAlive）") {
            withApp(Harness(ports = stubPorts(notifierAlive = false))) {
                val response = client.get("$API/ready")

                response.status shouldBe HttpStatusCode.ServiceUnavailable
                response
                    .problem()
                    .getValue("checks")
                    .jsonObject
                    .str("notifier") shouldBe "false"
            }
        }

        test("[US6.1/AC6.1.4] Given 確認の途中で例外が起きる When GET /ready Then 500 でなく 503（準備できていない）") {
            withApp(Harness(probeFails = true)) {
                val response = client.get("$API/ready")

                response.status shouldBe HttpStatusCode.ServiceUnavailable
                response.problem().str("code") shouldBe "app.not_ready"
            }
        }

        test("[NF-S9] Given どの応答（成功・失敗・存在しない経路） When 返す Then セキュリティヘッダーと相関 ID を付ける") {
            withApp {
                val responses =
                    listOf(
                        client.get("$API/health"),
                        client.get("$API/not-found"),
                        createGame(key = null),
                    )

                responses.forEach { response ->
                    response.headers["X-Content-Type-Options"] shouldBe "nosniff"
                    response.headers["Strict-Transport-Security"] shouldBe "max-age=31536000; includeSubDomains"
                    response.headers["Referrer-Policy"] shouldBe "no-referrer"
                    response.headers["Content-Security-Policy"] shouldBe "default-src 'none'; frame-ancestors 'none'"
                    response.headers["Cache-Control"] shouldBe "no-store"
                    UUID.fromString(response.headers["x-correlation-id"])
                }
            }
        }

        test("[NF-O2] Given 相関 ID（UUID）つきの要求 When 返す Then 同じ ID を応答と problem+json に返す。UUID でなければ作り直す") {
            withApp {
                val given = UUID.randomUUID().toString()
                val echoed = client.get("$API/not-found") { header("x-correlation-id", given) }
                val replaced = client.get("$API/not-found") { header("x-correlation-id", "../../etc/passwd") }

                echoed.headers["x-correlation-id"] shouldBe given
                echoed.problem().str("correlationId") shouldBe given
                (replaced.headers["x-correlation-id"] != "../../etc/passwd") shouldBe true
                UUID.fromString(replaced.headers["x-correlation-id"])
                replaced.problem().str("correlationId") shouldBe replaced.headers["x-correlation-id"]
            }
        }

        test("Given 存在しない経路・許可しない方法 When 要求する Then problem+json の 404・405（type を持つ）") {
            withApp {
                val missing = client.get("$API/nowhere")
                val wrongMethod = client.post("$API/health")

                missing.status shouldBe HttpStatusCode.NotFound
                missing.problem().str("type") shouldBe "/problems/request.not_found"
                wrongMethod.status shouldBe HttpStatusCode.MethodNotAllowed
                wrongMethod.problem().str("type") shouldBe "/problems/request.method_not_allowed"
            }
        }

        test("[NF-S8] Given 外部の Origin の変更系 When POST Then 403（資格の失敗と同じ本文）。許可した Origin は通る") {
            withApp {
                val foreign = createGame { header(HttpHeaders.Origin, "https://evil.example.org") }
                val own = createGame { header(HttpHeaders.Origin, "http://localhost:5173") }
                val noKey = createGame(key = null) { header(HttpHeaders.Origin, "https://evil.example.org") }

                foreign.status shouldBe HttpStatusCode.Forbidden
                foreign.problem().str("code") shouldBe "app.unauthorized"
                noKey.status shouldBe HttpStatusCode.Forbidden
                (own.status != HttpStatusCode.Forbidden) shouldBe true
            }
        }

        test("[NF-S8] Given 外部の Origin の読み取り（GET） When 要求する Then 検査しない（状態を変えない）") {
            withApp {
                client.get("$API/health") { header(HttpHeaders.Origin, "https://evil.example.org") }.status shouldBe
                    HttpStatusCode.OK
            }
        }

        test("[NF-S10] Given 64 KB を超える本文 When POST Then 413 で拒み、処理を始めない") {
            withApp {
                val tooLarge = createGame(body = "x".repeat(65_537))

                tooLarge.status shouldBe HttpStatusCode.PayloadTooLarge
                tooLarge.problem().str("type") shouldBe "/problems/request.too_large"
            }
        }

        test("[NF-S10] Given ちょうど 64 KB の本文 When POST Then サイズでは拒まない（次の検査へ進む）") {
            withApp {
                val boundary = createGame(body = "x".repeat(65_536))

                boundary.status shouldBe HttpStatusCode.BadRequest
                boundary.problem().str("code") shouldBe "validation.invalid_input"
            }
        }

        test("Given Idempotency-Key が無い変更系 When POST Then 400 で、キーが必要だと示す") {
            withApp {
                val response = createGame(key = null)

                response.status shouldBe HttpStatusCode.BadRequest
                response.problem().str("detail") shouldBe "Idempotency-Key ヘッダーが必要です。"
            }
        }

        test("Given 不正な Idempotency-Key（空・長すぎる・制御文字） When POST Then 400") {
            withApp {
                listOf("", "k".repeat(201), "a\tb").forEach { key ->
                    createGame(key = key).status shouldBe HttpStatusCode.BadRequest
                }
            }
        }

        test("[US1.1/AC1.1.2] Given 構文エラーの本文 When POST /games Then 400") {
            withApp {
                val response = createGame(body = "{")

                response.status shouldBe HttpStatusCode.BadRequest
                response.problem().str("code") shouldBe "validation.invalid_input"
            }
        }

        test("[US1.1/AC1.1.2] Given 項目の型が違う本文 When POST /games Then 422 で、項目ごとの誤りの配列") {
            withApp {
                val response = createGame(body = """{"kind":"KIT","finalWeek":"x","demand":[1.5]}""")

                response.status shouldBe HttpStatusCode.UnprocessableEntity
                response.headers[HttpHeaders.ContentType]?.startsWith(PROBLEM_JSON) shouldBe true
                val errors = response.problem().getValue("errors")
                errors.toString() shouldBe
                    """[{"field":"finalWeek","message":"整数で指定してください。"},""" +
                    """{"field":"demand","week":1,"message":"整数で指定してください。"}]"""
            }
        }

        test("[US6.1/AC6.1.2] Given 予期しない例外 When 処理する Then 500 の app.internal（内部の情報なし）。スタックと相関 ID を記録する") {
            val harness = Harness(ports = stubPorts(newId = { error("内部の秘密 db-password=hunter2") }))
            withApp(harness) { logs ->
                val response = createGame()

                response.status shouldBe HttpStatusCode.InternalServerError
                val body = response.problem()
                body.str("type") shouldBe "/problems/app.internal"
                body.str("code") shouldBe "app.internal"
                response.bodyAsText() shouldNotContain "hunter2"
                val correlation = response.headers["x-correlation-id"]
                val errorRecord = logs.all().single { it.level == "ERROR" }
                errorRecord.correlationId shouldBe correlation
                errorRecord.operation shouldBe "createGame"
                errorRecord.errorType shouldBe "java.lang.IllegalStateException"
                (errorRecord.stack ?: emptyList()).isNotEmpty() shouldBe true
                // 例外のメッセージ（秘密を含みうる）は、ログにも書かない
                logs.all().joinToString { Json.encodeToString(LogRecord.serializer(), it) } shouldNotContain "hunter2"
            }
        }

        test("[US6.1/AC6.1.1] Given 要求を処理した When ログを見る Then 相関 ID・操作・結果・状態・所要時間を持つ構造化ログ 1 件") {
            withApp { logs ->
                val response = createGame(body = "{")

                val record = logs.all().single()
                record.correlationId shouldBe response.headers["x-correlation-id"]
                record.operation shouldBe "createGame"
                record.status shouldBe 400
                record.result shouldBe "validation.invalid_input"
                record.level shouldBe "INFO"
                (record.durationMillis >= 0) shouldBe true
                record.timestamp shouldBe "2026-11-16T09:00:00Z"
            }
        }

        test(
            "[NF-S11] Given 1 分あたりの上限を超える要求 When 続ける Then 429 の app.rate_limited（Retry-After と type つき）。health は数えない",
        ) {
            withApp(Harness(settings = testSettings(rateLimitPerMinute = 2))) {
                createGame(body = "{").status shouldBe HttpStatusCode.BadRequest
                createGame(body = "{").status shouldBe HttpStatusCode.BadRequest
                val limited = createGame(body = "{")

                limited.status shouldBe HttpStatusCode.TooManyRequests
                limited.problem().str("type") shouldBe "/problems/app.rate_limited"
                ((limited.headers[HttpHeaders.RetryAfter]?.toInt() ?: 0) in 59..60) shouldBe true
                client.get("$API/health").status shouldBe HttpStatusCode.OK
                client.get("$API/ready").status shouldBe HttpStatusCode.OK
            }
        }

        test("[US1.1/AC1.1.2] Given 必須の項目（最終週・需要系列）が無い本文 When POST /games Then 422 で、欠けた項目を示す") {
            withApp {
                val response = createGame(body = """{"kind":"KIT"}""")

                response.status shouldBe HttpStatusCode.UnprocessableEntity
                response.problem().getValue("errors").toString() shouldContain "finalWeek"
                response.problem().getValue("errors").toString() shouldContain "demand"
            }
        }
    })
