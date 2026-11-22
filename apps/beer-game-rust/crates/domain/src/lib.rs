//! ビールゲームのドメイン。純粋な関数と型だけを持つ（I/O・時計・乱数に依存しない）。

pub mod conditions;
pub mod error;
pub mod foundation;
pub mod game;
pub mod kit_preset;
pub mod replace_role;
pub mod role;
pub mod session;
pub mod settings;
pub mod simulate;
pub mod start_game;
pub mod values;

pub use conditions::{Conditions, ConditionsInput, DisclosurePolicy, SettingsField, SettingsKind};
pub use error::ValidationError;
pub use foundation::{Actor, ErrorCategory, Evolution};
pub use game::{
    CommitMode, GameCommand, GameData, GameError, GameEvent, GameSettings, GameState, Invitation,
    decide_game, evolve_game, replay_game,
};
pub use kit_preset::KitPreset;
pub use replace_role::{AssignOrReplace, assign_or_replace};
pub use role::{Role, RoleMap};
pub use session::{
    CommitKind, DecisionEntry, Editor, EndReason, SAVE_LIMIT_PER_ROLE_WEEK, SessionCommand,
    SessionData, SessionError, SessionEvent, SessionState, decide_session, evolve_session,
    replay_session,
};
pub use settings::{CostPolicy, DemandSeries};
pub use simulate::{
    Pipeline, RoleState, RoleWeekResult, SimulationSettings, WeekOutcome, simulate_week,
    team_cumulative_cost, team_weekly_cost,
};
pub use start_game::{StartDecision, StartError, StartGame, start_game};
pub use values::{
    DecisionVersion, DisplayName, GameId, Instant, InvitationId, JoinCode, Money, ObserverId,
    ParticipantId, Quantity, RetentionDays, Units, Week,
};
