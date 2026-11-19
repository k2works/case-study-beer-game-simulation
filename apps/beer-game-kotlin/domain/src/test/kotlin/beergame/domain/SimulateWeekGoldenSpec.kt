package beergame.domain

import io.kotest.core.spec.style.FunSpec
import io.kotest.matchers.shouldBe

/**
 * simulateWeek の golden テスト。期待値は、要件定義の業務ルール（BR）から手で導いた値で、実装の出力を貼ったものではない。
 *
 * 前提（BR-13 のキット準拠の初期値）: 各役割の在庫 12、配送・生産の遅れ各段 4、注文の遅れ各段 4、遅延 2 週（BR-02〜BR-04）。
 * 費用方針（BR-09）: 在庫 $0.50 = 50、受注残 $1.00 = 100（最小単位はセント）。
 * 式（BR-05〜BR-08）: 利用可能量 = 前週末在庫 + 当週入荷、充足対象 = 前週末受注残 + 当週受注、
 * 出荷 = min(両者)、週末在庫 = max(0, 利用可能量 - 充足対象)、週末受注残 = max(0, 充足対象 - 利用可能量)。
 */
class SimulateWeekGoldenSpec :
    FunSpec({
        context("キット準拠の初期状態（BR-13）") {
            test("[US2.3/AC2.3.4] 初期状態は、在庫 12・入荷 4・各段 4。小売店の受注だけが第 1 週の顧客需要（BR-11）") {
                val states = KitPreset.initialStates(demandOf(listOf(9, 4, 4), 3))
                Role.entries.forEach { role ->
                    val s = states[role]
                    s.inventory shouldBe u(12)
                    s.backlog shouldBe u(0)
                    s.arrivals shouldBe u(4)
                    s.deliveryPipeline shouldBe Pipeline(listOf(u(4)))
                    s.cumulativeCost shouldBe Money.ZERO
                }
                states[Role.RETAILER].orders shouldBe u(9)
                states[Role.WHOLESALER].orders shouldBe u(4)
                states[Role.DISTRIBUTOR].orders shouldBe u(4)
                states[Role.FACTORY].orders shouldBe u(4)
                // 工場は上流へ発注しない（注文の待ち行列を持たない）
                states[Role.FACTORY].orderPipeline shouldBe Pipeline(emptyList())
                states[Role.RETAILER].orderPipeline shouldBe Pipeline(listOf(u(4)))
            }
        }

        context("定常状態") {
            test("[US2.3/AC2.3.4] 需要 4・発注 4 なら、全役割が出荷 4・在庫 12・週次費用 12 × 50 = 600 で動かない（BR-05〜BR-09）") {
                val played = play(settingsOf(listOf(4, 4, 4, 4)), List(4) { same(4) })
                played.outcomes.forEach { outcome ->
                    Role.entries.forEach { role ->
                        val r = outcome.results[role]
                        r.orders shouldBe u(4)
                        r.shipped shouldBe u(4)
                        r.endingInventory shouldBe u(12)
                        r.endingBacklog shouldBe u(0)
                        r.weeklyCost shouldBe m(600)
                    }
                }
                played.outcomes
                    .last()
                    .results[Role.WHOLESALER]
                    .cumulativeCost shouldBe m(2400)
            }
        }

        context("在庫が減る・受注残が生まれる") {
            test("[US2.3/AC2.3.4] 需要が 4 から 8 に増え発注が 4 のままだと、小売店の在庫は 12 → 8 → 4 → 0 と減る（BR-05〜BR-08）") {
                // 入荷は毎週 4（卸の発注が 4 のまま）。在庫 = 前週末在庫 + 入荷 4 - 受注:
                // 第 1 週 12 + 4 - 4 = 12、第 2 週 12 + 4 - 8 = 8、第 3 週 8 + 4 - 8 = 4、第 4 週 4 + 4 - 8 = 0。
                val played = play(settingsOf(listOf(4, 8, 8, 8)), List(4) { same(4) })
                val retailer = played.outcomes.map { it.results[Role.RETAILER] }
                retailer.map { it.endingInventory } shouldBe listOf(u(12), u(8), u(4), u(0))
                // 週次費用 = 在庫 × 50（BR-09）: 600、400、200、0。累積: 600、1000、1200、1200
                retailer.map { it.weeklyCost } shouldBe listOf(m(600), m(400), m(200), m(0))
                retailer.map { it.cumulativeCost } shouldBe listOf(m(600), m(1000), m(1200), m(1200))
            }
            test("[US2.3/AC2.3.4] 在庫が足りないと受注残が生まれ、翌週に持ち越される（BR-06〜BR-09）") {
                // 第 1 週: 利用可能 12 + 4 = 16、充足対象 0 + 20 = 20 → 出荷 16、在庫 0、受注残 4、費用 4 × 100 = 400。
                // 第 2 週: 利用可能 0 + 4 = 4、充足対象 4 + 4 = 8 → 出荷 4、在庫 0、受注残 4、費用 400、累積 800。
                val played = play(settingsOf(listOf(20, 4)), List(2) { same(4) })
                val week1 = played.outcomes[0].results[Role.RETAILER]
                week1.orders shouldBe u(20)
                week1.shipped shouldBe u(16)
                week1.endingInventory shouldBe u(0)
                week1.endingBacklog shouldBe u(4)
                week1.weeklyCost shouldBe m(400)
                val week2 = played.outcomes[1].results[Role.RETAILER]
                week2.shipped shouldBe u(4)
                week2.endingInventory shouldBe u(0)
                week2.endingBacklog shouldBe u(4)
                week2.weeklyCost shouldBe m(400)
                week2.cumulativeCost shouldBe m(800)
            }
        }

        context("遅延（2 週）") {
            test("[US2.3/AC2.3.4] 小売店の発注 10（第 1 週）は、2 週後の第 3 週に、卸の受注になる（BR-03）") {
                val played =
                    play(
                        settingsOf(listOf(4, 4, 4, 4)),
                        listOf(decisions(4, 4, 4, 10)) + List(3) { same(4) },
                    )
                played.outcomes[0].results[Role.WHOLESALER].orders shouldBe u(4)
                played.outcomes[1].results[Role.WHOLESALER].orders shouldBe u(4)
                played.outcomes[2].results[Role.WHOLESALER].orders shouldBe u(10)
                played.outcomes[3].results[Role.WHOLESALER].orders shouldBe u(4)
            }
            test("[US2.3/AC2.3.4] 卸の出荷（第 3 週に 10）は、2 週後の第 5 週に、小売店の入荷になる（BR-02）") {
                // 第 3 週の卸: 利用可能 12 + 4 = 16 ≥ 充足対象 10 なので、出荷 10。
                val played =
                    play(
                        settingsOf(listOf(4, 4, 4, 4, 4)),
                        listOf(decisions(4, 4, 4, 10)) + List(4) { same(4) },
                    )
                played.outcomes[2].results[Role.WHOLESALER].shipped shouldBe u(10)
                played.before[4][Role.RETAILER].arrivals shouldBe u(10)
                played.before[3][Role.RETAILER].arrivals shouldBe u(4)
            }
            test("[US2.3/AC2.3.4] 工場の生産要請 10（第 1 週）は、2 週後の第 3 週に工場在庫へ入る（BR-04）") {
                // 第 3 週の工場: 12 + 10 - 4 = 18。第 2 週までは 12 + 4 - 4 = 12。
                val played =
                    play(
                        settingsOf(listOf(4, 4, 4, 4)),
                        listOf(decisions(10, 4, 4, 4)) + List(3) { same(4) },
                    )
                played.outcomes[1].results[Role.FACTORY].endingInventory shouldBe u(12)
                played.outcomes[2].results[Role.FACTORY].endingInventory shouldBe u(18)
            }
        }

        context("4 役割が変化する 3 週の系列（手計算）") {
            // 需要 [8, 4, 4]。第 1 週の発注: 工場 6、一次卸 5、二次卸 7、小売店 9。以降は全員 4。
            //
            // 第 1 週（受注 R=8、W=4、D=4、F=4。入荷はすべて 4）
            //   R: 利用可能 16、充足対象 8 → 出荷 8、在庫 8、費用 400
            //   W/D/F: 利用可能 16、充足対象 4 → 出荷 4、在庫 12、費用 600
            // 第 2 週の受注（BR-03: 注文は 2 週遅れ）: R=4（需要）、W=4（R の第 0 週の発注の段）、D=4、F=4
            //   R: 利用可能 8 + 4 = 12、充足対象 4 → 出荷 4、在庫 8、費用 400（累積 800）
            //   W/D/F: 利用可能 12 + 4 = 16、充足対象 4 → 出荷 4、在庫 12、費用 600（累積 1200）
            // 第 3 週の受注: R=4（需要）、W=9（R の第 1 週の発注）、D=7（W の第 1 週の発注）、F=5（D の第 1 週の発注）
            // 第 3 週の入荷: R=W の第 1 週の出荷 4、W=D の第 1 週の出荷 4、D=F の第 1 週の出荷 4、F=6（工場の第 1 週の生産要請 6。BR-04）
            //   R: 利用可能 8 + 4 = 12、充足対象 4 → 出荷 4、在庫 8、費用 400（累積 1200）
            //   W: 利用可能 12 + 4 = 16、充足対象 9 → 出荷 9、在庫 7、費用 350（累積 1550）
            //   D: 利用可能 12 + 4 = 16、充足対象 7 → 出荷 7、在庫 9、費用 450（累積 1650）
            //   F: 利用可能 12 + 6 = 18、充足対象 5 → 出荷 5、在庫 13、費用 650（累積 1850）
            val played =
                play(
                    settingsOf(listOf(8, 4, 4)),
                    listOf(decisions(6, 5, 7, 9), same(4), same(4)),
                )

            test("[US2.3/AC2.3.4] 第 1 週の役割別の結果") {
                val results = played.outcomes[0].results
                results[Role.RETAILER] shouldBe
                    RoleWeekResult(u(8), u(8), q(9), u(8), u(0), m(400), m(400))
                results[Role.WHOLESALER] shouldBe
                    RoleWeekResult(u(4), u(4), q(7), u(12), u(0), m(600), m(600))
                results[Role.DISTRIBUTOR] shouldBe
                    RoleWeekResult(u(4), u(4), q(5), u(12), u(0), m(600), m(600))
                results[Role.FACTORY] shouldBe
                    RoleWeekResult(u(4), u(4), q(6), u(12), u(0), m(600), m(600))
            }
            test("[US2.3/AC2.3.4] 第 2 週の役割別の結果") {
                val results = played.outcomes[1].results
                results[Role.RETAILER] shouldBe
                    RoleWeekResult(u(4), u(4), q(4), u(8), u(0), m(400), m(800))
                Role.entries.filter { it != Role.RETAILER }.forEach {
                    results[it] shouldBe RoleWeekResult(u(4), u(4), q(4), u(12), u(0), m(600), m(1200))
                }
            }
            test("[US2.3/AC2.3.4] 第 3 週の役割別の結果（遅れて届いた発注と生産要請が効く）") {
                val results = played.outcomes[2].results
                results[Role.RETAILER] shouldBe
                    RoleWeekResult(u(4), u(4), q(4), u(8), u(0), m(400), m(1200))
                results[Role.WHOLESALER] shouldBe
                    RoleWeekResult(u(9), u(9), q(4), u(7), u(0), m(350), m(1550))
                results[Role.DISTRIBUTOR] shouldBe
                    RoleWeekResult(u(7), u(7), q(4), u(9), u(0), m(450), m(1650))
                results[Role.FACTORY] shouldBe
                    RoleWeekResult(u(5), u(5), q(4), u(13), u(0), m(650), m(1850))
            }
            test("[US2.3/AC2.3.5] チームの週次費用と累積費用は 4 役割の合計") {
                // 第 3 週の週次: 400 + 350 + 450 + 650 = 1850。累積: 1200 + 1550 + 1650 + 1850 = 6250（BR-09）。
                played.outcomes[2].results.teamWeeklyCost() shouldBe m(1850)
                played.outcomes[2].results.teamCumulativeCost() shouldBe m(6250)
            }
        }

        context("最終週") {
            test("[US2.3/AC2.3.4] 最終週の次の週は無いので、次週の状態の小売店の受注は 0（顧客需要を読まない）") {
                val played = play(settingsOf(listOf(4, 4), finalWeek = 2), List(2) { same(4) })
                played.outcomes[0].nextStates[Role.RETAILER].orders shouldBe u(4)
                played.outcomes[1].nextStates[Role.RETAILER].orders shouldBe u(0)
            }
            test("[US1.1/AC1.1.2] 需要系列が最終週より長くても、最終週の次の需要は使わない") {
                val settings = SimulationSettings(w(1), demandOf(listOf(4, 99), 1), KitPreset.costPolicy)
                val outcome = simulateWeek(settings, w(1), KitPreset.initialStates(settings.demand), same(4))
                outcome.nextStates[Role.RETAILER].orders shouldBe u(0)
            }
        }

        context("遅延 1 週（待ち行列が空）") {
            test("[US2.3/AC2.3.4] 発注と出荷は、次週にそのまま届く（BR-02・BR-03 の遅延を 1 にした場合）") {
                // 待ち行列を空にした状態: 週の開始時の入荷と受注だけを持つ。
                val empty = Pipeline(emptyList())
                val states =
                    RoleMap.all(
                        RoleState(
                            inventory = u(12),
                            backlog = u(0),
                            orderPipeline = empty,
                            deliveryPipeline = empty,
                            cumulativeCost = Money.ZERO,
                            arrivals = u(4),
                            orders = u(4),
                        ),
                    )
                val settings = settingsOf(listOf(4, 4, 4))
                val outcome = simulateWeek(settings, w(1), states, decisions(7, 5, 3, 9))
                // 小売店の発注 9 は次週の卸の受注、卸の発注 3 は次週の一次卸の受注、一次卸の発注 5 は次週の工場の受注
                outcome.nextStates[Role.WHOLESALER].orders shouldBe u(9)
                outcome.nextStates[Role.DISTRIBUTOR].orders shouldBe u(3)
                outcome.nextStates[Role.FACTORY].orders shouldBe u(5)
                // 工場の生産要請 7 は次週の工場の入荷。他は、上流の第 1 週の出荷（4）が次週の入荷
                outcome.nextStates[Role.FACTORY].arrivals shouldBe u(7)
                outcome.nextStates[Role.DISTRIBUTOR].arrivals shouldBe u(4)
                outcome.nextStates[Role.WHOLESALER].arrivals shouldBe u(4)
                outcome.nextStates[Role.RETAILER].arrivals shouldBe u(4)
            }
        }
    })
