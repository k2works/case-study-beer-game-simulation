// 理由: simulate_week_golden.rs と同じ（RT1 の `__` を使うため）。
#![allow(non_snake_case)]

//! `simulate_week` の性質テスト（決定論・保存則）。具体値は golden、ここは「どの入力でも成り立つこと」。

use beergame_domain::{
    DemandSeries, KitPreset, Quantity, Role, RoleMap, SimulationSettings, Units, Week,
    simulate_week,
};
use proptest::prelude::*;

fn settings(demand: &[i64]) -> Option<SimulationSettings> {
    let final_week = Week::of(i64::try_from(demand.len()).ok()?).ok()?;
    Some(SimulationSettings {
        final_week,
        demand: DemandSeries::of(demand, final_week).ok()?,
        cost_policy: KitPreset::cost_policy(),
    })
}

fn quantities(values: [i64; 4]) -> Option<RoleMap<Quantity>> {
    Some(RoleMap {
        factory: Quantity::of(values[0]).ok()?,
        distributor: Quantity::of(values[1]).ok()?,
        wholesaler: Quantity::of(values[2]).ok()?,
        retailer: Quantity::of(values[3]).ok()?,
    })
}

proptest! {
    /// 同じ入力から同じ結果を返す（決定論。AC2.3.4）。
    #[test]
    fn ac2_3_4__同じ入力は同じ結果を返す(
        demand in prop::collection::vec(0i64..=1000, 1..=10),
        decision in prop::array::uniform4(0i64..=1000),
    ) {
        let s = settings(&demand).ok_or_else(|| TestCaseError::fail("設定を作れない"))?;
        let d = quantities(decision).ok_or_else(|| TestCaseError::fail("発注を作れない"))?;
        let states = KitPreset::initial_states(&s.demand);
        let a = simulate_week(&s, Week::FIRST, &states, &d);
        let b = simulate_week(&s, Week::FIRST, &states, &d);
        prop_assert_eq!(a, b);
    }

    /// 保存則: 利用可能量 = 週末在庫 + 出荷、充足対象 = 週末受注残 + 出荷。在庫と受注残は同時に正にならない（BR-05〜BR-08）。
    #[test]
    fn ac2_3_4__出荷と在庫と受注残の保存則が成り立つ(
        demand in prop::collection::vec(0i64..=1000, 1..=10),
        decision in prop::array::uniform4(0i64..=1000),
    ) {
        let s = settings(&demand).ok_or_else(|| TestCaseError::fail("設定を作れない"))?;
        let d = quantities(decision).ok_or_else(|| TestCaseError::fail("発注を作れない"))?;
        let states = KitPreset::initial_states(&s.demand);
        let out = simulate_week(&s, Week::FIRST, &states, &d);
        for role in Role::ALL {
            let state = states.get(role);
            let r = out.results.get(role);
            let available = state.inventory.plus(state.arrivals);
            let owed = state.backlog.plus(state.orders);
            prop_assert_eq!(available, r.ending_inventory.plus(r.shipped));
            prop_assert_eq!(owed, r.ending_backlog.plus(r.shipped));
            prop_assert!(r.ending_inventory == Units::ZERO || r.ending_backlog == Units::ZERO);
        }
    }
}
