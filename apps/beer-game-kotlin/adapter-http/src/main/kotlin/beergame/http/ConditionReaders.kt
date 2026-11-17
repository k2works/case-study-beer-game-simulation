package beergame.http

import arrow.core.Either
import arrow.core.left
import arrow.core.mapOrAccumulate
import arrow.core.raise.either
import arrow.core.raise.zipOrAccumulate
import arrow.core.right
import beergame.domain.CommitMode
import beergame.domain.ConditionInputs
import beergame.domain.Role
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/** カスタム条件（`conditions`）の読み取り（B7）。形だけを見る。範囲は domain の検証（`GameSettings.custom`）。 */

private const val CONDITIONS = "conditions"

/** `conditions` が無い（または null）なら null。誤りの項目名は `conditions.<名前>`。 */
internal fun JsonObject.conditions(): Either<FieldErrors, ConditionInputs?> =
    when (val element = this[CONDITIONS]) {
        null, is JsonNull -> null.right()
        is JsonObject -> element.conditionInputs()
        else -> single(CONDITIONS, "オブジェクトで指定してください。").left()
    }

private fun JsonObject.conditionInputs(): Either<FieldErrors, ConditionInputs> =
    either<FieldErrors, ConditionInputs> {
        zipOrAccumulate(
            ::combine,
            { inventory().bind() },
            { conditionInt("initialFlow").bind() },
            { conditionInt("orderDelayWeeks").bind() },
            { conditionInt("shipmentDelayWeeks").bind() },
            { conditionInt("productionDelayWeeks").bind() },
            { conditionLong("holdingCostMinor").bind() },
            { conditionLong("backlogCostMinor").bind() },
            { conditionString("disclosurePolicy").bind() },
        ) { inventory, flow, order, shipment, production, holding, backlog, disclosure ->
            ConditionInputs(inventory, flow, order, shipment, production, holding, backlog, disclosure)
        }
    }

/** `commitMode`（任意。省略は MANUAL）。 */
internal fun JsonObject.optionalCommitMode(): Either<FieldErrors, CommitMode> =
    if (optional("commitMode") == null) CommitMode.MANUAL.right() else commitMode("commitMode")

private fun JsonObject.optional(name: String): JsonElement? = this[name]?.takeUnless { it is JsonNull }

private fun JsonObject.conditionInt(name: String): Either<FieldErrors, Int?> =
    optional(name)?.asInt("$CONDITIONS.$name") ?: null.right()

private fun JsonObject.conditionLong(name: String): Either<FieldErrors, Long?> =
    optional(name)?.asLong("$CONDITIONS.$name") ?: null.right()

private fun JsonObject.conditionString(name: String): Either<FieldErrors, String?> =
    when (val element = optional(name)) {
        null -> {
            null.right()
        }

        is JsonPrimitive -> {
            if (element.isString) {
                element.content.right()
            } else {
                single(
                    "$CONDITIONS.$name",
                    NOT_A_STRING,
                ).left()
            }
        }

        else -> {
            single("$CONDITIONS.$name", NOT_A_STRING).left()
        }
    }

/** `initialInventory`: 役割名をキーにした整数。未知の役割名は誤り。 */
private fun JsonObject.inventory(): Either<FieldErrors, Map<Role, Int>> {
    val name = "$CONDITIONS.initialInventory"
    return when (val element = optional("initialInventory")) {
        null -> emptyMap<Role, Int>().right()
        is JsonObject -> element.roleInts(name)
        else -> single(name, "役割ごとの初期在庫のオブジェクトにしてください。").left()
    }
}

private fun JsonObject.roleInts(name: String): Either<FieldErrors, Map<Role, Int>> =
    if (keys.any { key -> Role.entries.none { it.name == key } }) {
        single(name, "役割は ${Role.entries.joinToString("、") { it.name }} のいずれかにしてください。").left()
    } else {
        Role.entries
            .filter { this@roleInts[it.name] != null }
            .mapOrAccumulate { role ->
                role to
                    this@roleInts[role.name].asInt("$name.${role.name}").mapLeft { it.head }.bind()
            }.map { it.toMap() }
    }
