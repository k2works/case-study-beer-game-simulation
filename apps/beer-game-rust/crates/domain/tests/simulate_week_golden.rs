// 理由: RT1 の命名（承認済み）はテスト名の接頭辞の後に `__` を置く（`ac2_3_4__…`）。rustc の non_snake_case は
// 連続する `_` を許さないため、テストのファイルに限って許す。B1 の記録に載せ、単一の `_` への変更を人が判断する。
#![allow(non_snake_case)]

//! `simulate_week` の golden テスト。期待値は、要件定義の業務ルール（BR）から手で導いた値で、
//! 実装の出力を貼ったものではない（Kotlin 版の `SimulateWeekGoldenSpec` と同じ値）。
//!
//! 前提（BR-13 のキット準拠の初期値）: 各役割の在庫 12、配送・生産の遅れ各段 4、注文の遅れ各段 4、遅延 2 週。
//! 費用方針（BR-09）: 在庫 $0.50 = 50、受注残 $1.00 = 100（最小単位はセント）。
//! 式（BR-05〜BR-08）: 利用可能量 = 前週末在庫 + 当週入荷、充足対象 = 前週末受注残 + 当週受注、
//! 出荷 = min(両者)、週末在庫 = max(0, 利用可能量 - 充足対象)、週末受注残 = max(0, 充足対象 - 利用可能量)。

use beergame_domain::{
    DemandSeries, KitPreset, Money, Pipeline, Quantity, Role, RoleMap, RoleState, RoleWeekResult,
    SimulationSettings, Units, Week, WeekOutcome, simulate_week, team_cumulative_cost,
    team_weekly_cost,
};

fn u(n: u32) -> Units {
    Units::new(n)
}

fn m(n: u32) -> Money {
    Money::new(n)
}

fn q(n: i64) -> Result<Quantity, String> {
    Quantity::of(n).map_err(|e| format!("{e:?}"))
}

fn w(n: i64) -> Result<Week, String> {
    Week::of(n).map_err(|e| format!("{e:?}"))
}

fn settings(demand: &[i64], final_week: i64) -> Result<SimulationSettings, String> {
    let final_week = w(final_week)?;
    let demand = DemandSeries::of(demand, final_week).map_err(|e| format!("{e:?}"))?;
    Ok(SimulationSettings {
        final_week,
        demand,
        cost_policy: KitPreset::cost_policy(),
    })
}

/// 発注（工場・一次卸・二次卸・小売店の順）。
fn decisions(f: i64, d: i64, wh: i64, r: i64) -> Result<RoleMap<Quantity>, String> {
    Ok(RoleMap {
        factory: q(f)?,
        distributor: q(d)?,
        wholesaler: q(wh)?,
        retailer: q(r)?,
    })
}

fn same(n: i64) -> Result<RoleMap<Quantity>, String> {
    decisions(n, n, n, n)
}

struct Played {
    /// 各週の開始時の状態（`before[i]` は第 i+1 週の開始時）。
    before: Vec<RoleMap<RoleState>>,
    outcomes: Vec<WeekOutcome>,
}

/// 第 1 週から、与えた発注の列を順に流す。
fn play(settings: &SimulationSettings, plan: &[RoleMap<Quantity>]) -> Result<Played, String> {
    let mut states = KitPreset::initial_states(&settings.demand);
    let mut week = Week::FIRST;
    let mut before = Vec::new();
    let mut outcomes = Vec::new();
    for decision in plan {
        before.push(states.clone());
        let outcome = simulate_week(settings, week, &states, decision);
        states = outcome.next_states.clone();
        outcomes.push(outcome);
        week = week.next().ok_or("最終週を超えた")?;
    }
    Ok(Played { before, outcomes })
}

fn outcome(played: &Played, week_index: usize) -> Result<&WeekOutcome, String> {
    played.outcomes.get(week_index).ok_or("週が無い".to_owned())
}

fn result(played: &Played, week_index: usize, role: Role) -> Result<RoleWeekResult, String> {
    Ok(outcome(played, week_index)?.results.get(role).clone())
}

fn week_result(
    orders: u32,
    shipped: u32,
    ordered: i64,
    inventory: u32,
    backlog: u32,
    weekly: u32,
    cumulative: u32,
) -> Result<RoleWeekResult, String> {
    Ok(RoleWeekResult {
        orders: u(orders),
        shipped: u(shipped),
        ordered: q(ordered)?,
        ending_inventory: u(inventory),
        ending_backlog: u(backlog),
        weekly_cost: m(weekly),
        cumulative_cost: m(cumulative),
    })
}

#[test]
fn ac2_3_4__初期状態は在庫12_入荷4_各段4で_小売店の受注だけが第1週の顧客需要() -> Result<(), String>
{
    let s = settings(&[9, 4, 4], 3)?;
    let states = KitPreset::initial_states(&s.demand);
    for role in Role::ALL {
        let state = states.get(role);
        assert_eq!(state.inventory, u(12));
        assert_eq!(state.backlog, u(0));
        assert_eq!(state.arrivals, u(4));
        assert_eq!(state.delivery_pipeline, Pipeline(vec![u(4)]));
        assert_eq!(state.cumulative_cost, Money::ZERO);
    }
    assert_eq!(states.retailer.orders, u(9));
    assert_eq!(states.wholesaler.orders, u(4));
    assert_eq!(states.distributor.orders, u(4));
    assert_eq!(states.factory.orders, u(4));
    // 工場は上流へ発注しない（注文の待ち行列を持たない）
    assert_eq!(states.factory.order_pipeline, Pipeline(Vec::new()));
    assert_eq!(states.retailer.order_pipeline, Pipeline(vec![u(4)]));
    Ok(())
}

#[test]
fn ac2_3_4__需要4_発注4なら全役割が出荷4_在庫12_週次費用600で動かない() -> Result<(), String> {
    let s = settings(&[4, 4, 4, 4], 4)?;
    let plan = vec![same(4)?, same(4)?, same(4)?, same(4)?];
    let played = play(&s, &plan)?;
    for (i, _) in played.outcomes.iter().enumerate() {
        for role in Role::ALL {
            let r = result(&played, i, role)?;
            assert_eq!(r.orders, u(4));
            assert_eq!(r.shipped, u(4));
            assert_eq!(r.ending_inventory, u(12));
            assert_eq!(r.ending_backlog, u(0));
            assert_eq!(r.weekly_cost, m(600));
        }
    }
    assert_eq!(
        result(&played, 3, Role::Wholesaler)?.cumulative_cost,
        m(2400)
    );
    Ok(())
}

#[test]
fn ac2_3_4__需要が4から8に増え発注が4のままだと小売店の在庫は12_8_4_0と減る() -> Result<(), String>
{
    // 入荷は毎週 4。在庫 = 前週末在庫 + 入荷 4 - 受注:
    // 第 1 週 12 + 4 - 4 = 12、第 2 週 12 + 4 - 8 = 8、第 3 週 8 + 4 - 8 = 4、第 4 週 4 + 4 - 8 = 0。
    let s = settings(&[4, 8, 8, 8], 4)?;
    let played = play(&s, &[same(4)?, same(4)?, same(4)?, same(4)?])?;
    let retailer: Vec<RoleWeekResult> = (0..4)
        .map(|i| result(&played, i, Role::Retailer))
        .collect::<Result<_, _>>()?;
    let inventory: Vec<Units> = retailer.iter().map(|r| r.ending_inventory).collect();
    assert_eq!(inventory, vec![u(12), u(8), u(4), u(0)]);
    // 週次費用 = 在庫 × 50（BR-09）: 600、400、200、0。累積: 600、1000、1200、1200
    let weekly: Vec<Money> = retailer.iter().map(|r| r.weekly_cost).collect();
    assert_eq!(weekly, vec![m(600), m(400), m(200), m(0)]);
    let cumulative: Vec<Money> = retailer.iter().map(|r| r.cumulative_cost).collect();
    assert_eq!(cumulative, vec![m(600), m(1000), m(1200), m(1200)]);
    Ok(())
}

#[test]
fn ac2_3_4__在庫が足りないと受注残が生まれ_翌週に持ち越される() -> Result<(), String> {
    // 第 1 週: 利用可能 12 + 4 = 16、充足対象 0 + 20 = 20 → 出荷 16、在庫 0、受注残 4、費用 4 × 100 = 400。
    // 第 2 週: 利用可能 0 + 4 = 4、充足対象 4 + 4 = 8 → 出荷 4、在庫 0、受注残 4、費用 400、累積 800。
    let s = settings(&[20, 4], 2)?;
    let played = play(&s, &[same(4)?, same(4)?])?;
    assert_eq!(
        result(&played, 0, Role::Retailer)?,
        week_result(20, 16, 4, 0, 4, 400, 400)?
    );
    assert_eq!(
        result(&played, 1, Role::Retailer)?,
        week_result(4, 4, 4, 0, 4, 400, 800)?
    );
    Ok(())
}

#[test]
fn ac2_3_4__小売店の発注10は2週後の第3週に卸の受注になる() -> Result<(), String> {
    let s = settings(&[4, 4, 4, 4], 4)?;
    let plan = [decisions(4, 4, 4, 10)?, same(4)?, same(4)?, same(4)?];
    let played = play(&s, &plan)?;
    let orders: Vec<Units> = (0..4)
        .map(|i| result(&played, i, Role::Wholesaler).map(|r| r.orders))
        .collect::<Result<_, _>>()?;
    assert_eq!(orders, vec![u(4), u(4), u(10), u(4)]);
    Ok(())
}

#[test]
fn ac2_3_4__卸の出荷10は2週後の第5週に小売店の入荷になる() -> Result<(), String> {
    // 第 3 週の卸: 利用可能 12 + 4 = 16 ≥ 充足対象 10 なので、出荷 10。
    let s = settings(&[4, 4, 4, 4, 4], 5)?;
    let plan = [
        decisions(4, 4, 4, 10)?,
        same(4)?,
        same(4)?,
        same(4)?,
        same(4)?,
    ];
    let played = play(&s, &plan)?;
    assert_eq!(result(&played, 2, Role::Wholesaler)?.shipped, u(10));
    let at = |i: usize| -> Result<Units, String> {
        played
            .before
            .get(i)
            .map(|states| states.retailer.arrivals)
            .ok_or("週が無い".to_owned())
    };
    assert_eq!(at(4)?, u(10));
    assert_eq!(at(3)?, u(4));
    Ok(())
}

#[test]
fn ac2_3_4__工場の生産要請10は2週後の第3週に工場在庫へ入る() -> Result<(), String> {
    // 第 3 週の工場: 12 + 10 - 4 = 18。第 2 週までは 12 + 4 - 4 = 12。
    let s = settings(&[4, 4, 4, 4], 4)?;
    let plan = [decisions(10, 4, 4, 4)?, same(4)?, same(4)?, same(4)?];
    let played = play(&s, &plan)?;
    assert_eq!(result(&played, 1, Role::Factory)?.ending_inventory, u(12));
    assert_eq!(result(&played, 2, Role::Factory)?.ending_inventory, u(18));
    Ok(())
}

/// 4 役割が変化する 3 週の系列（手計算）。需要 [8, 4, 4]。第 1 週の発注: 工場 6、一次卸 5、二次卸 7、小売店 9。
/// 以降は全員 4。第 3 週は、遅れて届いた発注（R の 9、W の 7、D の 5）と生産要請（F の 6）が効く。
fn three_weeks() -> Result<Played, String> {
    let s = settings(&[8, 4, 4], 3)?;
    play(&s, &[decisions(6, 5, 7, 9)?, same(4)?, same(4)?])
}

#[test]
fn ac2_3_4__第1週の役割別の結果() -> Result<(), String> {
    let played = three_weeks()?;
    assert_eq!(
        result(&played, 0, Role::Retailer)?,
        week_result(8, 8, 9, 8, 0, 400, 400)?
    );
    assert_eq!(
        result(&played, 0, Role::Wholesaler)?,
        week_result(4, 4, 7, 12, 0, 600, 600)?
    );
    assert_eq!(
        result(&played, 0, Role::Distributor)?,
        week_result(4, 4, 5, 12, 0, 600, 600)?
    );
    assert_eq!(
        result(&played, 0, Role::Factory)?,
        week_result(4, 4, 6, 12, 0, 600, 600)?
    );
    Ok(())
}

#[test]
fn ac2_3_4__第2週の役割別の結果() -> Result<(), String> {
    let played = three_weeks()?;
    assert_eq!(
        result(&played, 1, Role::Retailer)?,
        week_result(4, 4, 4, 8, 0, 400, 800)?
    );
    for role in [Role::Wholesaler, Role::Distributor, Role::Factory] {
        assert_eq!(
            result(&played, 1, role)?,
            week_result(4, 4, 4, 12, 0, 600, 1200)?
        );
    }
    Ok(())
}

#[test]
fn ac2_3_4__第3週の役割別の結果_遅れて届いた発注と生産要請が効く() -> Result<(), String> {
    let played = three_weeks()?;
    assert_eq!(
        result(&played, 2, Role::Retailer)?,
        week_result(4, 4, 4, 8, 0, 400, 1200)?
    );
    assert_eq!(
        result(&played, 2, Role::Wholesaler)?,
        week_result(9, 9, 4, 7, 0, 350, 1550)?
    );
    assert_eq!(
        result(&played, 2, Role::Distributor)?,
        week_result(7, 7, 4, 9, 0, 450, 1650)?
    );
    assert_eq!(
        result(&played, 2, Role::Factory)?,
        week_result(5, 5, 4, 13, 0, 650, 1850)?
    );
    Ok(())
}

#[test]
fn ac2_3_5__チームの週次費用と累積費用は4役割の合計() -> Result<(), String> {
    // 第 3 週の週次: 400 + 350 + 450 + 650 = 1850。累積: 1200 + 1550 + 1650 + 1850 = 6250（BR-09）。
    let played = three_weeks()?;
    let results = &outcome(&played, 2)?.results;
    assert_eq!(team_weekly_cost(results), m(1850));
    assert_eq!(team_cumulative_cost(results), m(6250));
    Ok(())
}

#[test]
fn ac2_3_4__最終週の次の週は無いので_次週の状態の小売店の受注は0() -> Result<(), String> {
    let s = settings(&[4, 4], 2)?;
    let played = play(&s, &[same(4)?, same(4)?])?;
    assert_eq!(outcome(&played, 0)?.next_states.retailer.orders, u(4));
    assert_eq!(outcome(&played, 1)?.next_states.retailer.orders, u(0));
    Ok(())
}

#[test]
fn ac1_1_2__需要系列が最終週より長くても_最終週の次の需要は使わない() -> Result<(), String> {
    let s = settings(&[4, 99], 1)?;
    let states = KitPreset::initial_states(&s.demand);
    let out = simulate_week(&s, Week::FIRST, &states, &same(4)?);
    assert_eq!(out.next_states.retailer.orders, u(0));
    Ok(())
}

#[test]
fn ac2_3_4__遅延1週_待ち行列が空なら_発注と出荷は次週にそのまま届く() -> Result<(), String> {
    let empty = Pipeline(Vec::new());
    let state = RoleState {
        inventory: u(12),
        backlog: u(0),
        order_pipeline: empty.clone(),
        delivery_pipeline: empty,
        cumulative_cost: Money::ZERO,
        arrivals: u(4),
        orders: u(4),
    };
    let states = RoleMap::all(&state);
    let s = settings(&[4, 4, 4], 3)?;
    let out = simulate_week(&s, Week::FIRST, &states, &decisions(7, 5, 3, 9)?);
    // 小売店の発注 9 は次週の卸の受注、卸の発注 3 は次週の一次卸の受注、一次卸の発注 5 は次週の工場の受注
    assert_eq!(out.next_states.wholesaler.orders, u(9));
    assert_eq!(out.next_states.distributor.orders, u(3));
    assert_eq!(out.next_states.factory.orders, u(5));
    // 工場の生産要請 7 は次週の工場の入荷。他は、上流の第 1 週の出荷（4）が次週の入荷
    assert_eq!(out.next_states.factory.arrivals, u(7));
    assert_eq!(out.next_states.distributor.arrivals, u(4));
    assert_eq!(out.next_states.wholesaler.arrivals, u(4));
    assert_eq!(out.next_states.retailer.arrivals, u(4));
    Ok(())
}
