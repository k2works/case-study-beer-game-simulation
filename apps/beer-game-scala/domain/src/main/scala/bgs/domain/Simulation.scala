package bgs.domain

/** 待ち行列。まだ届かない品物（または注文）を、届く順に並べる。長さは `遅延 - 1`（キットの 2 週遅延なら 1 段）。 */
final case class Pipeline(weeks: List[Units]):

  /** 末尾に [inflow]（今週流し始めた分）を加え、先頭（次週に届く分）を取り出す。長さは変わらない。 */
  def advance(inflow: Units): Pipeline.Advance =
    (weeks :+ inflow) match
      case arrived :: rest => Pipeline.Advance(arrived, Pipeline(rest))
      case Nil             => Pipeline.Advance(inflow, Pipeline(Nil)) // 末尾に足したので到達しない

object Pipeline:
  final case class Advance(arrived: Units, rest: Pipeline)

/** 1 役割の週の開始時の状態。
  *
  * @param arrivals
  *   当週に処理する入荷（工場では生産の完了分）
  * @param orders
  *   当週の受注（小売店では当週の顧客需要）
  * @param orderPipeline
  *   上流へ送った注文のうち、まだ届かない分（工場は上流が無いので常に空）
  * @param deliveryPipeline
  *   上流から（工場は自分の生産から）まだ届かない品物
  */
final case class RoleState(
    inventory: Units,
    backlog: Units,
    orderPipeline: Pipeline,
    deliveryPipeline: Pipeline,
    cumulativeCost: Money,
    arrivals: Units,
    orders: Units
)

/** 役割別の週結果（AC2.3.5）。 */
final case class RoleWeekResult(
    orders: Units,
    shipped: Units,
    ordered: Quantity,
    endingInventory: Units,
    endingBacklog: Units,
    weeklyCost: Money,
    cumulativeCost: Money
)

final case class WeekOutcome(results: RoleMap[RoleWeekResult], nextStates: RoleMap[RoleState])

final case class CostPolicy(holding: Money, backlog: Money)

/** 顧客需要の系列。第 1 週から順に並ぶ。範囲外の週は 0。 */
final case class DemandSeries(values: Vector[Quantity]):
  def at(week: Week): Units = values.lift(week.value - 1).fold(Units.Zero)(_.toUnits)
  def after(week: Week): Units = week.next.fold(Units.Zero)(at)

/** 週次計算の設定。遅延の週数は、状態の待ち行列の長さで表す。 */
final case class SimulationSettings(finalWeek: Week, demand: DemandSeries, costPolicy: CostPolicy)

final case class Delay(weeks: Int)
final case class Delays(order: Delay, shipment: Delay, production: Delay)
final case class InitialConditions(inventory: RoleMap[Units], flow: Units)

/** キット準拠の既定値（BR-13、BR-09）。 */
object KitPreset:
  /** 在庫単価 $0.50、受注残単価 $1.00（最小単位はセント）。 */
  val costPolicy: CostPolicy = CostPolicy(Money.trusted(50), Money.trusted(100))

  /** 在庫は各役割 12、流れ（入荷・受注・待ち行列の各段）は 4。 */
  val initialConditions: InitialConditions =
    InitialConditions(RoleMap.all(Units.trusted(12)), Units.trusted(4))

  /** 注文・配送・生産の遅延は、いずれも 2 週。 */
  val delays: Delays = Delays(Delay(2), Delay(2), Delay(2))

  /** 第 1 週の開始時の状態（キットの条件）。 */
  def initialStates(demand: DemandSeries): RoleMap[RoleState] =
    initialStates(demand, initialConditions, delays)

  /** 第 1 週の開始時の状態。小売店の受注は第 1 週の顧客需要。工場は上流が無いので注文の待ち行列は空。 */
  def initialStates(
      demand: DemandSeries,
      initial: InitialConditions,
      delays: Delays
  ): RoleMap[RoleState] =
    RoleMap.of { role =>
      val deliveryDelay = if role.upstream.isEmpty then delays.production else delays.shipment
      RoleState(
        inventory = initial.inventory(role),
        backlog = Units.Zero,
        orderPipeline =
          if role.upstream.isEmpty then Pipeline(Nil) else flowOf(initial.flow, delays.order),
        deliveryPipeline = flowOf(initial.flow, deliveryDelay),
        cumulativeCost = Money.Zero,
        arrivals = initial.flow,
        orders = if role.downstream.isEmpty then demand.at(Week.first) else initial.flow
      )
    }

  private def flowOf(flow: Units, delay: Delay): Pipeline = Pipeline(
    List.fill(delay.weeks - 1)(flow)
  )

/** 1 役割の、当週の充足の結果（BR-05〜BR-09）。 */
private final case class Fulfilment(
    shipped: Units,
    endingInventory: Units,
    endingBacklog: Units,
    weeklyCost: Money
)

private def fulfil(state: RoleState, costPolicy: CostPolicy): Fulfilment =
  val available = state.inventory + state.arrivals // BR-05
  val owed = state.backlog + state.orders // BR-06
  val endingInventory = available.minusToZero(owed) // BR-08
  val endingBacklog = owed.minusToZero(available) // BR-08
  Fulfilment(
    shipped = available.min(owed), // BR-07
    endingInventory = endingInventory,
    endingBacklog = endingBacklog,
    weeklyCost = costPolicy.holding * endingInventory + costPolicy.backlog * endingBacklog // BR-09
  )

/** 次週の顧客需要。最終週の次週は無いので 0。 */
private def nextCustomerDemand(settings: SimulationSettings, week: Week): Units =
  if week.isBefore(settings.finalWeek) then settings.demand.after(week) else Units.Zero

/** 1 週の計算（純粋関数。時計・乱数・永続化に依存せず、同じ入力から同じ結果を返す）。
  *
  * 受注と入荷は [states] が持つ。出荷は遅延（待ち行列の長さ）だけ遅れて下流の入荷になり、
  * 発注は同じだけ遅れて上流の受注になる。工場の生産要請は、自分の待ち行列を通って工場の入荷になる。 次週の状態には、次週の入荷と受注（小売店は次週の顧客需要）まで含める。
  */
def simulateWeek(
    settings: SimulationSettings,
    week: Week,
    states: RoleMap[RoleState],
    decisions: RoleMap[Quantity]
): WeekOutcome =
  val fulfilments = states.map((_, state) => fulfil(state, settings.costPolicy))
  val results = states.map { (role, state) =>
    val f = fulfilments(role)
    RoleWeekResult(
      orders = state.orders,
      shipped = f.shipped,
      ordered = decisions(role),
      endingInventory = f.endingInventory,
      endingBacklog = f.endingBacklog,
      weeklyCost = f.weeklyCost,
      cumulativeCost = state.cumulativeCost + f.weeklyCost
    )
  }
  val nextStates = states.map { (role, state) =>
    // 品物: 上流の出荷（工場は自分の生産要請）が、待ち行列を通って次々週以降の入荷になる
    val delivery = state.deliveryPipeline.advance(
      role.upstream.fold(decisions(role).toUnits)(upstream => fulfilments(upstream).shipped)
    )
    // 注文: 自分の発注は、待ち行列を通って上流の受注になる（工場は上流が無く、待ち行列も使わない）
    val ownOrders =
      if role.upstream.isEmpty then state.orderPipeline
      else state.orderPipeline.advance(decisions(role).toUnits).rest
    // 受注: 下流の発注が待ち行列を通って届く。小売店は次週の顧客需要
    val nextOrders = role.downstream.fold(nextCustomerDemand(settings, week)) { downstream =>
      states(downstream).orderPipeline.advance(decisions(downstream).toUnits).arrived
    }
    RoleState(
      inventory = results(role).endingInventory,
      backlog = results(role).endingBacklog,
      orderPipeline = ownOrders,
      deliveryPipeline = delivery.rest,
      cumulativeCost = results(role).cumulativeCost,
      arrivals = delivery.arrived,
      orders = nextOrders
    )
  }
  WeekOutcome(results, nextStates)
