package beergame.http

import arrow.core.Either
import arrow.core.flatMap
import arrow.core.left
import arrow.core.raise.Raise
import arrow.core.raise.either
import arrow.core.raise.zipOrAccumulate
import arrow.core.right
import beergame.application.CommitWeekInput
import beergame.application.CreateGameInput
import beergame.application.JoinGameInput
import beergame.domain.ConditionInputs
import beergame.domain.Role
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction

/*
 * リクエストの本文の解釈。**形**（JSON の構文、項目の有無、型）だけを見る。値の範囲（数量 0〜1000、表示名の長さ、
 * 需要の範囲など）は、application の検証（domain の値オブジェクト）が持つので、ここでは見ない（規則を二重に持たない）。
 * 構文エラーは 400、項目ごとの形の誤りは、すべて集めて 422。項目の読み取りは FieldReaders.kt。
 */

/** 保持日数の既定（NF-S16。既定 90 日）。 */
internal const val DEFAULT_RETENTION_DAYS = 90

/** 入力の保存の本文と、`If-Match` の版。 */
internal data class DecisionBody(
    val week: Int,
    val quantity: Int,
    val expectedVersion: Long,
)

internal fun parseCreateGame(body: ByteArray): Either<Problem, CreateGameInput> =
    parseObject(body)
        .flatMap { obj ->
            collect {
                zipOrAccumulate(
                    ::combine,
                    { obj.kind().bind() },
                    { obj.int("finalWeek").bind() },
                    { obj.intList("demand").bind() },
                    { obj.optionalInt("retentionDays", DEFAULT_RETENTION_DAYS).bind() },
                    { obj.conditions().bind() },
                    { obj.optionalCommitMode().bind() },
                ) { kind, finalWeek, demand, retention, conditions, commitMode ->
                    Triple(kind, conditions, CreateGameInput(finalWeek, demand, retention, commitMode = commitMode))
                }
            }
        }.flatMap { (kind, conditions, input) ->
            when {
                kind == "KIT" && conditions != null -> {
                    validationProblem(
                        listOf(FieldError("conditions", "条件を指定するときは、kind を CUSTOM にして、カスタムで作成してください。")),
                    ).left()
                }

                kind == "CUSTOM" -> {
                    input.copy(conditions = conditions ?: ConditionInputs()).right()
                }

                else -> {
                    input.right()
                }
            }
        }

internal fun parseJoinGame(body: ByteArray): Either<Problem, JoinGameInput> =
    parseObject(body).flatMap { obj ->
        collect {
            zipOrAccumulate(
                ::combine,
                { obj.string("joinCode").bind() },
                { obj.string("displayName").bind() },
            ) { joinCode, displayName -> JoinGameInput(joinCode, displayName) }
        }
    }

internal fun parseAssignRole(body: ByteArray): Either<Problem, Role> =
    parseObject(body).flatMap { obj -> collect { obj.role("role").bind() } }

/** `If-Match` は意思決定の版（SaveDecision にだけ付く）。無ければ 0（初回の保存）。 */
internal fun parseSaveDecision(
    body: ByteArray,
    ifMatch: String?,
): Either<Problem, DecisionBody> =
    parseObject(body).flatMap { obj ->
        collect {
            zipOrAccumulate(
                ::combine,
                { obj.int("week").bind() },
                { obj.int("quantity").bind() },
                { parseIfMatch(ifMatch).bind() },
            ) { week, quantity, version -> DecisionBody(week, quantity, version) }
        }
    }

internal fun parseCommitWeek(body: ByteArray): Either<Problem, CommitWeekInput> =
    parseObject(body).flatMap { obj ->
        collect {
            zipOrAccumulate(
                ::combine,
                { obj.int("requestedWeek").bind() },
                { obj.basis().bind() },
            ) { week, basis -> CommitWeekInput(week, basis) }
        }
    }

/** UTF-8（不正なバイトは拒否）の JSON のオブジェクト。それ以外は 400。 */
internal fun parseObject(body: ByteArray): Either<Problem, JsonObject> =
    Either
        .catch {
            val decoder =
                Charsets.UTF_8
                    .newDecoder()
                    .onMalformedInput(CodingErrorAction.REPORT)
                    .onUnmappableCharacter(CodingErrorAction.REPORT)
            Json.parseToJsonElement(decoder.decode(ByteBuffer.wrap(body)).toString())
        }.mapLeft { badRequestProblem("本文を JSON として解釈できません。") }
        .flatMap { element ->
            (element as? JsonObject)?.right() ?: badRequestProblem("本文は JSON のオブジェクトにしてください。").left()
        }

internal fun combine(
    first: FieldErrors,
    second: FieldErrors,
): FieldErrors = first + second

internal fun <A> collect(block: Raise<FieldErrors>.() -> A): Either<Problem, A> =
    either<FieldErrors, A> { block() }.mapLeft { validationProblem(it.toList()) }
