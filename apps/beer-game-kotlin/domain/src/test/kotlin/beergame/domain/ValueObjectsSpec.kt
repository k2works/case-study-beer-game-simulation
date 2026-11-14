package beergame.domain

import arrow.core.Either
import arrow.core.left
import arrow.core.nonEmptyListOf
import arrow.core.right
import io.kotest.core.spec.style.FunSpec
import io.kotest.matchers.shouldBe
import io.kotest.property.Arb
import io.kotest.property.arbitrary.int
import io.kotest.property.checkAll
import java.util.UUID

class ValueObjectsSpec :
    FunSpec({
        context("[US2.2/AC2.2.1] Quantity は 0〜1000 の整数だけを受け付ける") {
            listOf(-1, 1001, Int.MIN_VALUE, Int.MAX_VALUE).forEach { n ->
                test("[US2.2/AC2.2.2] 範囲外 $n は QuantityOutOfRange を返す") {
                    Quantity.of(n) shouldBe ValidationError.QuantityOutOfRange(n, 1000).left()
                }
            }
            listOf(0, 1, 999, 1000).forEach { n ->
                test("[US2.2/AC2.2.1] 範囲内 $n は受け付ける") {
                    Quantity.of(n).map { it.value } shouldBe n.right()
                }
            }
            test("[US2.2/AC2.2.1] 範囲内のすべての整数が受理され、外はすべて拒否される（性質）") {
                checkAll(Arb.int(-5000..5000)) { n ->
                    Quantity.of(n).isRight() shouldBe (n in 0..1000)
                }
            }
            test("[US2.2/AC2.2.1] Units に変換しても値が同じ") {
                q(7).toUnits() shouldBe u(7)
            }
        }

        context("[US1.1/AC1.1.5] Week は 1〜50 の整数だけを受け付ける") {
            listOf(0, -1, 51).forEach { n ->
                test("範囲外 $n は WeekOutOfRange を返す") {
                    Week.of(n) shouldBe ValidationError.WeekOutOfRange(n, 50).left()
                }
            }
            listOf(1, 2, 49, 50).forEach { n ->
                test("範囲内 $n は受け付ける") {
                    Week.of(n).map { it.value } shouldBe n.right()
                }
            }
            test("next は 1 週進め、最終の 50 の次は無い") {
                w(1).next() shouldBe w(2)
                w(49).next() shouldBe w(50)
                w(50).next() shouldBe null
            }
            test("週は順序を持つ") {
                (w(2) < w(3)) shouldBe true
                (w(50) > w(1)) shouldBe true
            }
        }

        context("Units（数量の非負の流れ・在庫。上限なし）") {
            test("負数は UnitsNegative を返す") {
                Units.of(-1) shouldBe ValidationError.UnitsNegative(-1).left()
            }
            test("0 と大きい値は受け付ける") {
                Units.of(0).map { it.value } shouldBe 0.right()
                Units.of(1_000_000).map { it.value } shouldBe 1_000_000.right()
            }
            test("足し算と、下限 0 の引き算と、小さい方") {
                (u(3) + u(4)) shouldBe u(7)
                u(10).minusToZero(u(4)) shouldBe u(6)
                u(4).minusToZero(u(10)) shouldBe u(0)
                minOf(u(3), u(9)) shouldBe u(3)
            }
        }

        context("Money（最小単位の整数の金額。負数は不可）") {
            test("負数は MoneyNegative を返す") {
                Money.of(-1) shouldBe ValidationError.MoneyNegative(-1).left()
            }
            test("0 と正の値は受け付ける") {
                Money.of(0).map { it.minor } shouldBe 0L.right()
                Money.of(50).map { it.minor } shouldBe 50L.right()
            }
            test("加算と、数量との掛け算") {
                (m(50) + m(100)) shouldBe m(150)
                (m(50) * u(12)) shouldBe m(600)
                Money.ZERO shouldBe m(0)
            }
        }

        context("[US1.2/AC1.2.1] DisplayName は前後の空白を除いて 1〜80 文字") {
            test("空文字は長さ 0 で拒否する") {
                DisplayName.of("") shouldBe ValidationError.DisplayNameInvalid(0).left()
            }
            test("空白だけは長さ 0 で拒否する（全角空白を含む）") {
                DisplayName.of("  　 ") shouldBe ValidationError.DisplayNameInvalid(0).left()
            }
            test("1 文字は受け付ける") {
                DisplayName.of("あ").map { it.value } shouldBe "あ".right()
            }
            test("前後の空白は除く") {
                DisplayName.of("  たろう  ").map { it.value } shouldBe "たろう".right()
            }
            test("80 文字は受け付け、81 文字は拒否する") {
                DisplayName.of("あ".repeat(80)).map { it.value.length } shouldBe 80.right()
                DisplayName.of("あ".repeat(81)) shouldBe ValidationError.DisplayNameInvalid(81).left()
            }
            test("空白を除いた後の長さで数える（空白で 81 文字になっても受け付ける）") {
                DisplayName.of(" " + "あ".repeat(80) + " ").map { it.value.length } shouldBe 80.right()
            }
            test("サロゲートペアの文字は 1 文字と数える") {
                DisplayName.of("🍺".repeat(80)).isRight() shouldBe true
                DisplayName.of("🍺".repeat(81)) shouldBe ValidationError.DisplayNameInvalid(81).left()
            }
            test("内側の空白は保つ") {
                DisplayName.of("a  b").map { it.value } shouldBe "a  b".right()
            }
        }

        context("版（StreamVersion・DecisionVersion）") {
            test("StreamVersion は 0 以上で、next で 1 増える") {
                StreamVersion.of(-1) shouldBe ValidationError.VersionNegative(-1).left()
                StreamVersion.of(0) shouldBe StreamVersion.ZERO.right()
                StreamVersion.ZERO.next().value shouldBe 1L
            }
            test("DecisionVersion は 0 以上で、next で 1 増える") {
                DecisionVersion.of(-1) shouldBe ValidationError.VersionNegative(-1).left()
                DecisionVersion.of(3) shouldBe
                    DecisionVersion.ZERO
                        .next()
                        .next()
                        .next()
                        .right()
            }
            test("同じ値は等しい") {
                (StreamVersion.ZERO.next() == StreamVersion.ZERO.next()) shouldBe true
            }
        }

        context("識別子") {
            val uuid = UUID.fromString("00000000-0000-4000-8000-000000000001")
            test("GameId と ParticipantId は UUID を包み、型が別") {
                GameId(uuid).value shouldBe uuid
                ParticipantId(uuid).value shouldBe uuid
            }
        }

        context("Role と RoleMap") {
            test("役割は上流から下流の順に 4 つ") {
                Role.entries shouldBe listOf(Role.FACTORY, Role.DISTRIBUTOR, Role.WHOLESALER, Role.RETAILER)
            }
            test("上流・下流は鎖になり、両端には無い") {
                Role.FACTORY.upstream shouldBe null
                Role.FACTORY.downstream shouldBe Role.DISTRIBUTOR
                Role.DISTRIBUTOR.upstream shouldBe Role.FACTORY
                Role.WHOLESALER.downstream shouldBe Role.RETAILER
                Role.RETAILER.upstream shouldBe Role.WHOLESALER
                Role.RETAILER.downstream shouldBe null
            }
            test("RoleMap は役割で値を引ける") {
                val map = RoleMap(1, 2, 3, 4)
                Role.entries.map { map[it] } shouldBe listOf(1, 2, 3, 4)
                map.values shouldBe listOf(1, 2, 3, 4)
            }
            test("map は 4 役割すべてに適用し、all は同じ値で埋め、of は役割から作る") {
                RoleMap(1, 2, 3, 4).map { _, v -> v * 10 } shouldBe RoleMap(10, 20, 30, 40)
                RoleMap(1, 2, 3, 4).map { role, _ -> role } shouldBe
                    RoleMap(Role.FACTORY, Role.DISTRIBUTOR, Role.WHOLESALER, Role.RETAILER)
                RoleMap.all(0) shouldBe RoleMap(0, 0, 0, 0)
                RoleMap.of { it.ordinal } shouldBe RoleMap(0, 1, 2, 3)
            }
        }

        context("[US1.1/AC1.1.2] CostPolicy と DemandSeries は誤りを集めて返す") {
            test("費用方針の複数の誤りは、項目ごとにすべて集める") {
                CostPolicy.of(-1, -2) shouldBe
                    nonEmptyListOf<ValidationError>(
                        ValidationError.MoneyNegative(-1),
                        ValidationError.MoneyNegative(-2),
                    ).left()
            }
            test("費用方針の正しい値は受け付ける") {
                CostPolicy.of(50, 100) shouldBe CostPolicy(m(50), m(100)).right()
            }
            test("需要系列の誤りは、対象週（1 始まり）ごとにすべて集める") {
                val result = DemandSeries.of(listOf(4, -1, 4, 1001), w(4))
                result shouldBe
                    nonEmptyListOf<ValidationError>(
                        ValidationError.DemandSeriesInvalid(weekIndex = 2, reason = "需要は 0〜1000 の整数"),
                        ValidationError.DemandSeriesInvalid(weekIndex = 4, reason = "需要は 0〜1000 の整数"),
                    ).left()
            }
            test("需要系列が最終週に届かないときは、足りない最初の週を示す") {
                DemandSeries.of(listOf(4, 4, 4), w(5)) shouldBe
                    nonEmptyListOf<ValidationError>(
                        ValidationError.DemandSeriesInvalid(weekIndex = 4, reason = "需要系列が最終週（5）に届かない"),
                    ).left()
            }
            test("正しい需要系列は、週で引け、系列の外は 0") {
                val demand = demandOf(listOf(4, 8, 6), 3)
                demand.at(w(1)) shouldBe u(4)
                demand.at(w(2)) shouldBe u(8)
                demand.at(w(3)) shouldBe u(6)
                demand.at(w(4)) shouldBe u(0)
                demand.after(w(1)) shouldBe u(8)
                demand.after(w(2)) shouldBe u(6)
                demand.after(w(3)) shouldBe u(0)
            }
            test("最終週より長い系列も受け付ける") {
                (DemandSeries.of(listOf(1, 2, 3), w(2)) is Either.Right) shouldBe true
            }
        }
    })
