package beergame.http

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.util.UUID

/*
 * problem+json（RFC 9457）。`type` は `/problems/{code}`（相対 URI）、拡張メンバー `code` に同じ値を持つ。
 * バックエンド自身が返す失敗（503 を含む）は、必ず `type` を持つ（画面が LB の 503 と区別するため）。
 */

/** HTTP で返す、`code` を持つ失敗。 */
internal class Problem(
    val status: Int,
    val code: String,
    val title: String,
    val detail: String? = null,
    val extras: Map<String, JsonElement> = emptyMap(),
    val retryAfterSeconds: Int? = null,
) {
    fun toJson(correlationId: UUID): JsonObject =
        buildJsonObject {
            put("type", "/problems/$code")
            put("title", title)
            put("status", status)
            detail?.let { put("detail", it) }
            put("code", code)
            put("correlationId", correlationId.toString())
            extras.forEach { (name, value) -> put(name, value) }
        }
}

/** 本書（HTTP の層）が定める `code`。業務の `code` はドメインが持つ。 */
internal object Codes {
    const val UNAUTHORIZED = "app.unauthorized"
    const val INTERNAL = "app.internal"
    const val RETRY_EXHAUSTED = "app.retry_exhausted"
    const val IDEMPOTENCY_KEY_REUSED = "app.idempotency_key_reused"
    const val NOT_READY = "app.not_ready"
    const val RATE_LIMITED = "app.rate_limited"
    const val VALIDATION = "validation.invalid_input"
    const val PAYLOAD_TOO_LARGE = "request.too_large"
    const val NOT_FOUND = "request.not_found"
    const val METHOD_NOT_ALLOWED = "request.method_not_allowed"
}

/** 入力の項目ごとの誤り。[week] は需要系列の対象の週。 */
internal data class FieldError(
    val field: String,
    val message: String,
    val week: Int? = null,
) {
    fun toJson(): JsonObject =
        buildJsonObject {
            put("field", field)
            week?.let { put("week", it) }
            put("message", message)
        }
}

internal fun validationProblem(errors: List<FieldError>): Problem =
    Problem(
        status = HttpStatusCodes.UNPROCESSABLE,
        code = Codes.VALIDATION,
        title = "入力に誤りがあります。",
        extras = mapOf("errors" to JsonArray(errors.map(FieldError::toJson))),
    )

internal fun badRequestProblem(detail: String): Problem =
    Problem(HttpStatusCodes.BAD_REQUEST, Codes.VALIDATION, "リクエストを解釈できません。", detail)

internal fun unauthorizedProblem(): Problem = Problem(HttpStatusCodes.FORBIDDEN, Codes.UNAUTHORIZED, "この操作を行う権限がありません。")

/**
 * 429（`app.rate_limited`、`Retry-After` つき）。全体の制限（[installGuards]）と、参加・復帰の専用の制限
 * （[beergame.application.AppFailure.RateLimited]）が同じ形で返す。利用者へは、どの制限かも、接続元の値も返さない。
 */
internal fun rateLimitedProblem(retryAfterSeconds: Int): Problem =
    Problem(
        status = HttpStatusCodes.TOO_MANY_REQUESTS,
        code = Codes.RATE_LIMITED,
        title = "要求が多すぎます。しばらくしてからお試しください。",
        retryAfterSeconds = retryAfterSeconds,
    )

/** HTTP の状態コード。魔法の数を避けるための名前。 */
internal object HttpStatusCodes {
    const val BAD_REQUEST = 400
    const val FORBIDDEN = 403
    const val NOT_FOUND = 404
    const val METHOD_NOT_ALLOWED = 405
    const val CONFLICT = 409
    const val PAYLOAD_TOO_LARGE = 413
    const val UNPROCESSABLE = 422
    const val TOO_MANY_REQUESTS = 429
    const val INTERNAL = 500
    const val UNAVAILABLE = 503
}

internal fun stringArray(items: List<String>): JsonElement = JsonArray(items.map { JsonPrimitive(it) })
