package beergame.domain

/**
 * 待ち行列。まだ届かない品物（または注文）を、届く順に並べる。
 *
 * 当週に届く分は [RoleState.arrivals]・[RoleState.orders] が持つので、待ち行列は「次週以降に届く分」だけを持つ。
 * したがって長さは `遅延 - 1`（キットの 2 週遅延なら 1 段）で、遅延 1 週なら空になる。
 */
@CoreConcept(
    "シミュレーション計算",
    "遅延の表現。注文と出荷が遅れて届くことが、変動の増幅（ブルウィップ効果）の原因で、教材が見せたい現象そのもの。長さは遅延 - 1",
)
@JvmInline
value class Pipeline(
    val weeks: List<Units>,
) {
    /** 末尾に [inflow]（今週流し始めた分）を加え、先頭（次週に届く分）を取り出す。長さは変わらない。 */
    fun advance(inflow: Units): Advance {
        val all = weeks + inflow
        return Advance(arrived = all.first(), rest = Pipeline(all.drop(1)))
    }

    data class Advance(
        val arrived: Units,
        val rest: Pipeline,
    )
}

/**
 * 1 役割の週の開始時の状態。
 *
 * - [arrivals]: 当週に処理する入荷（工場では生産の完了分）。
 * - [orders]: 当週の受注（小売店では当週の顧客需要）。どちらも、前の週の確定が次週分まで計算して入れる。
 * - [orderPipeline]: 上流へ送った注文のうち、まだ上流に届かない分（工場は上流が無いので常に空）。
 * - [deliveryPipeline]: 上流から（工場は自分の生産から）まだ届かない品物。
 */
data class RoleState(
    val inventory: Units,
    val backlog: Units,
    val orderPipeline: Pipeline,
    val deliveryPipeline: Pipeline,
    val cumulativeCost: Money,
    val arrivals: Units,
    val orders: Units,
)

/** 役割別の週結果（AC2.3.5）。 */
data class RoleWeekResult(
    val orders: Units,
    val shipped: Units,
    val ordered: Quantity,
    val endingInventory: Units,
    val endingBacklog: Units,
    val weeklyCost: Money,
    val cumulativeCost: Money,
)

data class WeekOutcome(
    val results: RoleMap<RoleWeekResult>,
    val nextStates: RoleMap<RoleState>,
)

/** 週次計算の設定。遅延の週数は、状態の待ち行列の長さで表す。 */
data class SimulationSettings(
    val finalWeek: Week,
    val demand: DemandSeries,
    val costPolicy: CostPolicy,
)

fun RoleMap<RoleWeekResult>.teamWeeklyCost(): Money = values.fold(Money.ZERO) { sum, r -> sum + r.weeklyCost }

fun RoleMap<RoleWeekResult>.teamCumulativeCost(): Money = values.fold(Money.ZERO) { sum, r -> sum + r.cumulativeCost }

/** 1 役割の、当週の充足の結果（BR-05〜BR-09）。 */
private data class Fulfilment(
    val shipped: Units,
    val endingInventory: Units,
    val endingBacklog: Units,
    val weeklyCost: Money,
)

private fun fulfil(
    state: RoleState,
    costPolicy: CostPolicy,
): Fulfilment {
    val available = state.inventory + state.arrivals // BR-05
    val owed = state.backlog + state.orders // BR-06
    val endingInventory = available.minusToZero(owed) // BR-08
    val endingBacklog = owed.minusToZero(available) // BR-08
    return Fulfilment(
        shipped = minOf(available, owed), // BR-07
        endingInventory = endingInventory,
        endingBacklog = endingBacklog,
        weeklyCost = costPolicy.holding * endingInventory + costPolicy.backlog * endingBacklog, // BR-09
    )
}

/**
 * 1 週の計算（純粋関数。時計・乱数・永続化に依存せず、同じ入力から同じ結果を返す）。
 *
 * 受注と入荷は [states] が持つ。出荷は 2 週遅れ（待ち行列の長さで決まる）で下流の入荷になり、
 * 発注は同じだけ遅れて上流の受注になる。工場の生産要請は、自分の待ち行列を通って工場の入荷になる。
 * 次週の状態 [WeekOutcome.nextStates] には、次週の入荷と受注（小売店は次週の顧客需要）まで含める。
 * 最終週の次週は無いので、小売店の受注は 0 とする。
 */
@KeyLandmark(
    map = "アプリケーションアーキテクチャ",
    layer = "核",
    description = "週次計算の純粋関数。時計・乱数・永続化を知らず、同じ入力から同じ結果を返す。アーキテクチャの中心で、外側のどの層からも呼ばれる",
)
@CoreConcept(
    "シミュレーション計算",
    "1 週の計算の入口。JSD 改訂版キットの 12 ステップと遅延を忠実に再現する。副作用が無く、同じ入力から同じ結果を返すので、golden テストと性質テストで守る",
)
fun simulateWeek(
    settings: SimulationSettings,
    week: Week,
    states: RoleMap<RoleState>,
    decisions: RoleMap<Quantity>,
): WeekOutcome {
    val fulfilments = states.map { _, state -> fulfil(state, settings.costPolicy) }
    val results =
        states.map { role, state ->
            val f = fulfilments[role]
            RoleWeekResult(
                orders = state.orders,
                shipped = f.shipped,
                ordered = decisions[role],
                endingInventory = f.endingInventory,
                endingBacklog = f.endingBacklog,
                weeklyCost = f.weeklyCost,
                cumulativeCost = state.cumulativeCost + f.weeklyCost,
            )
        }
    val nextStates =
        states.map { role, state ->
            // 品物: 上流の出荷（工場は自分の生産要請）が、待ち行列を通って次々週以降の入荷になる
            val delivery =
                state.deliveryPipeline.advance(
                    role.upstream?.let { fulfilments[it].shipped } ?: decisions[role].toUnits(),
                )
            // 注文: 自分の発注は、待ち行列を通って上流の受注になる（工場は上流が無く、待ち行列も使わない）
            val ownOrders =
                role.upstream?.let { state.orderPipeline.advance(decisions[role].toUnits()).rest }
                    ?: state.orderPipeline
            // 受注: 下流の発注が待ち行列を通って届く。小売店は次週の顧客需要（最終週の次週は無いので 0）
            val nextOrders =
                role.downstream?.let { states[it].orderPipeline.advance(decisions[it].toUnits()).arrived }
                    ?: nextCustomerDemand(settings, week)
            RoleState(
                inventory = results[role].endingInventory,
                backlog = results[role].endingBacklog,
                orderPipeline = ownOrders,
                deliveryPipeline = delivery.rest,
                cumulativeCost = results[role].cumulativeCost,
                arrivals = delivery.arrived,
                orders = nextOrders,
            )
        }
    return WeekOutcome(results, nextStates)
}

/** 次週の顧客需要。最終週の次週は無いので 0。 */
private fun nextCustomerDemand(
    settings: SimulationSettings,
    week: Week,
): Units = if (week < settings.finalWeek) settings.demand.after(week) else Units(0)
