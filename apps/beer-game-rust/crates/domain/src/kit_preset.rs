//! キット準拠の既定値（BR-13、BR-09）。

use crate::role::{Role, RoleMap};
use crate::settings::{CostPolicy, DemandSeries};
use crate::simulate::{Pipeline, RoleState};
use crate::values::{Money, Units, Week};

/// 在庫は各役割 12、流れ（入荷・受注・待ち行列の各段）は 4。遅延は 2 週。
pub struct KitPreset;

impl KitPreset {
    const INITIAL_INVENTORY: u32 = 12;
    const INITIAL_FLOW: u32 = 4;
    const DELAY_WEEKS: usize = 2;
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

    /// 第 1 週の開始時の状態。小売店の受注は第 1 週の顧客需要。工場は上流が無いので、注文の待ち行列は空。
    /// 待ち行列の長さは「遅延 − 1」。
    #[must_use]
    pub fn initial_states(demand: &DemandSeries) -> RoleMap<RoleState> {
        let flow = Units::new(Self::INITIAL_FLOW);
        let queue = || Pipeline(vec![flow; Self::DELAY_WEEKS.saturating_sub(1)]);
        RoleMap::of(|role| RoleState {
            inventory: Units::new(Self::INITIAL_INVENTORY),
            backlog: Units::ZERO,
            order_pipeline: if role.upstream().is_none() {
                Pipeline(Vec::new())
            } else {
                queue()
            },
            delivery_pipeline: queue(),
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
