package beergame.domain

import io.kotest.core.spec.style.FunSpec
import io.kotest.matchers.shouldBe
import io.kotest.property.Arb
import io.kotest.property.arbitrary.int
import io.kotest.property.arbitrary.list
import io.kotest.property.arbitrary.map
import io.kotest.property.checkAll

private const val ITERATIONS = 300

private val unitsArb: Arb<Units> = Arb.int(0..5000).map { u(it) }

private val roleStateArb: Arb<RoleState> =
    Arb.list(unitsArb, 6..6).map { v ->
        RoleState(
            inventory = v[0],
            backlog = v[1],
            orderPipeline = Pipeline(listOf(v[5])),
            deliveryPipeline = Pipeline(listOf(v[4])),
            cumulativeCost = m((v[0].value + v[1].value) * 7L),
            arrivals = v[2],
            orders = v[3],
        )
    }

/** 任意の状態（在庫・受注残・待ち行列・入荷・受注が任意）。工場は上流へ発注しないので、注文の待ち行列を空にする。 */
private val statesArb: Arb<RoleMap<RoleState>> =
    Arb.list(roleStateArb, 4..4).map { v ->
        RoleMap(v[0].copy(orderPipeline = Pipeline(emptyList())), v[1], v[2], v[3])
    }

private val demandArb: Arb<List<Int>> = Arb.list(quantities, 1..20)

private fun playRandom(
    demand: List<Int>,
    decisions: List<RoleMap<Quantity>>,
): Played = play(settingsOf(demand), decisions.take(demand.size).let { it + List(demand.size - it.size) { same(4) } })

class SimulateWeekPropertySpec :
    FunSpec({
        val settings = settingsOf(listOf(4, 4, 4, 4))

        test("[US2.3/AC2.3.4] 決定論: 同じ入力は、何度回しても同じ結果（任意の状態・発注）") {
            checkAll(ITERATIONS, statesArb, roleDecisions) { states, decision ->
                simulateWeek(settings, w(1), states, decision) shouldBe simulateWeek(settings, w(1), states, decision)
            }
        }

        test("[US2.3/AC2.3.4] 決定論: 同じ系列を 2 回回すと、全週の結果と状態が一致する") {
            checkAll(ITERATIONS, demandArb, Arb.list(roleDecisions, 1..20)) { demand, decisions ->
                playRandom(demand, decisions) shouldBe playRandom(demand, decisions)
            }
        }

        test("[US2.3/AC2.3.4] 在庫と受注残は負にならず、一方は必ず 0（BR-08）") {
            checkAll(ITERATIONS, statesArb, roleDecisions) { states, decision ->
                simulateWeek(settings, w(1), states, decision).results.values.forEach {
                    (it.endingInventory.value >= 0) shouldBe true
                    (it.endingBacklog.value >= 0) shouldBe true
                    minOf(it.endingInventory, it.endingBacklog) shouldBe u(0)
                }
            }
        }

        test("[US2.3/AC2.3.4] 保存: 出荷は利用可能量と充足対象を超えず、在庫と受注残の増減が入荷・受注・出荷で説明できる（BR-05〜BR-08）") {
            checkAll(ITERATIONS, statesArb, roleDecisions) { states, decision ->
                val outcome = simulateWeek(settings, w(1), states, decision)
                Role.entries.forEach { role ->
                    val before = states[role]
                    val r = outcome.results[role]
                    // 出荷 ≤ 前週末在庫 + 入荷、出荷 ≤ 前週末受注残 + 受注
                    (r.shipped.value <= before.inventory.value + before.arrivals.value) shouldBe true
                    (r.shipped.value <= before.backlog.value + before.orders.value) shouldBe true
                    // 在庫の増減 = 入荷 - 出荷、受注残の増減 = 受注 - 出荷
                    (r.endingInventory.value - before.inventory.value) shouldBe
                        (before.arrivals.value - r.shipped.value)
                    (r.endingBacklog.value - before.backlog.value) shouldBe (before.orders.value - r.shipped.value)
                    // 受注は状態の受注、発注は意思決定そのもの
                    r.orders shouldBe before.orders
                    r.ordered shouldBe decision[role]
                }
            }
        }

        test("[US2.3/AC2.3.4] 費用: 週次 = 在庫 × 在庫単価 + 受注残 × 受注残単価、累積 = 前週の累積 + 週次（BR-09）") {
            checkAll(ITERATIONS, statesArb, roleDecisions) { states, decision ->
                val outcome = simulateWeek(settings, w(1), states, decision)
                Role.entries.forEach { role ->
                    val r = outcome.results[role]
                    r.weeklyCost.minor shouldBe
                        (r.endingInventory.value * 50L + r.endingBacklog.value * 100L)
                    r.cumulativeCost.minor shouldBe (states[role].cumulativeCost.minor + r.weeklyCost.minor)
                    outcome.nextStates[role].cumulativeCost shouldBe r.cumulativeCost
                    outcome.nextStates[role].inventory shouldBe r.endingInventory
                    outcome.nextStates[role].backlog shouldBe r.endingBacklog
                }
            }
        }

        test("[US2.3/AC2.3.5] 役割別の合計 = チームの合計（週次費用、累積費用、出荷）") {
            checkAll(ITERATIONS, statesArb, roleDecisions) { states, decision ->
                val outcome = simulateWeek(settings, w(1), states, decision)
                outcome.results.teamWeeklyCost().minor shouldBe outcome.results.values.sumOf { it.weeklyCost.minor }
                outcome.results.teamCumulativeCost().minor shouldBe
                    outcome.results.values.sumOf { it.cumulativeCost.minor }
                outcome.results.teamWeeklyCost().minor shouldBe
                    outcome.results.values.sumOf { it.endingInventory.value * 50L + it.endingBacklog.value * 100L }
            }
        }

        test("[US2.3/AC2.3.4] 遅延: 出荷は 2 週後に下流の入荷、発注は 2 週後に上流の受注、生産要請は 2 週後に工場の入荷になる（BR-02〜BR-04）") {
            checkAll(ITERATIONS, Arb.list(quantities, 3..20), Arb.list(roleDecisions, 3..20)) { demand, decisions ->
                val weeks = minOf(demand.size, decisions.size)
                val played = play(settingsOf(demand.take(weeks)), decisions.take(weeks))
                (0 until weeks - 2).forEach { i ->
                    Role.entries.forEach { role ->
                        val later = played.before[i + 2]
                        // 出荷: 上流の第 i 週の出荷 → 第 i+2 週の入荷（工場は自分の生産要請）
                        val expectedArrival =
                            role.upstream?.let { played.outcomes[i].results[it].shipped }
                                ?: decisions[i][role].toUnits()
                        later[role].arrivals shouldBe expectedArrival
                        // 発注: 下流の第 i 週の発注 → 第 i+2 週の受注（小売店は顧客需要）
                        val expectedOrders =
                            role.downstream?.let { decisions[i][it].toUnits() } ?: u(demand[i + 2])
                        later[role].orders shouldBe expectedOrders
                    }
                }
            }
        }

        test("[US2.3/AC2.3.4] 遅延: 第 1 週の次週の受注と入荷は、初期状態の待ち行列の先頭（キット準拠なら 4）と顧客需要") {
            checkAll(ITERATIONS, Arb.list(quantities, 2..10), roleDecisions) { demand, decision ->
                val played = play(settingsOf(demand), listOf(decision))
                val next = played.outcomes[0].nextStates
                next[Role.RETAILER].orders shouldBe u(demand[1])
                Role.entries.filter { it != Role.RETAILER }.forEach { next[it].orders shouldBe u(4) }
            }
        }

        test("[US2.3/AC2.3.4] 待ち行列の長さは、週が進んでも変わらない（遅延が保たれる）") {
            checkAll(ITERATIONS, statesArb, roleDecisions) { states, decision ->
                val outcome = simulateWeek(settings, w(1), states, decision)
                Role.entries.forEach { role ->
                    outcome.nextStates[role]
                        .orderPipeline.weeks.size shouldBe states[role].orderPipeline.weeks.size
                    outcome.nextStates[role]
                        .deliveryPipeline.weeks.size shouldBe
                        states[role].deliveryPipeline.weeks.size
                }
            }
        }

        test("[US2.3/AC2.3.4] 物の保存: 週の前後で、系全体の（在庫 + 待ち行列 + 入荷）の増減 = 工場の生産要請 - 小売店の出荷") {
            checkAll(ITERATIONS, statesArb, roleDecisions) { states, decision ->
                val outcome = simulateWeek(settings, w(1), states, decision)

                fun RoleMap<RoleState>.stock(): Int =
                    values.sumOf {
                        it.inventory.value + it.arrivals.value +
                            it.deliveryPipeline.weeks.sumOf { x -> x.value }
                    }
                (outcome.nextStates.stock() - states.stock()) shouldBe
                    (decision[Role.FACTORY].value - outcome.results[Role.RETAILER].shipped.value)
            }
        }

        test("[US2.3/AC2.3.4] 小売店の受注は、次週の顧客需要。最終週は 0（BR-11）") {
            checkAll(ITERATIONS, Arb.list(quantities, 2..10)) { demand ->
                val last = settingsOf(demand, finalWeek = demand.size)
                val initial = KitPreset.initialStates(last.demand)
                simulateWeek(last, w(demand.size), initial, same(4)).nextStates[Role.RETAILER].orders shouldBe u(0)
                simulateWeek(last, w(1), initial, same(4)).nextStates[Role.RETAILER].orders shouldBe u(demand[1])
            }
        }
    })
