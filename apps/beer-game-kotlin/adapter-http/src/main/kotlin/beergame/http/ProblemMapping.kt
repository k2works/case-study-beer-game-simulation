package beergame.http

import beergame.application.AppFailure
import beergame.domain.DecisionEntry
import beergame.domain.DomainError
import beergame.domain.ErrorCategory
import beergame.domain.GameError
import beergame.domain.Role
import beergame.domain.SessionError
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/*
 * 失敗の写像。**写像は 1 か所（この関数）**にして、`when` の網羅で漏れをなくす（architecture-backend.md「エラーの写像」）。
 * 無効な資格と権限の不足は、同じ 403 の本文で返す（列挙の防止）。参加コードの失敗だけは別の code（game.invitation_invalid）。
 */

private const val RETRY_AFTER_SECONDS = 1

internal fun AppFailure.toProblem(): Problem =
    when (this) {
        is AppFailure.Invalid -> validationProblem(errors.map { it.toFieldError() })
        is AppFailure.Domain -> error.toProblem()
        is AppFailure.ConcurrencyConflict, is AppFailure.RetryExhausted -> retryExhaustedProblem()
        is AppFailure.IdempotencyKeyReused -> idempotencyKeyReusedProblem()
        is AppFailure.Unauthorized -> unauthorizedProblem()
        is AppFailure.Persistence -> internalProblem()
    }

/** 再試行の上限。`Retry-After` を付け、`type` を持つ（LB の 503 と区別するため）。 */
internal fun retryExhaustedProblem(): Problem =
    Problem(
        status = HttpStatusCodes.UNAVAILABLE,
        code = Codes.RETRY_EXHAUSTED,
        title = "混み合っています。もう一度お試しください。",
        retryAfterSeconds = RETRY_AFTER_SECONDS,
    )

private fun idempotencyKeyReusedProblem(): Problem =
    Problem(
        status = HttpStatusCodes.CONFLICT,
        code = Codes.IDEMPOTENCY_KEY_REUSED,
        title = "同じ冪等キーで、内容の違う要求が送られました。",
    )

/** 利用者へは、相関 ID だけを返す（内部の操作名・メッセージは、ログにだけ残す）。 */
internal fun internalProblem(): Problem =
    Problem(
        status = HttpStatusCodes.INTERNAL,
        code = Codes.INTERNAL,
        title = "予期しないエラーが発生しました。",
        detail = "相関 ID を添えて、運営者へお知らせください。",
    )

private fun DomainError.toProblem(): Problem =
    when (category) {
        ErrorCategory.Forbidden -> {
            forbiddenProblem()
        }

        ErrorCategory.NotFound -> {
            Problem(HttpStatusCodes.NOT_FOUND, code, titleOf(code))
        }

        ErrorCategory.InvalidState -> {
            Problem(HttpStatusCodes.CONFLICT, code, titleOf(code), detailOf(code))
        }

        ErrorCategory.Conflict -> {
            Problem(HttpStatusCodes.CONFLICT, code, titleOf(code), extras = conflictExtras())
        }

        ErrorCategory.RuleViolation -> {
            Problem(HttpStatusCodes.UNPROCESSABLE, code, titleOf(code), extras = missingRolesExtras())
        }
    }

/** 参加コードの失敗（不明・形式不正・失効を区別しない。AC1.2.2）だけ別の code。それ以外の権限の不足は、資格の失敗と同じ本文。 */
private fun DomainError.forbiddenProblem(): Problem =
    if (this === GameError.InvitationInvalid) {
        Problem(HttpStatusCodes.FORBIDDEN, code, titleOf(code))
    } else {
        unauthorizedProblem()
    }

private fun DomainError.conflictExtras(): Map<String, JsonElement> =
    when (this) {
        is SessionError.WeekAdvanced -> {
            mapOf("requestedWeek" to JsonPrimitive(requested.value), "currentWeek" to JsonPrimitive(current.value))
        }

        is SessionError.DecisionConflict -> {
            buildMap {
                put("role", JsonPrimitive(role.name))
                latest?.let { put("latest", entryJson(it)) }
            }
        }

        is SessionError.DecisionsChanged -> {
            mapOf(
                "week" to JsonPrimitive(week.value),
                "current" to JsonObject(current.entries.associate { (role, entry) -> role.name to entryJson(entry) }),
            )
        }

        else -> {
            emptyMap()
        }
    }

private fun entryJson(entry: DecisionEntry): JsonObject =
    buildJsonObject {
        put("quantity", entry.quantity.value)
        put("version", entry.version.value)
    }

private fun DomainError.missingRolesExtras(): Map<String, JsonElement> =
    when (this) {
        is GameError.StartConditionNotMet -> mapOf("missingRoles" to roleNames(missing))
        is SessionError.IncompleteDecisions -> mapOf("missingRoles" to roleNames(missing))
        else -> emptyMap()
    }

private fun roleNames(roles: List<Role>): JsonElement = stringArray(roles.map { it.name })
