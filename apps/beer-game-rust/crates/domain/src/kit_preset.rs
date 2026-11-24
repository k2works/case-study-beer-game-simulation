//! キット準拠の既定値（BR-13、BR-09）。

use crate::conditions::Conditions;
use crate::role::{Role, RoleMap};
use crate::settings::{CostPolicy, DemandSeries};
use crate::simulate::{Pipeline, RoleState};
use crate::values::{Money, Units, Week};

/// 在庫は各役割 12、流れ（入荷・受注・待ち行列の各段）は 4。遅延は 2 週。
pub struct KitPreset;

impl KitPreset {
    pub(crate) const INITIAL_INVENTORY: u32 = 12;
    pub(crate) const INITIAL_FLOW: u32 = 4;
    pub(crate) const DELAY_WEEKS: u8 = 2;
    const HOLDING_COST_MINOR: u32 = 50;
    const BACKLOG_COST_MINOR: u32 = 100;

    /// 在庫単価 $0.50、受注残単価 $1.00（最小単位はセント）。
    #[must_use]
    pub const fn cost_policy() -> CostPolicy {
        CostPolicy {
            holding: Money::new(Self::HOLDING_COST_MINOR),
            backlog: Money::new(Self::BACKLOG_COST_MINOR),
        }
    }

    /// 第 1 週の開始時の状態（キット準拠）。
    #[must_use]
    pub fn initial_states(demand: &DemandSeries) -> RoleMap<RoleState> {
        Self::initial_states_with(demand, &Conditions::kit())
    }

    /// 第 1 週の開始時の状態。小売店の受注は第 1 週の顧客需要。工場は上流が無いので、注文の待ち行列は空。
    /// 待ち行列の長さは「遅延 − 1」（注文は注文の遅延、品物は配送の遅延。工場の品物は生産の遅延）。
    #[must_use]
    pub fn initial_states_with(
        demand: &DemandSeries,
        conditions: &Conditions,
    ) -> RoleMap<RoleState> {
        let flow = conditions.initial_flow;
        let queue = |delay: u8| Pipeline(vec![flow; usize::from(delay).saturating_sub(1)]);
        RoleMap::of(|role| RoleState {
            inventory: *conditions.initial_inventory.get(role),
            backlog: Units::ZERO,
            order_pipeline: if role.upstream().is_none() {
                Pipeline(Vec::new())
            } else {
                queue(conditions.order_delay)
            },
            delivery_pipeline: queue(if role.upstream().is_none() {
                conditions.production_delay
            } else {
                conditions.shipment_delay
            }),
            cumulative_cost: Money::ZERO,
            arrivals: flow,
            orders: if role == Role::Retailer {
                demand.at(Week::FIRST)
            } else {
                flow
            },
        })
    }
}
