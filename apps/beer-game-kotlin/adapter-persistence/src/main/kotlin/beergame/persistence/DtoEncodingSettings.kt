package beergame.persistence

import beergame.domain.DisclosurePolicy
import beergame.domain.GameSettings
import beergame.domain.KitPreset

// ドメインの設定 -> DTO（イベントの JSON）。

internal fun GameSettings.toDto() =
    SettingsDto(
        finalWeek.value,
        demand.asInts(),
        costPolicy.holding.minor,
        costPolicy.backlog.minor,
        commitMode.name,
        conditionsDto(),
    )

/** 初期条件・遅延・公開範囲がキットの値のままなら null（イベントに書かない）。 */
private fun GameSettings.conditionsDto(): ConditionsDto? =
    if (initial == KitPreset.initialConditions && delays == KitPreset.delays &&
        disclosure == DisclosurePolicy.TEAM_TOTAL
    ) {
        null
    } else {
        val stock = initial.inventory
        ConditionsDto(
            RoleMapDto(stock.factory.value, stock.distributor.value, stock.wholesaler.value, stock.retailer.value),
            initial.flow.value,
            delays.order.weeks,
            delays.shipment.weeks,
            delays.production.weeks,
            disclosure.name,
        )
    }
