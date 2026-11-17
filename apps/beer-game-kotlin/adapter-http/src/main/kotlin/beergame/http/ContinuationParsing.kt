package beergame.http

import arrow.core.Either
import arrow.core.flatMap
import arrow.core.left
import arrow.core.raise.either
import arrow.core.raise.zipOrAccumulate
import arrow.core.right
import beergame.domain.CommitMode
import beergame.domain.CredentialSubject
import beergame.domain.ParticipantId
import beergame.domain.Role
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import java.util.UUID

/*
 * 継続と資格の経路（B5）の本文の解釈。形（有無・型）だけを見る。値の範囲（週・数量）は application の検証が持つ。
 * 誤りは項目ごとにすべて集めて 422、JSON として不正なら 400（RequestParsing.kt と同じ）。
 */

/** 代理入力の本文。役割は経路が持つ。 */
internal data class ProxyBody(
    val requestedWeek: Int,
    val quantity: Int,
)

/** 復帰の本文。[recoveryCode] を省略すると、Cookie の復帰資格を使う。 */
internal data class RecoverBody(
    val gameId: UUID,
    val recoveryCode: String?,
)

private const val PARTICIPANT = "PARTICIPANT"
private const val SUBJECT = "subject"

internal fun parseProxyDecision(body: ByteArray): Either<Problem, ProxyBody> =
    parseObject(body).flatMap { obj ->
        collect {
            zipOrAccumulate(
                ::combine,
                { obj.int("requestedWeek").bind() },
                { obj.int("quantity").bind() },
            ) { week, quantity -> ProxyBody(week, quantity) }
        }
    }

/** 確定方式の変更（`MANUAL`・`AUTO`。B8）。 */
internal fun parseSetCommitMode(body: ByteArray): Either<Problem, CommitMode> =
    parseObject(body).flatMap { obj -> collect { obj.commitMode("commitMode").bind() } }

/** 失効・再発行の対象。B5 は参加者だけ（進行役自身の資格は対象外。観察者は B9）。 */
internal fun parseCredentialSubject(body: ByteArray): Either<Problem, CredentialSubject> =
    parseObject(body).flatMap { obj -> collect { obj.participantSubject().bind() } }

internal fun parseRecover(body: ByteArray): Either<Problem, RecoverBody> =
    parseObject(body).flatMap { obj ->
        collect {
            zipOrAccumulate(
                ::combine,
                { obj.uuid("gameId").bind() },
                { obj.optionalString("recoveryCode").bind() },
            ) { gameId, code -> RecoverBody(gameId, code) }
        }
    }

/** 経路の役割（代理入力）。仕様の 4 値でなければ、項目 `role` の誤りとして 422。 */
internal fun roleParam(text: String?): Either<Problem, Role> =
    Role.entries.firstOrNull { it.name == text }?.right()
        ?: validationProblem(
            listOf(FieldError("role", "役割は ${Role.entries.joinToString("、") { it.name }} のいずれかにしてください。")),
        ).left()

private fun JsonObject.participantSubject(): Either<FieldErrors, CredentialSubject> =
    when (val element = this[SUBJECT]) {
        null, is JsonNull -> single(SUBJECT, REQUIRED).left()
        is JsonObject -> element.subjectOf()
        else -> single(SUBJECT, "対象のオブジェクトにしてください。").left()
    }

private fun JsonObject.subjectOf(): Either<FieldErrors, CredentialSubject> =
    either {
        zipOrAccumulate(
            ::combine,
            { participantKind().bind() },
            { uuid("id", "$SUBJECT.id").bind() },
        ) { _, id -> CredentialSubject.Participant(ParticipantId(id)) }
    }

private fun JsonObject.participantKind(): Either<FieldErrors, Unit> =
    string("kind").mapLeft { it.at("$SUBJECT.kind") }.flatMap { kind ->
        if (kind == PARTICIPANT) Unit.right() else single("$SUBJECT.kind", "参加者（$PARTICIPANT）だけを指定できます。").left()
    }

private fun FieldErrors.at(field: String): FieldErrors = map { it.copy(field = field) }

/** UUID の項目。誤りの項目名を [field] にできる（入れ子の項目）。 */
internal fun JsonObject.uuid(
    name: String,
    field: String = name,
): Either<FieldErrors, UUID> =
    string(name).mapLeft { it.at(field) }.flatMap { text ->
        runCatching { UUID.fromString(text) }.getOrNull()?.right() ?: single(field, "UUID で指定してください。").left()
    }

/** 省略できる文字列の項目（省略・null は null）。文字列以外は誤り。 */
internal fun JsonObject.optionalString(name: String): Either<FieldErrors, String?> =
    when (this[name]) {
        null, is JsonNull -> null.right()
        else -> string(name)
    }
