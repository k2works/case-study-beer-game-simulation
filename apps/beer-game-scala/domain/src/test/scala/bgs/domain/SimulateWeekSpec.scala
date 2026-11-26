package bgs.domain

import munit.ScalaCheckSuite
import org.scalacheck.Prop.forAll
import org.scalacheck.Gen

/** 週次計算（純粋関数）。キットの初期状態から手で計算した値（golden）と、性質で守る。 */
class SimulateWeekSpec extends ScalaCheckSuite:

  private def quantity(n: Int): Quantity = Quantity.of(n).getOrElse(fail(s"$n は作れる"))
  private def week(n: Int): Week = Week.of(n).getOrElse(fail(s"$n は作れる"))

  /** 需要: 第 1 週 4、第 2 週以降 8（ブルウィップ効果を見るための階段）。最終週 12。 */
  private val demand = DemandSeries(Vector.tabulate(12)(i => quantity(if i == 0 then 4 else 8)))
  private val settings = SimulationSettings(week(12), demand, KitPreset.costPolicy)

  private def decisions(factory: Int, distributor: Int, wholesaler: Int, retailer: Int) =
    RoleMap(quantity(factory), quantity(distributor), quantity(wholesaler), quantity(retailer))

  test("[AC2.3.4 golden] 第 1 週: 需要 4・全役割が発注 4 なら、全役割の在庫は 12 のまま、費用は 600") {
    val outcome =
      simulateWeek(settings, week(1), KitPreset.initialStates(demand), decisions(4, 4, 4, 4))
    outcome.results.values.foreach { r =>
      assertEquals(r.orders.value, 4L)
      assertEquals(r.shipped.value, 4L)
      assertEquals(r.endingInventory.value, 12L)
      assertEquals(r.endingBacklog.value, 0L)
      assertEquals(r.weeklyCost.minor, 600L)
      assertEquals(r.cumulativeCost.minor, 600L)
    }
    // 次週（第 2 週）の状態: 小売店の受注は第 2 週の顧客需要 8、他は 4。入荷はすべて 4
    val next = outcome.nextStates
    assertEquals(next.values.map(_.orders.value), List(4L, 4L, 4L, 8L))
    assertEquals(next.values.map(_.arrivals.value), List(4L, 4L, 4L, 4L))
    assertEquals(next.values.map(_.inventory.value), List(12L, 12L, 12L, 12L))
  }

  test("[AC2.3.4 golden] 第 2 週: 小売店だけ需要 8・発注 8 なら、小売店の在庫は 8 に減り、費用は 400 になる") {
    val week1 =
      simulateWeek(settings, week(1), KitPreset.initialStates(demand), decisions(4, 4, 4, 4))
    val week2 = simulateWeek(settings, week(2), week1.nextStates, decisions(4, 4, 4, 8))
    val retailer = week2.results(Role.Retailer)
    assertEquals(retailer.orders.value, 8L)
    assertEquals(retailer.shipped.value, 8L)
    assertEquals(retailer.endingInventory.value, 8L)
    assertEquals(retailer.weeklyCost.minor, 400L)
    assertEquals(retailer.cumulativeCost.minor, 1000L)
    assertEquals(week2.results(Role.Wholesaler).cumulativeCost.minor, 1200L)
    // 第 3 週: 小売店の発注 8 は待ち行列に入り（遅延 2 週）、卸の受注はまだ 4
    val next = week2.nextStates
    assertEquals(next(Role.Retailer).orderPipeline.weeks.map(_.value), List(8L))
    assertEquals(next(Role.Wholesaler).orders.value, 4L)
    assertEquals(next(Role.Retailer).orders.value, 8L)
  }

  test("[遅延] 発注は 2 週遅れて上流の受注になる（第 1 週の小売店の発注 8 は第 3 週に卸の受注になる）") {
    val s1 = simulateWeek(settings, week(1), KitPreset.initialStates(demand), decisions(4, 4, 4, 8))
    val s2 = simulateWeek(settings, week(2), s1.nextStates, decisions(4, 4, 4, 4))
    assertEquals(s2.nextStates(Role.Wholesaler).orders.value, 8L)
  }

  test("[最終週] 最終週の次週は無いので、小売店の次週の受注は 0") {
    val last = SimulationSettings(week(1), demand, KitPreset.costPolicy)
    val outcome =
      simulateWeek(last, week(1), KitPreset.initialStates(demand), decisions(4, 4, 4, 4))
    assertEquals(outcome.nextStates(Role.Retailer).orders.value, 0L)
  }

  test("[決定論] 同じ入力から、常に同じ結果を返す") {
    val a = simulateWeek(settings, week(1), KitPreset.initialStates(demand), decisions(4, 5, 6, 7))
    val b = simulateWeek(settings, week(1), KitPreset.initialStates(demand), decisions(4, 5, 6, 7))
    assertEquals(a, b)
  }

  private val genDecisions: Gen[RoleMap[Quantity]] =
    for
      a <- Gen.choose(0, 1000)
      b <- Gen.choose(0, 1000)
      c <- Gen.choose(0, 1000)
      d <- Gen.choose(0, 1000)
    yield decisions(a, b, c, d)

  property("[BR-08] 週末に、在庫と受注残の両方が正になることはない") {
    forAll(genDecisions) { ds =>
      val outcome = simulateWeek(settings, week(1), KitPreset.initialStates(demand), ds)
      outcome.results.values.forall(r =>
        r.endingInventory.value == 0L || r.endingBacklog.value == 0L
      )
    }
  }

  property("[BR-07] 出荷は、手持ちと受注残 + 受注のどちらも超えない") {
    forAll(genDecisions) { ds =>
      val states = KitPreset.initialStates(demand)
      val outcome = simulateWeek(settings, week(1), states, ds)
      Role.values.toList.forall { role =>
        val s = states(role)
        val shipped = outcome.results(role).shipped.value
        shipped <= s.inventory.value + s.arrivals.value && shipped <= s.backlog.value + s.orders.value
      }
    }
  }

  property("[BR-09] 週の費用は、在庫単価 × 在庫 + 受注残単価 × 受注残で、累積に足される") {
    forAll(genDecisions) { ds =>
      val outcome = simulateWeek(settings, week(1), KitPreset.initialStates(demand), ds)
      outcome.results.values.forall { r =>
        r.weeklyCost.minor == 50L * r.endingInventory.value + 100L * r.endingBacklog.value &&
        r.cumulativeCost.minor == r.weeklyCost.minor
      }
    }
  }
