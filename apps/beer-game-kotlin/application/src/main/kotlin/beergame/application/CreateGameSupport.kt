package beergame.application

import beergame.domain.ConditionInputs
import beergame.domain.GameSettings
import beergame.domain.Role

// ゲームの作成の入力（キット準拠かカスタム条件か）から、設定と冪等性の照合に使う本文を作る。

internal fun CreateGameInput.settings() =
    conditions?.let { GameSettings.custom(finalWeek, demand, it) } ?: GameSettings.kit(finalWeek, demand)

/** 冪等性の照合に使う本文。同じ入力は同じ文字列になる（役割ごとの初期在庫は役割の順に並べる）。 */
internal fun CreateGameInput.idempotencyBody(): String =
    "${if (conditions == null) "kit" else "custom"}|$finalWeek|${demand.joinToString(",")}|$retentionDays" +
        (conditions?.let { "|${it.canonical()}" }.orEmpty())

private fun ConditionInputs.canonical(): String =
    listOf(
        Role.entries.joinToString(",") { "${it.name}=${initialInventory[it] ?: ""}" },
        initialFlow,
        orderDelayWeeks,
        shipmentDelayWeeks,
        productionDelayWeeks,
        holdingCostMinor,
        backlogCostMinor,
        disclosurePolicy,
    ).joinToString("|") { it?.toString().orEmpty() }
