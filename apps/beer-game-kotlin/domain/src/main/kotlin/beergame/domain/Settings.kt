package beergame.domain

import arrow.core.Either
import arrow.core.NonEmptyList
import arrow.core.flatMap
import arrow.core.left
import arrow.core.mapOrAccumulate
import arrow.core.nonEmptyListOf
import arrow.core.raise.either
import arrow.core.raise.zipOrAccumulate
import arrow.core.right

/** 費用方針。在庫と受注残の、1 単位 1 週あたりの単価（最小単位）。 */
data class CostPolicy(
    val holding: Money,
    val backlog: Money,
) {
    companion object {
        /** 複数の誤りは項目ごとにすべて集めて返す。 */
        fun of(
            holdingMinor: Long,
            backlogMinor: Long,
        ): Either<NonEmptyList<ValidationError>, CostPolicy> =
            either {
                zipOrAccumulate(
                    { Money.of(holdingMinor).bind() },
                    { Money.of(backlogMinor).bind() },
                ) { holding, backlog -> CostPolicy(holding, backlog) }
            }
    }
}

/** 各週の顧客需要。週は 1 始まりで、系列の外の週は 0。 */
@JvmInline
value class DemandSeries private constructor(
    private val weeks: List<Units>,
) {
    fun at(week: Week): Units = weeks.getOrNull(week.value - 1) ?: Units(0)

    /** 系列そのもの（週 1 から順の整数）。永続化の往復（イベントの JSON への変換）に使う。 */
    fun asInts(): List<Int> = weeks.map { it.value }

    /** 次の週の需要（週の値は 1 始まりなので、0 始まりの添字としてそのまま次の週を指す）。 */
    fun after(week: Week): Units = weeks.getOrNull(week.value) ?: Units(0)

    companion object {
        private const val REASON_RANGE = "需要は 0〜1000 の整数"

        /**
         * 各週の需要は 0〜1000、長さは [finalWeek] 以上（AC1.1.2）。
         * 範囲外の誤りは対象週（1 始まり）ごとにすべて集める。各週が正しい場合だけ、長さを検査する。
         */
        fun of(
            values: List<Int>,
            finalWeek: Week,
        ): Either<NonEmptyList<ValidationError>, DemandSeries> =
            values
                .withIndex()
                .mapOrAccumulate { (index, n) ->
                    Quantity
                        .of(n)
                        .mapLeft { ValidationError.DemandSeriesInvalid(index + 1, REASON_RANGE) }
                        .bind()
                        .toUnits()
                }.flatMap { weeks ->
                    if (weeks.size < finalWeek.value) {
                        nonEmptyListOf<ValidationError>(
                            ValidationError.DemandSeriesInvalid(weeks.size + 1, "需要系列が最終週（${finalWeek.value}）に届かない"),
                        ).left()
                    } else {
                        DemandSeries(weeks).right()
                    }
                }
    }
}
