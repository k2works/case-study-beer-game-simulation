//! 週次計算（`simulate_week`）。JSD 改訂版キットの 12 ステップと遅延を再現する純粋関数。
//! 時計・乱数・永続化に依存せず、同じ入力から同じ結果を返す（BR-05〜BR-09）。

use crate::role::RoleMap;
use crate::settings::{CostPolicy, DemandSeries};
use crate::values::{Money, Quantity, Units, Week};

/// 待ち行列。まだ届かない品物（または注文）を、届く順に並べる。
/// @core シミュレーション計算 | 遅延の表現。注文と出荷が遅れて届くことが、変動の増幅（ブルウィップ効果）の原因で、教材が見せたい現象そのもの。長さは遅延 - 1
/// @term 待ち行列 | まだ届かない品物（または注文）を、届く順に並べたもの。次週以降に届く分だけを持ち、長さは遅延 - 1 | 週次計算（simulate.rs）
///
/// 当週に届く分は [`RoleState::arrivals`]・[`RoleState::orders`] が持つので、
/// 待ち行列は「次週以降に届く分」だけを持つ。長さは `遅延 - 1`（遅延 1 週なら空）。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Pipeline(pub Vec<Units>);

impl Pipeline {
    /// 末尾に `inflow`（今週流し始めた分）を加え、先頭（次週に届く分）を取り出す。長さは変わらない。
    #[must_use]
    pub fn advance(&self, inflow: Units) -> (Units, Pipeline) {
        let mut all = self.0.clone();
        all.push(inflow);
        let mut it = all.into_iter();
        let arrived = it.next().unwrap_or(Units::ZERO);
        (arrived, Pipeline(it.collect()))
    }
}

/// 1 役割の週の開始時の状態。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RoleState {
    pub inventory: Units,
    pub backlog: Units,
    /// 上流へ送った注文のうち、まだ上流に届かない分（工場は上流が無いので常に空）。
    pub order_pipeline: Pipeline,
    /// 上流から（工場は自分の生産から）まだ届かない品物。
    pub delivery_pipeline: Pipeline,
    pub cumulative_cost: Money,
    /// 当週に処理する入荷（工場では生産の完了分）。
    pub arrivals: Units,
    /// 当週の受注（小売店では当週の顧客需要）。
    pub orders: Units,
}

/// 役割別の週結果（AC2.3.5）。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RoleWeekResult {
    pub orders: Units,
    pub shipped: Units,
    pub ordered: Quantity,
    pub ending_inventory: Units,
    pub ending_backlog: Units,
    pub weekly_cost: Money,
    pub cumulative_cost: Money,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WeekOutcome {
    pub results: RoleMap<RoleWeekResult>,
    pub next_states: RoleMap<RoleState>,
}

/// 週次計算の設定。遅延の週数は、状態の待ち行列の長さで表す。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SimulationSettings {
    pub final_week: Week,
    pub demand: DemandSeries,
    pub cost_policy: CostPolicy,
}

/// チームの週次費用（4 役割の合計）。
#[must_use]
pub fn team_weekly_cost(results: &RoleMap<RoleWeekResult>) -> Money {
    results
        .values()
        .iter()
        .fold(Money::ZERO, |sum, r| sum.plus(r.weekly_cost))
}

/// チームの累積費用（4 役割の合計）。
#[must_use]
pub fn team_cumulative_cost(results: &RoleMap<RoleWeekResult>) -> Money {
    results
        .values()
        .iter()
        .fold(Money::ZERO, |sum, r| sum.plus(r.cumulative_cost))
}

/// 1 役割の、当週の充足の結果（BR-05〜BR-09）。
struct Fulfilment {
    shipped: Units,
    ending_inventory: Units,
    ending_backlog: Units,
    weekly_cost: Money,
}

fn fulfil(state: &RoleState, cost_policy: &CostPolicy) -> Fulfilment {
    let available = state.inventory.plus(state.arrivals); // BR-05
    let owed = state.backlog.plus(state.orders); // BR-06
    let ending_inventory = available.minus_to_zero(owed); // BR-08
    let ending_backlog = owed.minus_to_zero(available); // BR-08
    Fulfilment {
        shipped: available.min(owed), // BR-07
        ending_inventory,
        ending_backlog,
        weekly_cost: cost_policy
            .holding
            .times(ending_inventory)
            .plus(cost_policy.backlog.times(ending_backlog)), // BR-09
    }
}

/// 次週の顧客需要。最終週の次週は無いので 0。
fn next_customer_demand(settings: &SimulationSettings, week: Week) -> Units {
    if week < settings.final_week {
        settings.demand.after(week)
    } else {
        Units::ZERO
    }
}

/// 1 週の計算。
/// @core シミュレーション計算 | 1 週の計算の入口。JSD 改訂版キットの 12 ステップと遅延を忠実に再現する。副作用が無く、同じ入力から同じ結果を返すので、既知の系列の golden テストと性質テストで守る
/// @landmark ddd 戦略的設計 | 中核の計算。力を注ぐ場所で、時計・乱数・永続化に依存しない純粋関数にして、入力だけで結果が決まるようにする
/// @landmark architecture 核 | 副作用の無い計算。テストが速く、同じ入力は同じ結果になる
///
/// 受注と入荷は `states` が持つ。出荷は遅れて（待ち行列の長さで決まる）下流の入荷になり、
/// 発注は同じだけ遅れて上流の受注になる。工場の生産要請は、自分の待ち行列を通って工場の入荷になる。
/// 次週の状態には、次週の入荷と受注（小売店は次週の顧客需要）まで含める。最終週の次週は無いので、小売店の受注は 0。
#[must_use]
pub fn simulate_week(
    settings: &SimulationSettings,
    week: Week,
    states: &RoleMap<RoleState>,
    decisions: &RoleMap<Quantity>,
) -> WeekOutcome {
    let fulfilments = states.map(|_, state| fulfil(state, &settings.cost_policy));
    let results = states.map(|role, state| {
        let f = fulfilments.get(role);
        RoleWeekResult {
            orders: state.orders,
            shipped: f.shipped,
            ordered: *decisions.get(role),
            ending_inventory: f.ending_inventory,
            ending_backlog: f.ending_backlog,
            weekly_cost: f.weekly_cost,
            cumulative_cost: state.cumulative_cost.plus(f.weekly_cost),
        }
    });
    let next_states = states.map(|role, state| {
        let result = results.get(role);
        // 品物: 上流の出荷（工場は自分の生産要請）が、待ち行列を通って次々週以降の入荷になる
        let inflow = role.upstream().map_or_else(
            || decisions.get(role).to_units(),
            |up| fulfilments.get(up).shipped,
        );
        let (arrivals, delivery_pipeline) = state.delivery_pipeline.advance(inflow);
        // 注文: 自分の発注は、待ち行列を通って上流の受注になる（工場は上流が無く、待ち行列も使わない）
        let order_pipeline = role.upstream().map_or_else(
            || state.order_pipeline.clone(),
            |_| {
                state
                    .order_pipeline
                    .advance(decisions.get(role).to_units())
                    .1
            },
        );
        // 受注: 下流の発注が待ち行列を通って届く。小売店は次週の顧客需要
        let orders = role.downstream().map_or_else(
            || next_customer_demand(settings, week),
            |down| {
                states
                    .get(down)
                    .order_pipeline
                    .advance(decisions.get(down).to_units())
                    .0
            },
        );
        RoleState {
            inventory: result.ending_inventory,
            backlog: result.ending_backlog,
            order_pipeline,
            delivery_pipeline,
            cumulative_cost: result.cumulative_cost,
            arrivals,
            orders,
        }
    });
    WeekOutcome {
        results,
        next_states,
    }
}
