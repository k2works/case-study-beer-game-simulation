package beergame.http

import arrow.core.Either
import arrow.core.NonEmptyList
import arrow.core.flatMap
import arrow.core.left
import arrow.core.nonEmptyListOf
import arrow.core.right
import beergame.domain.Role
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/*
 * JSON の項目の読み取り。形（有無、型）だけを見て、誤りは項目の名前つきで返す（値の範囲は application の検証）。
 * 配列とオブジェクトの項目は ListFieldReaders.kt。
 */

internal typealias FieldErrors = NonEmptyList<FieldError>

internal const val REQUIRED = "必須の項目です。"
internal const val NOT_AN_INTEGER = "整数で指定してください。"
private const val NOT_A_STRING = "文字列で指定してください。"
private const val KIT = "KIT"

internal fun single(
    field: String,
    message: String,
): FieldErrors = nonEmptyListOf(FieldError(field, message))

internal fun JsonObject.kind(): Either<FieldErrors, Unit> =
    string("kind").flatMap { value ->
        if (value == KIT) Unit.right() else single("kind", "キット準拠（KIT）だけを指定できます。").left()
    }

internal fun JsonObject.string(name: String): Either<FieldErrors, String> =
    when (val element = this[name]) {
        null, is JsonNull -> single(name, REQUIRED).left()
        is JsonPrimitive -> if (element.isString) element.content.right() else single(name, NOT_A_STRING).left()
        else -> single(name, NOT_A_STRING).left()
    }

internal fun JsonObject.role(name: String): Either<FieldErrors, Role> =
    string(name).flatMap { text ->
        Role.entries.firstOrNull { it.name == text }?.right()
            ?: single(name, "役割は ${Role.entries.joinToString("、") { it.name }} のいずれかにしてください。").left()
    }

internal fun JsonObject.int(name: String): Either<FieldErrors, Int> = this[name].asInt(name)

internal fun JsonObject.optionalInt(
    name: String,
    default: Int,
): Either<FieldErrors, Int> = if (this[name] == null) default.right() else int(name)

/** 整数。[week] は、配列の中の要素の誤りに付ける対象の週（1 始まり）。 */
internal fun JsonElement?.asInt(
    name: String,
    week: Int? = null,
): Either<FieldErrors, Int> =
    when (this) {
        null, is JsonNull -> nonEmptyListOf(FieldError(name, REQUIRED, week)).left()
        is JsonPrimitive -> numberOrError(name, week) { it.toIntOrNull() }
        else -> nonEmptyListOf(FieldError(name, NOT_AN_INTEGER, week)).left()
    }

internal fun JsonElement?.asLong(name: String): Either<FieldErrors, Long> =
    when (this) {
        null, is JsonNull -> single(name, REQUIRED).left()
        is JsonPrimitive -> numberOrError(name, null) { it.toLongOrNull() }
        else -> single(name, NOT_AN_INTEGER).left()
    }

/** 文字列で書かれた数（`"5"`）は数として扱わない。小数・指数・桁あふれも、整数ではない誤りにする。 */
private fun <N : Any> JsonPrimitive.numberOrError(
    name: String,
    week: Int?,
    parse: (String) -> N?,
): Either<FieldErrors, N> {
    val parsed = if (isString) null else parse(content)
    return parsed?.right() ?: nonEmptyListOf(FieldError(name, NOT_AN_INTEGER, week)).left()
}

/** `If-Match` は意思決定の版（SaveDecision にだけ付く）。引用符つき（`"3"`）も受ける。無ければ 0（初回の保存）。 */
internal fun parseIfMatch(header: String?): Either<FieldErrors, Long> =
    when (val text = header?.trim()?.removeSurrounding("\"")) {
        null -> 0L.right()
        else -> text.toLongOrNull()?.right() ?: single("If-Match", "意思決定の版（整数）にしてください。").left()
    }
