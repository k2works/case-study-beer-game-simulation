//! テストの部品。Given は、過去のイベントの列を `replay_*` で畳み込んだ状態で作る。

use beergame_domain::{
    Actor, CommitMode, DecisionVersion, DisplayName, GameCommand, GameEvent, GameId, GameSettings,
    GameState, Instant, JoinCode, ParticipantId, Quantity, RetentionDays, Role, SessionEvent,
    SessionState, StartGame, Week, replay_game, replay_session, start_game,
};

pub type R<T> = Result<T, String>;

pub fn err<E: std::fmt::Debug>(e: E) -> String {
    format!("{e:?}")
}

pub const GAME: GameId = GameId::new(1);

pub fn at() -> Instant {
    Instant::from_epoch_millis(1_000)
}

pub fn expires() -> Instant {
    Instant::from_epoch_millis(9_000_000)
}

pub fn pid(n: u128) -> ParticipantId {
    ParticipantId::new(n)
}

pub fn facilitator() -> Actor {
    Actor::Facilitator(GAME)
}

pub fn participant(n: u128) -> Actor {
    Actor::Participant(pid(n))
}

pub fn week(n: i64) -> R<Week> {
    Week::of(n).map_err(err)
}

pub fn quantity(n: i64) -> R<Quantity> {
    Quantity::of(n).map_err(err)
}

/// 最終週 3、需要 4・4・4 のキット準拠の設定。
pub fn settings() -> R<GameSettings> {
    GameSettings::kit(3, &[4, 4, 4], CommitMode::Manual).map_err(err)
}

pub fn game_created() -> R<GameEvent> {
    Ok(GameEvent::GameCreated {
        game_id: GAME,
        join_code: JoinCode::of("abcd1234").map_err(err)?,
        settings: settings()?,
        retention_days: RetentionDays::of(30).map_err(err)?,
        facilitator_credential_expires_at: expires(),
    })
}

pub fn create_game(actor: Actor) -> R<GameCommand> {
    Ok(GameCommand::CreateGame {
        actor,
        at: at(),
        game_id: GAME,
        join_code: JoinCode::of("abcd1234").map_err(err)?,
        settings: settings()?,
        retention_days: RetentionDays::of(30).map_err(err)?,
        facilitator_credential_expires_at: expires(),
    })
}

pub fn join_game(n: u128) -> R<GameCommand> {
    Ok(GameCommand::JoinGame {
        actor: Actor::Anonymous,
        at: at(),
        participant_id: pid(n),
        display_name: DisplayName::of("参加者").map_err(err)?,
        credential_expires_at: expires(),
    })
}

pub fn assign_role(actor: Actor, n: u128, role: Role) -> GameCommand {
    GameCommand::AssignRole {
        actor,
        at: at(),
        participant_id: pid(n),
        role,
    }
}

pub fn participant_joined(n: u128) -> GameEvent {
    GameEvent::ParticipantJoined {
        participant_id: pid(n),
        credential_expires_at: expires(),
    }
}

pub fn role_assigned(n: u128, role: Role) -> GameEvent {
    GameEvent::RoleAssigned {
        participant_id: pid(n),
        role,
    }
}

pub fn role_unassigned(n: u128, role: Role) -> GameEvent {
    GameEvent::RoleUnassigned {
        participant_id: pid(n),
        role,
    }
}

/// 参加者 1〜4 を、工場・一次卸・二次卸・小売店に割り当てた準備中のゲームのイベント。
pub fn fully_assigned_events() -> R<Vec<GameEvent>> {
    let mut events = vec![game_created()?];
    for (n, role) in [
        (1, Role::Factory),
        (2, Role::Distributor),
        (3, Role::Wholesaler),
        (4, Role::Retailer),
    ] {
        events.push(participant_joined(n));
        events.push(role_assigned(n, role));
    }
    Ok(events)
}

/// イベントの列から状態を作る。decide が作らない列（Ignored）が混じっていれば、Given の誤りとして失敗させる。
pub fn game_of(events: &[GameEvent]) -> R<GameState> {
    let (state, ignored) = replay_game(events);
    if ignored.is_empty() {
        Ok(state)
    } else {
        Err(format!("Given に decide が作らない列がある: {ignored:?}"))
    }
}

pub fn session_of(events: &[SessionEvent]) -> R<SessionState> {
    let (state, ignored) = replay_session(events);
    if ignored.is_empty() {
        Ok(state)
    } else {
        Err(format!("Given に decide が作らない列がある: {ignored:?}"))
    }
}

/// 全員を割り当て済みの準備中のゲームから、開始して得た session の `SessionStarted`。
pub fn session_started() -> R<SessionEvent> {
    let game = game_of(&fully_assigned_events()?)?;
    let decision = start_game(
        &game,
        &SessionState::NotStarted,
        &StartGame {
            actor: facilitator(),
            at: at(),
        },
    )
    .map_err(err)?;
    decision
        .session
        .into_iter()
        .next()
        .ok_or("SessionStarted が無い".to_owned())
}

pub fn version(n: u32) -> DecisionVersion {
    DecisionVersion::new(n)
}
