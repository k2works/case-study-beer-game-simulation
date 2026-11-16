package beergame.domain

import arrow.core.Either
import arrow.core.NonEmptyList
import arrow.core.left
import arrow.core.right
import arrow.core.toNonEmptyListOrNull

/*
 * カスタム条件（US1.1 の AC1.1.3〜1.1.5。B7）。範囲は B7 計画の判断項目（仮置き）。
 * 初期条件・遅延・費用方針・公開範囲を、キットの値から変えられる。種別（キット準拠かカスタムか）は値から導出する。
 */

/** 遅延の週数。1〜8（0 は待ち行列で表せないため許さない）。待ち行列の長さは「遅延 − 1」。 */
@JvmInline
value class Delay(
    val weeks: Int,
)

/** 3 つの遅延。注文（下流から上流へ）、配送（上流から下流へ。工場以外）、生産（工場）。 */
data class Delays(
    val order: Delay,
    val shipment: Delay,
    val production: Delay,
)

/** 開始時の初期条件。在庫は役割ごと、流れ（入荷・受注・待ち行列の各段）は単一の値。 */
data class InitialConditions(
    val inventory: RoleMap<Units>,
    val flow: Units,
)

/** 公開範囲（観察者や参加者に見せる集計の範囲）。 */
enum class DisclosurePolicy {
    TEAM_TOTAL,
    NONE,
}

/** 設定のうち、キットの値から変えられる項目。最終週と需要系列は含めない（ASM-01 が確定するまで）。 */
enum class SettingsField {
    INITIAL_INVENTORY,
    INITIAL_FLOW,
    ORDER_DELAY,
    SHIPMENT_DELAY,
    PRODUCTION_DELAY,
    HOLDING_COST,
    BACKLOG_COST,
    DISCLOSURE,
}

/** 設定の種別。値から導出する（保存しない）。 */
sealed interface SettingsKind {
    data object Kit : SettingsKind

    data class Custom(
        val changed: Set<SettingsField>,
    ) : SettingsKind
}

/** 作成の入力（境界の生の値）。null は「キットの値のまま」。 */
data class ConditionInputs(
    val initialInventory: Map<Role, Int> = emptyMap(),
    val initialFlow: Int? = null,
    val orderDelayWeeks: Int? = null,
    val shipmentDelayWeeks: Int? = null,
    val productionDelayWeeks: Int? = null,
    val holdingCostMinor: Long? = null,
    val backlogCostMinor: Long? = null,
    val disclosurePolicy: String? = null,
)

/** 検証を通った条件。 */
internal data class Conditions(
    val initial: InitialConditions,
    val delays: Delays,
    val costPolicy: CostPolicy,
    val disclosure: DisclosurePolicy,
)

private const val STOCK_MAX = 1000L
private const val DELAY_MIN = 1L
private const val DELAY_MAX = 8L
private const val COST_MAX = 100_000L

private fun range(
    field: String,
    value: Long?,
    min: Long,
    max: Long,
): ValidationError? =
    value?.takeUnless { it in min..max }?.let { ValidationError.ConditionOutOfRange(field, min, max, it) }

private fun ConditionInputs.errors(): List<ValidationError> =
    Role.entries.mapNotNull { role ->
        range("initialInventory.$role", initialInventory[role]?.toLong(), 0, STOCK_MAX)
    } +
        listOfNotNull(
            range("initialFlow", initialFlow?.toLong(), 0, STOCK_MAX),
            range("orderDelayWeeks", orderDelayWeeks?.toLong(), DELAY_MIN, DELAY_MAX),
            range("shipmentDelayWeeks", shipmentDelayWeeks?.toLong(), DELAY_MIN, DELAY_MAX),
            range("productionDelayWeeks", productionDelayWeeks?.toLong(), DELAY_MIN, DELAY_MAX),
            range("holdingCostMinor", holdingCostMinor, 0, COST_MAX),
            range("backlogCostMinor", backlogCostMinor, 0, COST_MAX),
            disclosurePolicy
                ?.takeIf { raw ->
                    DisclosurePolicy.entries.none { it.name == raw }
                }?.let { ValidationError.DisclosureUnknown(it) },
        )

/** 範囲外の値を、項目ごとにすべて集めて返す。指定の無い項目はキットの値。 */
internal fun ConditionInputs.validate(): Either<NonEmptyList<ValidationError>, Conditions> =
    errors().toNonEmptyListOrNull()?.left() ?: build().right()

private fun ConditionInputs.build(): Conditions =
    Conditions(
        initial = initialConditions(),
        delays = delays(),
        costPolicy = costPolicy(),
        disclosure = disclosurePolicy?.let { DisclosurePolicy.valueOf(it) } ?: DisclosurePolicy.TEAM_TOTAL,
    )

private fun ConditionInputs.initialConditions(): InitialConditions {
    val kit = KitPreset.initialConditions
    return InitialConditions(
        inventory = RoleMap.of { role -> initialInventory[role]?.let { Units(it) } ?: kit.inventory[role] },
        flow = initialFlow?.let { Units(it) } ?: kit.flow,
    )
}

private fun ConditionInputs.delays(): Delays {
    val kit = KitPreset.delays
    return Delays(
        order = orderDelayWeeks?.let { Delay(it) } ?: kit.order,
        shipment = shipmentDelayWeeks?.let { Delay(it) } ?: kit.shipment,
        production = productionDelayWeeks?.let { Delay(it) } ?: kit.production,
    )
}

private fun ConditionInputs.costPolicy(): CostPolicy =
    CostPolicy(
        holding = holdingCostMinor?.let { Money(it) } ?: KitPreset.costPolicy.holding,
        backlog = backlogCostMinor?.let { Money(it) } ?: KitPreset.costPolicy.backlog,
    )

/** キットの値と違う項目（種別の導出に使う）。 */
internal fun GameSettings.changedFields(): Set<SettingsField> {
    val kit = KitPreset
    return listOfNotNull(
        SettingsField.INITIAL_INVENTORY.takeIf { initial.inventory != kit.initialConditions.inventory },
        SettingsField.INITIAL_FLOW.takeIf { initial.flow != kit.initialConditions.flow },
        SettingsField.ORDER_DELAY.takeIf { delays.order != kit.delays.order },
        SettingsField.SHIPMENT_DELAY.takeIf { delays.shipment != kit.delays.shipment },
        SettingsField.PRODUCTION_DELAY.takeIf { delays.production != kit.delays.production },
        SettingsField.HOLDING_COST.takeIf { costPolicy.holding != kit.costPolicy.holding },
        SettingsField.BACKLOG_COST.takeIf { costPolicy.backlog != kit.costPolicy.backlog },
        SettingsField.DISCLOSURE.takeIf { disclosure != DisclosurePolicy.TEAM_TOTAL },
    ).toSet()
}
