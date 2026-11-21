//! ビールゲームのドメイン。純粋な関数と型だけを持つ（I/O・時計・乱数に依存しない）。

pub mod error;
pub mod kit_preset;
pub mod role;
pub mod settings;
pub mod simulate;
pub mod values;

pub use error::ValidationError;
pub use kit_preset::KitPreset;
pub use role::{Role, RoleMap};
pub use settings::{CostPolicy, DemandSeries};
pub use simulate::{
    Pipeline, RoleState, RoleWeekResult, SimulationSettings, WeekOutcome, simulate_week,
    team_cumulative_cost, team_weekly_cost,
};
pub use values::{Money, Quantity, Units, Week};
