package beergame.http

import arrow.core.Either
import arrow.core.left
import arrow.core.right
import beergame.application.Versions
import io.ktor.http.ContentType
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.server.application.ApplicationCall
import io.ktor.server.request.receiveChannel
import io.ktor.server.response.header
import io.ktor.server.response.respondText
import io.ktor.util.AttributeKey
import io.ktor.utils.io.readBuffer
import kotlinx.io.readByteArray
import kotlinx.serialization.json.JsonObject
import java.util.UUID

/*
 * 1 つの呼び出しに付ける値（相関 ID、開始時刻、操作名、結果）と、応答・入力の共通の補助。
 * ログ（Observability.kt）と、エラー処理（ErrorHandling.kt）が、同じ値を読む。
 */

internal const val API_BASE = "/api/v1"
internal const val CORRELATION_HEADER = "x-correlation-id"

/** 資格の Cookie の名前（contracts/openapi.yaml。設計書に名前は無く、B1 の仮置き）。 */
internal const val COOKIE_NAME = "bg_session"

internal const val IDEMPOTENCY_HEADER = "Idempotency-Key"
private const val IDEMPOTENCY_KEY_MAX_LENGTH = 200
private const val PRINTABLE_ASCII_FIRST = 0x21
private const val PRINTABLE_ASCII_LAST = 0x7E

internal val PROBLEM_JSON: ContentType = ContentType.parse("application/problem+json")

internal val CorrelationKey = AttributeKey<UUID>("beergame.correlation")
internal val StartKey = AttributeKey<Long>("beergame.startNanos")
internal val OperationKey = AttributeKey<String>("beergame.operation")
internal val GameIdKey = AttributeKey<String>("beergame.gameId")
internal val ResultKey = AttributeKey<String>("beergame.result")
internal val VersionsKey = AttributeKey<Versions>("beergame.versions")

/** 直前に返した problem。StatusPages の状態コードの処理が、同じ 404 を別の本文で上書きしないために覚えておく。 */
internal val ProblemKey = AttributeKey<Problem>("beergame.problem")

internal val ApplicationCall.correlationId: UUID
    get() = attributes.getOrNull(CorrelationKey) ?: UUID(0L, 0L)

internal fun ApplicationCall.credential(): String? = request.cookies[COOKIE_NAME]

/** ログに載せる操作名（OpenAPI の operationId）。 */
internal fun ApplicationCall.operation(name: String) = attributes.put(OperationKey, name)

/*
 * 次の 3 つ（respondProblem、respondJson、readBody）は、Ktor の suspend 関数を呼ぶだけの小さな補助で、
 * `suspend fun` ではなく「suspend の関数型の値」で定義している。detekt 1.23.8 は、Kotlin 2.4 でビルドされたライブラリの
 * suspend 関数の呼び出しを検出できず、`suspend` の修飾を冗長と誤判定する（Step 7 の判断 #10 と同じ原因。
 * `@Suppress` も設定の緩和も使わない）。使い方は、通常の拡張関数と同じ（`call.respondProblem(problem)`）。
 */

internal val respondProblem: suspend ApplicationCall.(Problem) -> Unit = { problem ->
    attributes.put(ResultKey, problem.code)
    attributes.put(ProblemKey, problem)
    problem.retryAfterSeconds?.let { response.header(HttpHeaders.RetryAfter, it.toString()) }
    respondText(
        text = problem.toJson(correlationId).toString(),
        contentType = PROBLEM_JSON,
        status = HttpStatusCode.fromValue(problem.status),
    )
}

internal val respondJson: suspend ApplicationCall.(HttpStatusCode, JsonObject) -> Unit = { status, body ->
    respondText(body.toString(), ContentType.Application.Json, status)
}

/** 経路の ID が UUID でなければ 404（存在しない対象として扱う）。 */
internal fun ApplicationCall.uuidParam(name: String): Either<Problem, UUID> =
    parameters[name]?.let { runCatching { UUID.fromString(it) }.getOrNull() }?.right() ?: notFoundProblem().left()

/** ゲーム（セッション）の ID。ログに載せるため、UUID のときだけ記録する（不透明な ID）。 */
internal fun ApplicationCall.gameIdParam(name: String): Either<Problem, UUID> =
    uuidParam(name).onRight { attributes.put(GameIdKey, it.toString()) }

/** `Idempotency-Key`（変更系は必須）。1〜200 文字の表示できる ASCII。 */
internal fun ApplicationCall.idempotencyKey(): Either<Problem, String> {
    val raw = request.headers[IDEMPOTENCY_HEADER]
    return when {
        raw == null -> {
            badRequestProblem("$IDEMPOTENCY_HEADER ヘッダーが必要です。").left()
        }

        raw.length !in 1..IDEMPOTENCY_KEY_MAX_LENGTH ||
            raw.any { it.code !in PRINTABLE_ASCII_FIRST..PRINTABLE_ASCII_LAST } -> {
            badRequestProblem("$IDEMPOTENCY_HEADER は 1〜200 文字の、表示できる ASCII にしてください。").left()
        }

        else -> {
            raw.right()
        }
    }
}

/**
 * 本文を、上限（バイト）まで読む。上限を超えたら 413。`Content-Length` が無い・偽りの場合も、読む量を上限 + 1 で止める。
 */
internal val readBody: suspend ApplicationCall.(Int) -> Either<Problem, ByteArray> = { maxBytes ->
    val bytes = receiveChannel().readBuffer(maxBytes.toLong() + 1).readByteArray()
    if (bytes.size > maxBytes) payloadTooLargeProblem().left() else bytes.right()
}

internal fun payloadTooLargeProblem(): Problem =
    Problem(
        HttpStatusCodes.PAYLOAD_TOO_LARGE,
        Codes.PAYLOAD_TOO_LARGE,
        "リクエストが大きすぎます（64 KB まで）。",
    )

internal fun notFoundProblem(): Problem = Problem(HttpStatusCodes.NOT_FOUND, Codes.NOT_FOUND, "指定された対象が見つかりません。")
