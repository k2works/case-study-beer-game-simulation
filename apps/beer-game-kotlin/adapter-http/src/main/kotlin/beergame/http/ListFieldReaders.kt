package beergame.http

import arrow.core.Either
import arrow.core.left
import arrow.core.right
import beergame.domain.Role
import beergame.domain.RoleMap
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject

/** 配列・オブジェクトの項目の読み取り。誤りは、すべて集めて返す。 */

internal fun JsonObject.intList(name: String): Either<FieldErrors, List<Int>> =
    when (val element = this[name]) {
        null, is JsonNull -> single(name, REQUIRED).left()
        is JsonArray -> weekValues(name, element)
        else -> single(name, "整数の配列で指定してください。").left()
    }

/** 需要系列のように、週ごとの値の配列。誤りは、対象の週（1 始まり）を付けて、すべて集める。 */
private fun weekValues(
    name: String,
    array: JsonArray,
): Either<FieldErrors, List<Int>> {
    val results = array.mapIndexed { index, element -> element.asInt(name, index + 1) }
    val errors = results.flatMap { it.leftOrNull()?.toList().orEmpty() }
    return if (errors.isEmpty()) {
        results.mapNotNull { it.getOrNull() }.right()
    } else {
        FieldErrors(errors.first(), errors.drop(1)).left()
    }
}

internal fun JsonObject.basis(): Either<FieldErrors, RoleMap<Long>> =
    when (val element = this["basis"]) {
        null, is JsonNull -> single("basis", REQUIRED).left()
        is JsonObject -> basisVersions(element)
        else -> single("basis", "役割ごとの意思決定の版のオブジェクトにしてください。").left()
    }

private fun basisVersions(obj: JsonObject): Either<FieldErrors, RoleMap<Long>> {
    val results = Role.entries.associateWith { role -> obj[role.name].asLong("basis.${role.name}") }
    val errors = results.values.flatMap { it.leftOrNull()?.toList().orEmpty() }
    return if (errors.isEmpty()) {
        RoleMap.of { role -> results.getValue(role).getOrNull() ?: 0L }.right()
    } else {
        FieldErrors(errors.first(), errors.drop(1)).left()
    }
}
