//! カスタム条件（初期在庫・初期の流れ・遅延・費用単価・公開範囲）。キット準拠の値と比べて、設定の種別と変更した項目を導く（AC1.1.3）。
//! 範囲（仮置き。契約 `CustomConditions` の記述）: 初期在庫・初期の流れ 0〜1000、遅延 1〜8 週、費用単価 0〜100000（最小単位）。

use std::collections::BTreeMap;

use crate::error::ValidationError;
use crate::kit_preset::KitPreset;
use crate::role::{Role, RoleMap};
use crate::settings::CostPolicy;
use crate::values::{Money, Units};

/// プレイ中に観察者へ見せる範囲。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DisclosurePolicy {
    TeamTotal,
    None,
}

/// 設定の種別。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SettingsKind {
    Kit,
    Custom,
}

/// キットの値から変えた項目。
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum SettingsField {
    InitialInventory,
    InitialFlow,
    OrderDelay,
    ShipmentDelay,
    ProductionDelay,
    HoldingCost,
    BacklogCost,
    Disclosure,
}

/// 初期条件・遅延・公開範囲（費用単価は [`CostPolicy`]）。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Conditions {
    pub initial_inventory: RoleMap<Units>,
    pub initial_flow: Units,
    /// 注文の遅延（週）。1 以上。
    pub order_delay: u8,
    /// 配送の遅延（週）。1 以上。
    pub shipment_delay: u8,
    /// 工場の生産の遅延（週）。1 以上。
    pub production_delay: u8,
    pub disclosure: DisclosurePolicy,
}

/// 作成の入力のカスタム条件（省略した項目は `None`。キットの値になる）。
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ConditionsInput {
    pub initial_inventory: BTreeMap<Role, i64>,
    pub initial_flow: Option<i64>,
    pub order_delay_weeks: Option<i64>,
    pub shipment_delay_weeks: Option<i64>,
    pub production_delay_weeks: Option<i64>,
    pub holding_cost_minor: Option<i64>,
    pub backlog_cost_minor: Option<i64>,
    pub disclosure_policy: Option<String>,
}

const MAX_UNITS: i64 = 1000;
const MAX_DELAY: i64 = 8;
const MAX_COST_MINOR: i64 = 100_000;

fn in_range(
    value: Option<i64>,
    kit: i64,
    field: &'static str,
    role: Option<Role>,
    (min, max): (i64, i64),
    errors: &mut Vec<ValidationError>,
) -> i64 {
    match value {
        None => kit,
        Some(n) if (min..=max).contains(&n) => n,
        Some(_) => {
            errors.push(ValidationError::ConditionOutOfRange {
                field,
                role,
                min,
                max,
            });
            kit
        }
    }
}

impl Conditions {
    /// キット準拠の条件（BR-13）。
    #[must_use]
    pub fn kit() -> Self {
        Conditions {
            initial_inventory: RoleMap::all(&Units::new(KitPreset::INITIAL_INVENTORY)),
            initial_flow: Units::new(KitPreset::INITIAL_FLOW),
            order_delay: KitPreset::DELAY_WEEKS,
            shipment_delay: KitPreset::DELAY_WEEKS,
            production_delay: KitPreset::DELAY_WEEKS,
            disclosure: DisclosurePolicy::TeamTotal,
        }
    }

    /// 入力から条件と費用方針を作る。範囲外は、すべての項目の誤りを集めて返す。
    ///
    /// # Errors
    /// 範囲外の項目のすべて。
    pub fn of(input: &ConditionsInput) -> Result<(Self, CostPolicy), Vec<ValidationError>> {
        let kit = Conditions::kit();
        let kit_cost = crate::kit_preset::KitPreset::cost_policy();
        let mut errors = Vec::new();
        let units = (0, MAX_UNITS);
        let delay = (1, MAX_DELAY);
        let cost = (0, MAX_COST_MINOR);
        let mut per_role = BTreeMap::new();
        for role in Role::ALL {
            let n = in_range(
                input.initial_inventory.get(&role).copied(),
                i64::from(kit.initial_inventory.get(role).get()),
                "initialInventory",
                Some(role),
                units,
                &mut errors,
            );
            per_role.insert(role, Units::of(n).unwrap_or(Units::ZERO));
        }
        let inventory = RoleMap::of(|role| per_role.get(&role).copied().unwrap_or(Units::ZERO));
        let flow = in_range(
            input.initial_flow,
            4,
            "initialFlow",
            None,
            units,
            &mut errors,
        );
        let order = in_range(
            input.order_delay_weeks,
            2,
            "orderDelayWeeks",
            None,
            delay,
            &mut errors,
        );
        let shipment = in_range(
            input.shipment_delay_weeks,
            2,
            "shipmentDelayWeeks",
            None,
            delay,
            &mut errors,
        );
        let production = in_range(
            input.production_delay_weeks,
            2,
            "productionDelayWeeks",
            None,
            delay,
            &mut errors,
        );
        let holding = in_range(
            input.holding_cost_minor,
            kit_cost.holding.minor(),
            "holdingCostMinor",
            None,
            cost,
            &mut errors,
        );
        let backlog = in_range(
            input.backlog_cost_minor,
            kit_cost.backlog.minor(),
            "backlogCostMinor",
            None,
            cost,
            &mut errors,
        );
        let disclosure = match input.disclosure_policy.as_deref() {
            None | Some("TEAM_TOTAL") => DisclosurePolicy::TeamTotal,
            Some("NONE") => DisclosurePolicy::None,
            Some(_) => {
                errors.push(ValidationError::DisclosureInvalid);
                DisclosurePolicy::TeamTotal
            }
        };
        if !errors.is_empty() {
            return Err(errors);
        }
        Ok((
            Conditions {
                initial_inventory: inventory,
                initial_flow: Units::of(flow).unwrap_or(Units::ZERO),
                order_delay: u8::try_from(order).unwrap_or(2),
                shipment_delay: u8::try_from(shipment).unwrap_or(2),
                production_delay: u8::try_from(production).unwrap_or(2),
                disclosure,
            },
            CostPolicy {
                holding: Money::of(holding).unwrap_or(Money::ZERO),
                backlog: Money::of(backlog).unwrap_or(Money::ZERO),
            },
        ))
    }

    /// キットの値から変えた項目（`SettingsField` の順）。費用単価は `cost` と、キットの費用方針を比べる。
    #[must_use]
    pub fn changed_fields(&self, cost: &CostPolicy) -> Vec<SettingsField> {
        let kit = Conditions::kit();
        let kit_cost = crate::kit_preset::KitPreset::cost_policy();
        [
            (
                SettingsField::InitialInventory,
                self.initial_inventory != kit.initial_inventory,
            ),
            (
                SettingsField::InitialFlow,
                self.initial_flow != kit.initial_flow,
            ),
            (
                SettingsField::OrderDelay,
                self.order_delay != kit.order_delay,
            ),
            (
                SettingsField::ShipmentDelay,
                self.shipment_delay != kit.shipment_delay,
            ),
            (
                SettingsField::ProductionDelay,
                self.production_delay != kit.production_delay,
            ),
            (SettingsField::HoldingCost, cost.holding != kit_cost.holding),
            (SettingsField::BacklogCost, cost.backlog != kit_cost.backlog),
            (SettingsField::Disclosure, self.disclosure != kit.disclosure),
        ]
        .into_iter()
        .filter_map(|(field, changed)| changed.then_some(field))
        .collect()
    }
}
