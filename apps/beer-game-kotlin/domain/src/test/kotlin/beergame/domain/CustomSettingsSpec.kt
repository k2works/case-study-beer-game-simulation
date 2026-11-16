package beergame.domain

import arrow.core.Either
import arrow.core.getOrElse
import io.kotest.assertions.fail
import io.kotest.core.spec.style.FunSpec
import io.kotest.matchers.shouldBe

private val DEMAND = List(12) { 4 }

private fun custom(inputs: ConditionInputs): Either<arrow.core.NonEmptyList<ValidationError>, GameSettings> =
    GameSettings.custom(12, DEMAND, inputs)

private fun customOrFail(inputs: ConditionInputs): GameSettings = custom(inputs).getOrElse { fail("カスタムの設定が作れない: $it") }

private fun errorsOf(inputs: ConditionInputs): List<ValidationError> =
    custom(inputs)
        .swap()
        .getOrElse {
            fail("誤りが返らない")
        }.toList()

/** B7（US1.1 の AC1.1.3・AC1.1.4）: カスタム条件の検証、設定の種別の導出、初期状態の組み立て。範囲は仮置き（B7 計画の判断項目 2・4・5・6）。 */
class CustomSettingsSpec :
    FunSpec({
        context("[US1.1/AC1.1.3] 設定の種別は、値から導出する") {
            test("条件を何も指定しなければ、キット準拠の設定と同じで、種別はキット準拠") {
                custom(ConditionInputs()) shouldBe GameSettings.kit(12, DEMAND)
                customOrFail(ConditionInputs()).kind() shouldBe SettingsKind.Kit
            }

            test("すべてキットの値のまま指定しても、種別はキット準拠") {
                val inputs =
                    ConditionInputs(
                        initialInventory = Role.entries.associateWith { 12 },
                        initialFlow = 4,
                        orderDelayWeeks = 2,
                        shipmentDelayWeeks = 2,
                        productionDelayWeeks = 2,
                        holdingCostMinor = 50,
                        backlogCostMinor = 100,
                        disclosurePolicy = "TEAM_TOTAL",
                    )
                customOrFail(inputs).kind() shouldBe SettingsKind.Kit
            }

            val changes =
                mapOf(
                    SettingsField.INITIAL_INVENTORY to ConditionInputs(initialInventory = mapOf(Role.RETAILER to 20)),
                    SettingsField.INITIAL_FLOW to ConditionInputs(initialFlow = 6),
                    SettingsField.ORDER_DELAY to ConditionInputs(orderDelayWeeks = 3),
                    SettingsField.SHIPMENT_DELAY to ConditionInputs(shipmentDelayWeeks = 3),
                    SettingsField.PRODUCTION_DELAY to ConditionInputs(productionDelayWeeks = 3),
                    SettingsField.HOLDING_COST to ConditionInputs(holdingCostMinor = 80),
                    SettingsField.BACKLOG_COST to ConditionInputs(backlogCostMinor = 150),
                    SettingsField.DISCLOSURE to ConditionInputs(disclosurePolicy = "NONE"),
                )
            changes.forEach { (field, inputs) ->
                test("$field だけを変えると、種別はカスタムで、変更した項目はその 1 つだけ") {
                    customOrFail(inputs).kind() shouldBe SettingsKind.Custom(setOf(field))
                }
            }

            test("複数の項目を変えると、変更した項目はすべて示される") {
                val inputs = ConditionInputs(orderDelayWeeks = 3, holdingCostMinor = 80, disclosurePolicy = "NONE")
                customOrFail(inputs).kind() shouldBe
                    SettingsKind.Custom(
                        setOf(SettingsField.ORDER_DELAY, SettingsField.HOLDING_COST, SettingsField.DISCLOSURE),
                    )
            }

            test("最終週と需要系列は、種別の判定に含めない（ASM-01 が確定するまで）") {
                GameSettings.custom(3, listOf(1, 2, 3), ConditionInputs()).getOrElse { fail("$it") }.kind() shouldBe
                    SettingsKind.Kit
            }
        }

        context("[US1.1/AC1.1.4] 範囲外の値は、対象と範囲を、項目ごとにすべて集めて返す") {
            test("初期在庫は 0〜1000（役割ごと）") {
                errorsOf(ConditionInputs(initialInventory = mapOf(Role.RETAILER to 1001, Role.FACTORY to -1))) shouldBe
                    listOf(
                        ValidationError.ConditionOutOfRange("initialInventory.FACTORY", 0, 1000, -1),
                        ValidationError.ConditionOutOfRange("initialInventory.RETAILER", 0, 1000, 1001),
                    )
            }

            test("初期の流れは 0〜1000") {
                errorsOf(ConditionInputs(initialFlow = 1001)) shouldBe
                    listOf(ValidationError.ConditionOutOfRange("initialFlow", 0, 1000, 1001))
            }

            test("遅延は 1〜8 週（0 は許さない。境界 1 と 8 は受け付ける）") {
                errorsOf(ConditionInputs(shipmentDelayWeeks = 0)) shouldBe
                    listOf(ValidationError.ConditionOutOfRange("shipmentDelayWeeks", 1, 8, 0))
                errorsOf(ConditionInputs(orderDelayWeeks = 9)) shouldBe
                    listOf(ValidationError.ConditionOutOfRange("orderDelayWeeks", 1, 8, 9))
                custom(ConditionInputs(productionDelayWeeks = 1)).isRight() shouldBe true
                custom(ConditionInputs(productionDelayWeeks = 8)).isRight() shouldBe true
            }

            test("費用単価は 0〜100000（最小単位。境界 0 と 100000 は受け付ける）") {
                errorsOf(ConditionInputs(holdingCostMinor = -1)) shouldBe
                    listOf(ValidationError.ConditionOutOfRange("holdingCostMinor", 0, 100_000, -1))
                errorsOf(ConditionInputs(backlogCostMinor = 100_001)) shouldBe
                    listOf(ValidationError.ConditionOutOfRange("backlogCostMinor", 0, 100_000, 100_001))
                custom(ConditionInputs(holdingCostMinor = 0, backlogCostMinor = 100_000)).isRight() shouldBe true
            }

            test("公開範囲は TEAM_TOTAL か NONE") {
                errorsOf(ConditionInputs(disclosurePolicy = "ALL")) shouldBe
                    listOf(ValidationError.DisclosureUnknown("ALL"))
            }

            test("複数の誤りは、条件どうしも、最終週・需要系列とも、一度にすべて集める") {
                GameSettings.custom(
                    0,
                    listOf(-1),
                    ConditionInputs(shipmentDelayWeeks = 0, holdingCostMinor = -1),
                ) shouldBe
                    arrow.core
                        .nonEmptyListOf<ValidationError>(
                            ValidationError.WeekOutOfRange(0, 50),
                            ValidationError.DemandSeriesInvalid(1, "需要は 0〜1000 の整数"),
                            ValidationError.ConditionOutOfRange("shipmentDelayWeeks", 1, 8, 0),
                            ValidationError.ConditionOutOfRange("holdingCostMinor", 0, 100_000, -1),
                        ).let { arrow.core.Either.Left(it) }
            }
        }

        context("[US1.1/AC1.1.3] 開始時の初期状態は、条件から組み立てる") {
            test("キットの値では、従来の初期状態と同じ（在庫 12、各段 4、待ち行列は 1 段）") {
                val demand = demandOf(DEMAND, 12)
                KitPreset.initialStates(demand, KitPreset.initialConditions, KitPreset.delays) shouldBe
                    KitPreset.initialStates(demand)
                KitPreset.initialStates(demand)[Role.WHOLESALER].inventory shouldBe u(12)
                KitPreset.initialStates(demand)[Role.WHOLESALER].orderPipeline shouldBe Pipeline(listOf(u(4)))
            }

            test("初期在庫は役割ごと、初期の流れは入荷・受注・待ち行列の各段に入る（小売店の受注は第 1 週の需要）") {
                val settings =
                    customOrFail(
                        ConditionInputs(
                            initialInventory =
                                mapOf(
                                    Role.RETAILER to 20,
                                    Role.FACTORY to 0,
                                ),
                            initialFlow = 7,
                        ),
                    )
                val states = KitPreset.initialStates(settings.demand, settings.initial, settings.delays)
                states[Role.RETAILER].inventory shouldBe u(20)
                states[Role.FACTORY].inventory shouldBe u(0)
                states[Role.WHOLESALER].inventory shouldBe u(12)
                states[Role.WHOLESALER].arrivals shouldBe u(7)
                states[Role.WHOLESALER].orders shouldBe u(7)
                states[Role.RETAILER].orders shouldBe u(4)
            }

            test("待ち行列の長さは「遅延 − 1」: 注文は上流のある役割、配送は工場以外、生産は工場。遅延 1 なら空") {
                val settings =
                    customOrFail(
                        ConditionInputs(
                            orderDelayWeeks = 4,
                            shipmentDelayWeeks = 1,
                            productionDelayWeeks = 3,
                            initialFlow = 5,
                        ),
                    )
                val states = KitPreset.initialStates(settings.demand, settings.initial, settings.delays)
                states[Role.RETAILER].orderPipeline shouldBe Pipeline(List(3) { u(5) })
                states[Role.FACTORY].orderPipeline shouldBe Pipeline(emptyList())
                states[Role.WHOLESALER].deliveryPipeline shouldBe Pipeline(emptyList())
                states[Role.FACTORY].deliveryPipeline shouldBe Pipeline(List(2) { u(5) })
            }
        }
    })
