package beergame.domain

import arrow.core.Either
import arrow.core.left
import arrow.core.right

/** 発注数・生産要請数。0〜1000 の整数（BR-10）。 */
@Term("発注量", "各週に、役割が上流へ注文する数量。0〜1000 の整数", "BR-10")
@JvmInline
value class Quantity private constructor(
    val value: Int,
) {
    fun toUnits(): Units = Units(value)

    companion object {
        const val MAX = 1000

        fun of(n: Int): Either<ValidationError.QuantityOutOfRange, Quantity> =
            if (n in 0..MAX) Quantity(n).right() else ValidationError.QuantityOutOfRange(n, MAX).left()
    }
}

/**
 * 上限のない非負の数量。在庫・受注残・出荷・待ち行列の中身に使う。
 * 発注（[Quantity]）は 0〜1000 だが、受注残の持ち越しなどで在庫や出荷は 1000 を超えうる。
 */
@JvmInline
value class Units internal constructor(
    val value: Int,
) : Comparable<Units> {
    operator fun plus(other: Units): Units = Units(value + other.value)

    /** 引いた結果が負なら 0（`max(0, this - other)`。BR-08）。 */
    fun minusToZero(other: Units): Units = Units(maxOf(0, value - other.value))

    override fun compareTo(other: Units): Int = value.compareTo(other.value)

    companion object {
        fun of(n: Int): Either<ValidationError.UnitsNegative, Units> =
            when {
                n < 0 -> ValidationError.UnitsNegative(n).left()
                else -> Units(n).right()
            }
    }
}
