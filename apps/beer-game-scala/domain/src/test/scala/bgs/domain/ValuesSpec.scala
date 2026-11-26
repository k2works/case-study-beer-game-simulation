package bgs.domain

import munit.FunSuite

/** 値オブジェクトの不変条件（生成時に検証し、不正な値が存在できない）。 */
class ValuesSpec extends FunSuite:

  test("[BR-10] 発注量は 0〜1000 の整数で、範囲内なら作れる") {
    assertEquals(Quantity.of(0).map(_.value), Right(0))
    assertEquals(Quantity.of(1000).map(_.value), Right(1000))
  }

  test("[BR-10] 発注量が範囲外なら、実際の値と上限を持つ誤りを返す") {
    assertEquals(Quantity.of(-1), Left(ValidationError.QuantityOutOfRange(-1, 1000)))
    assertEquals(Quantity.of(1001), Left(ValidationError.QuantityOutOfRange(1001, 1000)))
  }

  test("[AC1.1.5] 週は 1〜50 の整数で、50 の次は無い") {
    assertEquals(Week.of(1).map(_.value), Right(1))
    assertEquals(Week.of(0), Left(ValidationError.WeekOutOfRange(0, 50)))
    assertEquals(Week.of(51), Left(ValidationError.WeekOutOfRange(51, 50)))
    assertEquals(Week.of(49).toOption.flatMap(_.next).map(_.value), Some(50))
    assertEquals(Week.of(50).toOption.flatMap(_.next), None)
  }

  test("[BR-08] 数量は負にならず、引いた結果が負なら 0 になる") {
    assertEquals(Units.of(-1), Left(ValidationError.UnitsNegative(-1)))
    val five = Units.of(5).getOrElse(fail("5 は作れる"))
    val eight = Units.of(8).getOrElse(fail("8 は作れる"))
    assertEquals(five.minusToZero(eight).value, 0L)
    assertEquals(eight.minusToZero(five).value, 3L)
    assertEquals((five + eight).value, 13L)
  }

  test("[BR-09] 金額は最小単位の整数で、負にならない。単価 × 数量で費用になる") {
    assertEquals(Money.of(-1), Left(ValidationError.MoneyNegative(-1)))
    val price = Money.of(50).getOrElse(fail("50 は作れる"))
    val units = Units.of(12).getOrElse(fail("12 は作れる"))
    assertEquals((price * units).minor, 600L)
    assertEquals((Money.Zero + price).minor, 50L)
  }
