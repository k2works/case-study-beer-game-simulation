// 理由: simulate_week_golden.rs と同じ（RT1 の `__` を使うため）。
#![allow(non_snake_case)]

//! カスタム条件（AC1.1.3〜1.1.5）。設定の種別・変更した項目・範囲の検証と、遅延が可変でも `simulate_week` の性質が保たれること。

use std::collections::BTreeMap;

use beergame_domain::{
    CommitMode, Conditions, ConditionsInput, DemandSeries, DisclosurePolicy, GameSettings,
    KitPreset, Quantity, Role, RoleMap, SettingsField, SettingsKind, Units, ValidationError, Week,
    simulate_week,
};
use proptest::prelude::*;

type R<T> = Result<T, String>;

fn err<E: std::fmt::Debug>(x: E) -> String {
    format!("{x:?}")
}

fn input() -> ConditionsInput {
    ConditionsInput::default()
}

fn custom(conditions: &ConditionsInput) -> Result<GameSettings, Vec<ValidationError>> {
    GameSettings::custom(3, &[4, 4, 4], CommitMode::Manual, conditions)
}

#[test]
fn ac1_1_3__キットの値のままなら_カスタムで作っても種別はキットで変更した項目は無い() -> R<()> {
    let kit = GameSettings::kit(3, &[4, 4, 4], CommitMode::Manual).map_err(err)?;
    assert_eq!(kit.kind(), SettingsKind::Kit);
    assert!(kit.changed_fields().is_empty());
    let same = ConditionsInput {
        initial_flow: Some(4),
        order_delay_weeks: Some(2),
        shipment_delay_weeks: Some(2),
        production_delay_weeks: Some(2),
        holding_cost_minor: Some(50),
        backlog_cost_minor: Some(100),
        disclosure_policy: Some("TEAM_TOTAL".to_owned()),
        ..input()
    };
    let settings = custom(&same).map_err(err)?;
    assert_eq!(settings.kind(), SettingsKind::Kit);
    assert_eq!(settings, kit);
    Ok(())
}

#[test]
fn ac1_1_3__変えた項目だけが_カスタムとして示される() -> R<()> {
    let changed = ConditionsInput {
        initial_inventory: BTreeMap::from([(Role::Retailer, 20)]),
        shipment_delay_weeks: Some(3),
        ..input()
    };
    let settings = custom(&changed).map_err(err)?;
    assert_eq!(settings.kind(), SettingsKind::Custom);
    assert_eq!(
        settings.changed_fields(),
        vec![
            SettingsField::InitialInventory,
            SettingsField::ShipmentDelay
        ]
    );
    // 4 項目すべて（初期の流れ・注文・生産の遅延・単価・公開範囲を含む）
    let all = ConditionsInput {
        initial_inventory: BTreeMap::from([(Role::Factory, 0)]),
        initial_flow: Some(5),
        order_delay_weeks: Some(3),
        shipment_delay_weeks: Some(1),
        production_delay_weeks: Some(8),
        holding_cost_minor: Some(80),
        backlog_cost_minor: Some(0),
        disclosure_policy: Some("NONE".to_owned()),
    };
    let settings = custom(&all).map_err(err)?;
    assert_eq!(settings.changed_fields().len(), 8);
    assert_eq!(settings.conditions.disclosure, DisclosurePolicy::None);
    Ok(())
}

#[test]
fn ac1_1_4__範囲外は_すべての誤りを項目ごとに集める() -> R<()> {
    let bad = ConditionsInput {
        initial_inventory: BTreeMap::from([(Role::Retailer, 1001), (Role::Factory, -1)]),
        initial_flow: Some(1001),
        order_delay_weeks: Some(0),
        shipment_delay_weeks: Some(9),
        production_delay_weeks: Some(0),
        holding_cost_minor: Some(-1),
        backlog_cost_minor: Some(100_001),
        disclosure_policy: Some("ALL".to_owned()),
    };
    let Err(errors) = custom(&bad) else {
        return Err("拒否されていない".to_owned());
    };
    let mut fields: Vec<&str> = errors
        .iter()
        .filter_map(|e| match e {
            ValidationError::ConditionOutOfRange { field, .. } => Some(*field),
            ValidationError::DisclosureInvalid => Some("disclosurePolicy"),
            ValidationError::QuantityOutOfRange { .. }
            | ValidationError::WeekOutOfRange { .. }
            | ValidationError::UnitsNegative { .. }
            | ValidationError::MoneyNegative { .. }
            | ValidationError::DisplayNameInvalid { .. }
            | ValidationError::JoinCodeInvalid { .. }
            | ValidationError::RetentionOutOfRange { .. }
            | ValidationError::ConditionsOnKit
            | ValidationError::DemandSeriesInvalid { .. } => None,
        })
        .collect();
    fields.sort_unstable();
    for expected in [
        "initialInventory",
        "initialFlow",
        "orderDelayWeeks",
        "shipmentDelayWeeks",
        "productionDelayWeeks",
        "holdingCostMinor",
        "backlogCostMinor",
        "disclosurePolicy",
    ] {
        assert!(fields.contains(&expected), "{expected} が無い: {fields:?}");
    }
    // 役割ごとの初期在庫は、役割も示す
    assert!(errors.iter().any(|e| matches!(
        e,
        ValidationError::ConditionOutOfRange {
            role: Some(Role::Retailer),
            min: 0,
            max: 1000,
            ..
        }
    )));
    Ok(())
}

#[test]
fn ac1_1_4__最終週と需要系列の誤りも_条件の誤りと一緒に集める() -> R<()> {
    let bad = ConditionsInput {
        shipment_delay_weeks: Some(0),
        ..input()
    };
    let Err(errors) = GameSettings::custom(51, &[4], CommitMode::Manual, &bad) else {
        return Err("拒否されていない".to_owned());
    };
    assert!(
        errors
            .iter()
            .any(|e| matches!(e, ValidationError::WeekOutOfRange { .. }))
    );
    assert!(errors.iter().any(|e| matches!(
        e,
        ValidationError::ConditionOutOfRange {
            field: "shipmentDelayWeeks",
            ..
        }
    )));
    // 条件だけが誤りのとき
    assert!(matches!(
        GameSettings::custom(3, &[4, 4, 4], CommitMode::Manual, &bad),
        Err(e) if e.len() == 1
    ));
    // 最終週・需要の誤りだけのとき
    assert!(GameSettings::custom(51, &[4], CommitMode::Manual, &input()).is_err());
    Ok(())
}

#[test]
fn ac1_1_3__初期在庫と遅延は_第_1_週の状態に反映される() -> R<()> {
    let changed = ConditionsInput {
        initial_inventory: BTreeMap::from([(Role::Retailer, 20)]),
        order_delay_weeks: Some(3),
        shipment_delay_weeks: Some(1),
        production_delay_weeks: Some(4),
        initial_flow: Some(6),
        ..input()
    };
    let states = custom(&changed).map_err(err)?.initial_states();
    let retailer = states.get(Role::Retailer);
    assert_eq!(retailer.inventory, Units::new(20));
    assert_eq!(
        retailer.order_pipeline.0.len(),
        2,
        "注文の遅延 3 週 → 待ち行列 2"
    );
    assert!(
        retailer.delivery_pipeline.0.is_empty(),
        "配送の遅延 1 週 → 待ち行列 0"
    );
    let factory = states.get(Role::Factory);
    assert!(factory.order_pipeline.0.is_empty(), "工場は上流が無い");
    assert_eq!(
        factory.delivery_pipeline.0.len(),
        3,
        "生産の遅延 4 週 → 待ち行列 3"
    );
    assert_eq!(factory.arrivals, Units::new(6));
    // キット準拠の初期状態は、従来と同じ
    let kit = GameSettings::kit(3, &[4, 4, 4], CommitMode::Manual).map_err(err)?;
    assert_eq!(kit.initial_states(), KitPreset::initial_states(&kit.demand));
    assert_eq!(Conditions::kit(), kit.conditions);
    Ok(())
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
    /// 遅延が可変（0 を含む）でも、決定論・保存則・待ち行列の長さの不変が、数週にわたって成り立つ。
    #[test]
    fn ac1_1_4__遅延が可変でも_保存則と決定論と待ち行列の長さが保たれる(
        demand in prop::collection::vec(0i64..=1000, 5..=6),
        decisions in prop::collection::vec(prop::array::uniform4(0i64..=1000), 5),
        delays in prop::array::uniform3(0u8..=8),
        inventory in 0u32..=1000,
        flow in 0u32..=1000,
    ) {
        let final_week = Week::of(i64::try_from(demand.len()).map_err(|e| TestCaseError::fail(e.to_string()))?)
            .map_err(|e| TestCaseError::fail(format!("{e:?}")))?;
        let series = DemandSeries::of(&demand, final_week).map_err(|e| TestCaseError::fail(format!("{e:?}")))?;
        let conditions = Conditions {
            initial_inventory: RoleMap::all(&Units::new(inventory)),
            initial_flow: Units::new(flow),
            order_delay: delays[0],
            shipment_delay: delays[1],
            production_delay: delays[2],
            disclosure: DisclosurePolicy::TeamTotal,
        };
        let settings = beergame_domain::SimulationSettings {
            final_week,
            demand: series.clone(),
            cost_policy: KitPreset::cost_policy(),
        };
        let mut states = KitPreset::initial_states_with(&series, &conditions);
        let order_len = usize::from(delays[0]).saturating_sub(1);
        let ship_len = usize::from(delays[1]).saturating_sub(1);
        let prod_len = usize::from(delays[2]).saturating_sub(1);
        let mut week = Week::FIRST;
        for d in &decisions {
            let d = quantities(*d).ok_or_else(|| TestCaseError::fail("発注を作れない"))?;
            let a = simulate_week(&settings, week, &states, &d);
            let b = simulate_week(&settings, week, &states, &d);
            prop_assert_eq!(&a, &b);
            for role in Role::ALL {
                let state = states.get(role);
                let r = a.results.get(role);
                prop_assert_eq!(state.inventory.plus(state.arrivals), r.ending_inventory.plus(r.shipped));
                prop_assert_eq!(state.backlog.plus(state.orders), r.ending_backlog.plus(r.shipped));
                let next = a.next_states.get(role);
                let (expected_order, expected_delivery) = if role == Role::Factory {
                    (0, prod_len)
                } else {
                    (order_len, ship_len)
                };
                prop_assert_eq!(next.order_pipeline.0.len(), expected_order);
                prop_assert_eq!(next.delivery_pipeline.0.len(), expected_delivery);
            }
            states = a.next_states;
            let Some(next_week) = week.next() else { break };
            week = next_week;
        }
    }
}

#[test]
fn ac1_1_5__最終週は_1_以上_50_以下に限る() -> R<()> {
    for (week, ok) in [(0, false), (1, true), (50, true), (51, false)] {
        let demand = vec![4; usize::try_from(week.max(1)).map_err(err)?];
        assert_eq!(
            GameSettings::custom(week, &demand, CommitMode::Manual, &input()).is_ok(),
            ok,
            "最終週 {week}"
        );
    }
    Ok(())
}

#[test]
fn ac1_1_6__確定方式は手動が既定で_自動にしても設定の種別はキットのままである() -> R<()> {
    assert_eq!(CommitMode::default(), CommitMode::Manual);
    let auto = GameSettings::kit(3, &[4, 4, 4], CommitMode::Auto).map_err(err)?;
    assert_eq!(auto.commit_mode, CommitMode::Auto);
    assert_eq!(auto.kind(), SettingsKind::Kit);
    Ok(())
}
