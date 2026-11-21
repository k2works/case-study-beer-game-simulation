//! ゲームの開始。2 つのストリームにまたがるため、`GameCommand` ではなく `start_game` の入力にする。

use crate::foundation::{Actor, ErrorCategory};
use crate::game::{GameError, GameEvent, GameState};
use crate::kit_preset::KitPreset;
use crate::role::Role;
use crate::session::{SessionError, SessionEvent, SessionState};
use crate::values::Instant;

/// 開始の入力。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct StartGame {
    pub actor: Actor,
    pub at: Instant,
}

/// 開始で、2 つのストリームへ同一トランザクションで追記するイベント（追記の原子性は境界の責務）。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StartDecision {
    pub game: Vec<GameEvent>,
    pub session: Vec<SessionEvent>,
}

/// 開始の誤り。どちらの集約の誤りかを保ち、`code`・`category` はそれぞれの値をそのまま返す。
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum StartError {
    Game(GameError),
    Session(SessionError),
}

impl StartError {
    #[must_use]
    pub const fn code(&self) -> &'static str {
        match self {
            StartError::Game(e) => e.code(),
            StartError::Session(e) => e.code(),
        }
    }

    #[must_use]
    pub const fn category(&self) -> ErrorCategory {
        match self {
            StartError::Game(e) => e.category(),
            StartError::Session(e) => e.category(),
        }
    }
}

/// 開始。進行役だけが、準備中のゲームを、各役割に 1 人以上が割り当て済みのときに開始できる（AC1.2.3）。
/// 判定順: 権限 → 開始済み → 開始条件。`SessionStarted` は、設定と役割の割り当ての写しと、キット準拠の初期状態を持つ（D4）。
///
/// # Errors
/// 規則に反するとき、`StartError`。
pub fn start_game(
    game: &GameState,
    session: &SessionState,
    command: &StartGame,
) -> Result<StartDecision, StartError> {
    let data = game
        .data()
        .ok_or(StartError::Game(GameError::NotPreparing))?;
    if !command.actor.is_facilitator_of(data.game_id) {
        return Err(StartError::Game(GameError::Forbidden(
            "開始は進行役だけができる",
        )));
    }
    if !(matches!(game, GameState::Preparing(_)) && matches!(session, SessionState::NotStarted)) {
        return Err(StartError::Session(SessionError::AlreadyStarted));
    }
    let assignments = data.role_assignments();
    let missing: Vec<Role> = Role::ALL
        .into_iter()
        .filter(|role| assignments.get(*role).is_empty())
        .collect();
    if !missing.is_empty() {
        return Err(StartError::Game(GameError::StartConditionNotMet(missing)));
    }
    Ok(StartDecision {
        game: vec![GameEvent::GameStarted {
            game_id: data.game_id,
        }],
        session: vec![SessionEvent::SessionStarted {
            game_id: data.game_id,
            settings: data.settings.clone(),
            assignments,
            initial_states: KitPreset::initial_states(&data.settings.demand),
            commit_mode: data.settings.commit_mode,
        }],
    })
}
