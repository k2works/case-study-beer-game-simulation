package beergame.domain

import io.kotest.core.spec.style.FunSpec
import io.kotest.matchers.shouldBe
import io.kotest.property.Arb
import io.kotest.property.arbitrary.bind
import io.kotest.property.arbitrary.int
import io.kotest.property.arbitrary.list
import io.kotest.property.checkAll

private const val ITERATIONS = 200
private const val WEEKS = 14

/** B7 の仮説: 遅延が可変（1〜8 週）でも、`simulateWeek` の計算の性質が保たれる。 */
private class Scenario(
    val settings: GameSettings,
    val decisions: List<RoleMap<Quantity>>,
)

private val delayArb: Arb<Int> = Arb.int(1..8)

private val scenarioArb: Arb<Scenario> =
    Arb.bind(
        Arb.list(Arb.int(0..40), 4..4),
        Arb.int(0..30),
        Arb.list(delayArb, 3..3),
        Arb.list(Arb.int(0..30), WEEKS..WEEKS),
        Arb.list(Arb.int(0..40), 4 * WEEKS..4 * WEEKS),
    ) { inventory, flow, delays, demand, orders -> scenarioOf(inventory, flow, delays, demand, orders) }

private fun scenarioOf(
    inventory: List<Int>,
    flow: Int,
    delays: List<Int>,
    demand: List<Int>,
    orders: List<Int>,
): Scenario {
    val inputs =
        ConditionInputs(
            initialInventory = Role.entries.zip(inventory).toMap(),
            initialFlow = flow,
            orderDelayWeeks = delays[0],
            shipmentDelayWeeks = delays[1],
            productionDelayWeeks = delays[2],
        )
    val settings = GameSettings.custom(WEEKS, demand, inputs).valid("カスタムの設定")
    val decisions = orders.chunked(4).map { v -> decisions(v[0], v[1], v[2], v[3]) }
    return Scenario(settings, decisions)
}

private fun Scenario.play(): Played =
    play(
        settings.simulation(),
        decisions,
        KitPreset.initialStates(settings.demand, settings.initial, settings.delays),
    )

private fun RoleMap<RoleState>.stock(): Int =
    values.sumOf { it.inventory.value + it.arrivals.value + it.deliveryPipeline.weeks.sumOf { w -> w.value } }

class VariableDelayPropertySpec :
    FunSpec({
        test("[B7/仮説(a)] 品物の保存: 在庫＋入荷＋配送中の合計は、初期 ＋ 工場の生産要請の累計 − 小売店の出荷の累計") {
            checkAll(ITERATIONS, scenarioArb) { s ->
                val played = s.play()
                val initial = KitPreset.initialStates(s.settings.demand, s.settings.initial, s.settings.delays)
                played.outcomes.forEachIndexed { index, outcome ->
                    val produced = played.decisions.take(index + 1).sumOf { it[Role.FACTORY].value }
                    val delivered = played.outcomes.take(index + 1).sumOf { it.results[Role.RETAILER].shipped.value }
                    outcome.nextStates.stock() shouldBe initial.stock() + produced - delivered
                }
            }
        }

        test("[B7/仮説(b)] 在庫と受注残は負にならず、同時に正にならない（BR-08）") {
            checkAll(ITERATIONS, scenarioArb) { s ->
                s.play().outcomes.forEach { outcome ->
                    outcome.results.values.forEach { r ->
                        (r.endingInventory.value >= 0 && r.endingBacklog.value >= 0) shouldBe true
                        (r.endingInventory.value == 0 || r.endingBacklog.value == 0) shouldBe true
                    }
                }
            }
        }

        test("[B7/仮説(c)] 週の費用は、在庫と受注残に単価を掛けた和で、累計は減らない（BR-09）") {
            checkAll(ITERATIONS, scenarioArb) { s ->
                val policy = s.settings.costPolicy
                val results = s.play().outcomes.map { it.results }
                results.forEach { week ->
                    week.values.forEach { r ->
                        r.weeklyCost shouldBe policy.holding * r.endingInventory + policy.backlog * r.endingBacklog
                    }
                }
                Role.entries.forEach { role ->
                    results.map { it[role].cumulativeCost.minor }.zipWithNext().forEach { (a, b) ->
                        (b >= a) shouldBe
                            true
                    }
                }
            }
        }

        test("[B7/仮説(d)] 待ち行列の長さは遅延 − 1 のまま保たれる（週を進めても変わらない）") {
            checkAll(ITERATIONS, scenarioArb) { s ->
                val d = s.settings.delays
                s.play().outcomes.forEach { outcome ->
                    Role.entries.forEach { role ->
                        val state = outcome.nextStates[role]
                        state.orderPipeline.weeks.size shouldBe (if (role.upstream == null) 0 else d.order.weeks - 1)
                        state.deliveryPipeline.weeks.size shouldBe
                            ((if (role.upstream == null) d.production else d.shipment).weeks - 1)
                    }
                }
            }
        }

        test("[B7/仮説(e)] 遅延が長いほど、注文が上流に届くのが遅い（初期の流れ 0・需要 0 で、第 1 週の小売店の注文が、注文の遅延ぶん後に二次卸の受注になる）") {
            checkAll(50, delayArb) { orderDelay ->
                val inputs = ConditionInputs(initialFlow = 0, orderDelayWeeks = orderDelay)
                val settings = GameSettings.custom(WEEKS, List(WEEKS) { 0 }, inputs).valid("設定")
                val orders = List(WEEKS) { week -> if (week == 0) decisions(0, 0, 0, 9) else same(0) }
                val played =
                    play(
                        settings.simulation(),
                        orders,
                        KitPreset.initialStates(settings.demand, settings.initial, settings.delays),
                    )
                val wholesalerOrders = played.before.map { it[Role.WHOLESALER].orders.value }
                // 第 k 週の開始時（添字 k − 1）に、第 1 週の注文 9 が届くのは、k = 1 + 注文の遅延
                wholesalerOrders.indexOf(9) shouldBe orderDelay
                wholesalerOrders.take(orderDelay).all { it == 0 } shouldBe true
            }
        }

        test("[B7/仮説(f)] キットの値では、従来の初期状態から回した結果と一致する（回帰）") {
            checkAll(50, Arb.list(Arb.int(0..30), 12..12)) { demandValues ->
                val settings = GameSettings.kit(12, demandValues).valid("キットの設定")
                val orders = List(12) { same(4) }
                val viaConditions =
                    play(
                        settings.simulation(),
                        orders,
                        KitPreset.initialStates(settings.demand, settings.initial, settings.delays),
                    )
                val classic = play(settings.simulation(), orders, KitPreset.initialStates(settings.demand))
                viaConditions shouldBe classic
            }
        }
    })
