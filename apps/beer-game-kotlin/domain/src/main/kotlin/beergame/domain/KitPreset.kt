package beergame.domain

/** キット準拠の既定値（BR-13、BR-09）。 */
object KitPreset {
    private const val INITIAL_INVENTORY = 12
    private const val INITIAL_FLOW = 4
    private const val HOLDING_COST_MINOR = 50L
    private const val BACKLOG_COST_MINOR = 100L

    /** 在庫単価 $0.50、受注残単価 $1.00（最小単位はセント）。 */
    val costPolicy: CostPolicy = CostPolicy(Money(HOLDING_COST_MINOR), Money(BACKLOG_COST_MINOR))

    private const val KIT_DELAY_WEEKS = 2

    /** 在庫は各役割 12、流れ（入荷・受注・待ち行列の各段）は 4。 */
    val initialConditions: InitialConditions =
        InitialConditions(RoleMap.all(Units(INITIAL_INVENTORY)), Units(INITIAL_FLOW))

    /** 注文・配送・生産の遅延は、いずれも 2 週。 */
    val delays: Delays = Delays(Delay(KIT_DELAY_WEEKS), Delay(KIT_DELAY_WEEKS), Delay(KIT_DELAY_WEEKS))

    /**
     * 第 1 週の開始時の状態。既定はキットの値: 在庫 12、入荷と受注 4、遅延 2 週（待ち行列は 1 段）の各段 4。
     * 小売店の受注は第 1 週の顧客需要。工場は上流が無いので、注文の待ち行列は空。待ち行列の長さは「遅延 − 1」。
     */
    fun initialStates(
        demand: DemandSeries,
        initial: InitialConditions = initialConditions,
        delays: Delays = KitPreset.delays,
    ): RoleMap<RoleState> =
        RoleMap.of { role ->
            val deliveryDelay = if (role.upstream == null) delays.production else delays.shipment
            RoleState(
                inventory = initial.inventory[role],
                backlog = Units(0),
                orderPipeline =
                    if (role.upstream ==
                        null
                    ) {
                        Pipeline(emptyList())
                    } else {
                        flowOf(initial.flow, delays.order)
                    },
                deliveryPipeline = flowOf(initial.flow, deliveryDelay),
                cumulativeCost = Money.ZERO,
                arrivals = initial.flow,
                orders = if (role.downstream == null) demand.at(FIRST_WEEK) else initial.flow,
            )
        }

    private fun flowOf(
        flow: Units,
        delay: Delay,
    ): Pipeline = Pipeline(List(delay.weeks - 1) { flow })

    private val FIRST_WEEK: Week = Week(1)
}
