package beergame.http

import arrow.core.Either
import arrow.core.right
import beergame.application.AppFailure
import beergame.application.AttemptStore
import beergame.application.AttemptWindow
import beergame.application.TransactionRunner
import beergame.application.Tx
import io.kotest.core.spec.style.FunSpec
import io.kotest.matchers.shouldBe
import io.kotest.matchers.string.shouldMatch
import io.kotest.matchers.string.shouldNotContain
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
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.util.concurrent.CopyOnWriteArrayList

/*
 * 参加の専用のレート制限の HTTP の層（B5 Step 5。NF-S11・NF-S19）。上限を超えた接続元は 429（app.rate_limited）、
 * 形式が不正な本文は窓に数えない（窓の保存に触れない）、ログには接続元の鍵付き要約（src）だけを載せる。
 * 窓の数え方の本体は application（AttemptLimitSpec）と永続化の契約にある。
 */

private const val API = "/api/v1"
private const val JOIN_BODY = """{"joinCode":"JOIN-0001","displayName":"花子"}"""

/** ブロックをそのまま呼ぶ（永続化のないトランザクション）。 */
private object PassThroughTx : TransactionRunner {
    override suspend fun <A> invoke(block: suspend (Tx) -> Either<AppFailure, A>): Either<AppFailure, A> =
        block(object : Tx {})
}

/** 窓の保存の差し替え。charge が返す数は [count]。呼ばれた窓を [seen] に残す。 */
private class FakeAttempts(
    private val count: Int,
) {
    val seen = CopyOnWriteArrayList<AttemptWindow>()

    val store =
        AttemptStore(
            charge = { _, window ->
                seen += window
                count.right()
            },
            refund = { _, _ -> Unit.right() },
            purge = { _, _ -> Unit.right() },
        )
}

private fun withApp(
    attempts: AttemptStore,
    logs: CapturingLogSink = CapturingLogSink(),
    block: suspend ApplicationTestBuilder.(CapturingLogSink) -> Unit,
) = testApplication {
    application {
        beerGameModule(
            HttpDeps(
                ports = stubPorts(attempts = attempts, transaction = PassThroughTx),
                database = DatabaseProbe { true },
                settings = testSettings(),
                logs = logs,
                clock = { FIXED_NOW },
            ),
        )
    }
    block(logs)
}

private val postJoin: suspend ApplicationTestBuilder.(String) -> HttpResponse = { body ->
    client.post("$API/participations/join") {
        header("Idempotency-Key", "join-key")
        contentType(ContentType.Application.Json)
        setBody(body)
    }
}

private val readText: suspend HttpResponse.() -> String = { bodyAsText() }

class AttemptRoutesSpec :
    FunSpec({
        test("[5.1][NF-S11] Given 窓が上限を超えた接続元 When 参加する Then 429 の app.rate_limited（Retry-After つき）。参加コードの検査には進まない") {
            val attempts = FakeAttempts(count = ATTEMPT_POLICY.maxFailures + 1)
            withApp(attempts.store) {
                val response = postJoin(JOIN_BODY)

                response.status shouldBe HttpStatusCode.TooManyRequests
                response.headers[HttpHeaders.RetryAfter] shouldBe ATTEMPT_POLICY.window.seconds.toString()
                val problem = Json.parseToJsonElement(response.readText()).jsonObject
                problem.getValue("code").jsonPrimitive.content shouldBe "app.rate_limited"
                problem.getValue("type").jsonPrimitive.content shouldBe "/problems/app.rate_limited"
            }
        }

        test("[5.1] Given 形式が不正な本文 When 参加する Then 422 または 400 で、窓の保存に触れない（窓に数えない）") {
            withApp(NO_ATTEMPTS) {
                postJoin("""{"joinCode":"JOIN-0001"}""").status shouldBe HttpStatusCode.UnprocessableEntity
                postJoin("{").status shouldBe HttpStatusCode.BadRequest
            }
        }

        test("[5.3][NF-S14] Given 参加の要求 When ログを見る Then 接続元は鍵付き要約（src）だけで、窓の鍵と同じ値。生の接続元は載らない") {
            val attempts = FakeAttempts(count = ATTEMPT_POLICY.maxFailures + 1)
            withApp(attempts.store) { logs ->
                postJoin(JOIN_BODY)

                val record = logs.all().single()
                val window = attempts.seen.single()
                record.operation shouldBe "joinGame"
                record.result shouldBe "app.rate_limited"
                record.src shouldBe window.sourceKey
                record.src.orEmpty() shouldMatch Regex("[0-9a-f]{64}")
                logs.all().joinToString { it.toJsonLine() } shouldNotContain "127.0.0.1"
                logs.all().joinToString { it.toJsonLine() } shouldNotContain "localhost"
            }
        }

        test("[5.3] Given 参加と無関係の要求（形式の誤りのゲーム作成） When ログを見る Then src を載せない") {
            withApp(NO_ATTEMPTS) { logs ->
                client.post("$API/games") {
                    header("Idempotency-Key", "k1")
                    contentType(ContentType.Application.Json)
                    setBody("{")
                }

                logs.all().single().src shouldBe null
            }
        }
    })
