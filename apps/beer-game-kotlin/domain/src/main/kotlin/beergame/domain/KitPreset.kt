package beergame.domain

/** キット準拠の既定値（BR-13、BR-09）。 */
object KitPreset {
    private const val INITIAL_INVENTORY = 12
    private const val INITIAL_FLOW = 4
    private const val HOLDING_COST_MINOR = 50L
    private const val BACKLOG_COST_MINOR = 100L

    /** 在庫単価 $0.50、受注残単価 $1.00（最小単位はセント）。 */
    val costPolicy: CostPolicy = CostPolicy(Money(HOLDING_COST_MINOR), Money(BACKLOG_COST_MINOR))

    /**
     * 第 1 週の開始時の状態: 在庫 12、入荷と受注 4、遅延 2 週（待ち行列は 1 段）の各段 4。
     * 小売店の受注は第 1 週の顧客需要。工場は上流が無いので、注文の待ち行列は空。
     */
    fun initialStates(demand: DemandSeries): RoleMap<RoleState> =
        RoleMap.of { role ->
            RoleState(
                inventory = Units(INITIAL_INVENTORY),
                backlog = Units(0),
                orderPipeline = orderPipelineOf(role),
                deliveryPipeline = Pipeline(listOf(Units(INITIAL_FLOW))),
                cumulativeCost = Money.ZERO,
                arrivals = Units(INITIAL_FLOW),
                orders = if (role.downstream == null) demand.at(FIRST_WEEK) else Units(INITIAL_FLOW),
            )
        }

    private fun orderPipelineOf(role: Role): Pipeline =
        if (role.upstream == null) Pipeline(emptyList()) else Pipeline(listOf(Units(INITIAL_FLOW)))

    private val FIRST_WEEK: Week = Week(1)
}
