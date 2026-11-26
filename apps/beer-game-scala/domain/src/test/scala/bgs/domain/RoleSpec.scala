package bgs.domain

import cats.{Eq, Functor}
import cats.laws.discipline.FunctorTests
import munit.DisciplineSuite
import org.scalacheck.{Arbitrary, Gen}

/** 役割と、4 役割が揃うコンテナ。 */
class RoleSpec extends DisciplineSuite:

  test("[用語 役割] 上流から下流の順に並び、発注先は 1 つ上流、受注元は 1 つ下流") {
    assertEquals(Role.Factory.upstream, None)
    assertEquals(Role.Distributor.upstream, Some(Role.Factory))
    assertEquals(Role.Retailer.upstream, Some(Role.Wholesaler))
    assertEquals(Role.Factory.downstream, Some(Role.Distributor))
    assertEquals(Role.Retailer.downstream, None)
  }

  test("[RoleMap] 4 役割すべての値を持ち、役割で引ける") {
    val m = RoleMap(1, 2, 3, 4)
    assertEquals(m(Role.Factory), 1)
    assertEquals(m(Role.Retailer), 4)
    assertEquals(m.values, List(1, 2, 3, 4))
  }

  test("[RoleMap] map は役割も受け取り、全役割に適用する") {
    val labeled = RoleMap.all(10).map((role, n) => s"${role.toString}:$n")
    assertEquals(
      labeled.values,
      List("Factory:10", "Distributor:10", "Wholesaler:10", "Retailer:10")
    )
  }

  test("[RoleMap] of は役割から値を作る") {
    assertEquals(RoleMap.of(_.ordinal).values, List(0, 1, 2, 3))
  }

  private given [A: Arbitrary]: Arbitrary[RoleMap[A]] =
    Arbitrary(Gen.resultOf((a: A, b: A, c: A, d: A) => RoleMap(a, b, c, d)))
  private given [A: Eq]: Eq[RoleMap[A]] =
    Eq.by(m => (m.factory, m.distributor, m.wholesaler, m.retailer))

  checkAll("RoleMap.FunctorLaws", FunctorTests[RoleMap].functor[Int, Int, String])

  test("[RoleMap] Functor の map は役割を使わず、全役割に適用する") {
    assertEquals(Functor[RoleMap].map(RoleMap(1, 2, 3, 4))(_ * 2).values, List(2, 4, 6, 8))
  }
