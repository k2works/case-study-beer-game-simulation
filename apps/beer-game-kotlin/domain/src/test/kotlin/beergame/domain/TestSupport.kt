package beergame.domain

import arrow.core.Either
import arrow.core.getOrElse
import io.kotest.assertions.fail
import io.kotest.property.Arb
import io.kotest.property.arbitrary.int
import io.kotest.property.arbitrary.list
import io.kotest.property.arbitrary.map

/** 検証済みの値を作るテスト補助。検証に失敗したらテストを失敗させる（`!!` や例外は使わない）。 */
internal fun <E, A> Either<E, A>.valid(what: String): A = getOrElse { fail("$what が不正: $it") }

fun q(n: Int): Quantity = Quantity.of(n).valid("Quantity($n)")

fun u(n: Int): Units = Units.of(n).valid("Units($n)")

fun w(n: Int): Week = Week.of(n).valid("Week($n)")

fun m(n: Long): Money = Money.of(n).valid("Money($n)")

/** 4 役割に同じ数量を入れる。 */
fun same(n: Int): RoleMap<Quantity> = RoleMap.all(q(n))

/** 上流から下流の順（工場、一次卸、二次卸、小売店）で数量を指定する。 */
fun decisions(
    factory: Int,
    distributor: Int,
    wholesaler: Int,
    retailer: Int,
): RoleMap<Quantity> = RoleMap(q(factory), q(distributor), q(wholesaler), q(retailer))

fun demandOf(
    values: List<Int>,
    finalWeek: Int,
): DemandSeries = DemandSeries.of(values, w(finalWeek)).valid("DemandSeries($values)")

/** キット準拠の費用方針（在庫 0.50、受注残 1.00。最小単位はセント）で、需要系列を与えた設定。 */
fun settingsOf(
    demand: List<Int>,
    finalWeek: Int = demand.size,
): SimulationSettings = SimulationSettings(w(finalWeek), demandOf(demand, finalWeek), KitPreset.costPolicy)

/** 1 週ずつ `simulateWeek` を回した記録。`before[i]` は第 i+1 週の開始時の状態、`outcomes[i]` はその週の結果。 */
data class Played(
    val settings: SimulationSettings,
    val decisions: List<RoleMap<Quantity>>,
    val before: List<RoleMap<RoleState>>,
    val outcomes: List<WeekOutcome>,
)

fun play(
    settings: SimulationSettings,
    decisions: List<RoleMap<Quantity>>,
    initial: RoleMap<RoleState> = KitPreset.initialStates(settings.demand),
): Played {
    val steps =
        decisions.foldIndexed(listOf(initial to listOf<WeekOutcome>())) { index, acc, decision ->
            val (states, _) = acc.last()
            val outcome = simulateWeek(settings, w(index + 1), states, decision)
            acc + (outcome.nextStates to listOf(outcome))
        }
    return Played(
        settings = settings,
        decisions = decisions,
        before = steps.dropLast(1).map { it.first },
        outcomes = steps.drop(1).map { it.second.single() },
    )
}

val quantities: Arb<Int> = Arb.int(0..1000)

val roleDecisions: Arb<RoleMap<Quantity>> =
    Arb.list(quantities, 4..4).map { v -> decisions(v[0], v[1], v[2], v[3]) }
