// 理由: RT1 の命名（承認済み）の `__` を使うため。
#![allow(non_snake_case)]

//! イベントの JSON 変換（往復）。ゲームの開始から最終週の確定までの全イベントが、変換して戻すと同じになる。

use beergame_adapter_persistence::{EventCodec, GameCodec, SessionCodec};
use beergame_domain::{
    Actor, CommitMode, DecisionVersion, DisplayName, GameCommand, GameId, GameSettings, GameState,
    Instant, JoinCode, ParticipantId, Quantity, RetentionDays, Role, RoleMap, SessionCommand,
    SessionState, StartGame, Week, decide_game, decide_session, evolve_game, evolve_session,
    start_game,
};

type R<T> = Result<T, String>;

fn e<T: std::fmt::Debug>(x: T) -> String {
    format!("{x:?}")
}

const GAME: GameId = GameId::new(0x1234_5678_9abc_def0_1234_5678_9abc_def0);

fn roundtrip<Ev: Clone + PartialEq + std::fmt::Debug>(
    codec: &impl EventCodec<Ev>,
    event: &Ev,
) -> R<()> {
    let (event_type, schema, payload) = codec.encode(event)?;
    let back = codec.decode(&event_type, schema, payload)?;
    if back == *event {
        Ok(())
    } else {
        Err(format!("往復で変わった: {event:?} -> {back:?}"))
    }
}

#[test]
fn ac2_3_4__ゲームの全イベントは_JSON_に変換して戻すと同じになる() -> R<()> {
    let at = Instant::from_epoch_millis(1_000);
    let expires = Instant::from_epoch_millis(9_000_000);
    let settings = GameSettings::kit(2, &[4, 8], CommitMode::Manual).map_err(e)?;
    let mut game = GameState::NotCreated;
    let mut game_events = Vec::new();
    let mut apply = |game: &mut GameState, command: GameCommand| -> R<()> {
        for event in decide_game(game, &command).map_err(e)? {
            game_events.push(event.clone());
            *game = evolve_game(game.clone(), &event).into_state();
        }
        Ok(())
    };
    apply(
        &mut game,
        GameCommand::CreateGame {
            actor: Actor::Anonymous,
            at,
            game_id: GAME,
            join_code: JoinCode::of("abcd1234").map_err(e)?,
            settings,
            retention_days: RetentionDays::of(30).map_err(e)?,
            facilitator_credential_expires_at: expires,
        },
    )?;
    for (n, role) in [
        (1_u128, Role::Factory),
        (2, Role::Distributor),
        (3, Role::Wholesaler),
        (4, Role::Retailer),
    ] {
        apply(
            &mut game,
            GameCommand::JoinGame {
                actor: Actor::Anonymous,
                at,
                participant_id: ParticipantId::new(n),
                display_name: DisplayName::of("参加者").map_err(e)?,
                credential_expires_at: expires,
            },
        )?;
        apply(
            &mut game,
            GameCommand::AssignRole {
                actor: Actor::Facilitator(GAME),
                at,
                participant_id: ParticipantId::new(n),
                role,
            },
        )?;
    }
    // 付け替え（RoleUnassigned）も通す
    apply(
        &mut game,
        GameCommand::AssignRole {
            actor: Actor::Facilitator(GAME),
            at,
            participant_id: ParticipantId::new(4),
            role: Role::Wholesaler,
        },
    )?;
    apply(
        &mut game,
        GameCommand::AssignRole {
            actor: Actor::Facilitator(GAME),
            at,
            participant_id: ParticipantId::new(4),
            role: Role::Retailer,
        },
    )?;
    let started = start_game(
        &game,
        &SessionState::NotStarted,
        &StartGame {
            actor: Actor::Facilitator(GAME),
            at,
        },
    )
    .map_err(e)?;
    game_events.extend(started.game.clone());
    for event in &game_events {
        roundtrip(&GameCodec, event)?;
    }

    // session: 開始 → 全役割の保存 → 確定（週 1）→ 保存 → 確定（最終週。SessionEnded）
    let mut session = SessionState::NotStarted;
    let mut session_events = started.session;
    for event in &session_events {
        session = evolve_session(session, event).into_state();
    }
    for week in [1_i64, 2] {
        for (n, role) in [
            (1_u128, Role::Factory),
            (2, Role::Distributor),
            (3, Role::Wholesaler),
            (4, Role::Retailer),
        ] {
            let command = SessionCommand::SaveDecision {
                actor: Actor::Participant(ParticipantId::new(n)),
                at,
                role,
                requested_week: Week::of(week).map_err(e)?,
                quantity: Quantity::of(4).map_err(e)?,
                expected_decision_version: DecisionVersion::ZERO,
            };
            for event in decide_session(&session, &command).map_err(e)? {
                session_events.push(event.clone());
                session = evolve_session(session, &event).into_state();
            }
        }
        let command = SessionCommand::CommitWeek {
            actor: Actor::Facilitator(GAME),
            at,
            requested_week: Week::of(week).map_err(e)?,
            basis: RoleMap::all(&DecisionVersion::new(1)),
        };
        for event in decide_session(&session, &command).map_err(e)? {
            session_events.push(event.clone());
            session = evolve_session(session, &event).into_state();
        }
    }
    if !matches!(session, SessionState::Ended(_)) {
        return Err("最終週の確定で終了していない".to_owned());
    }
    for event in &session_events {
        roundtrip(&SessionCodec, event)?;
    }
    Ok(())
}

#[test]
fn ac2_3_4__不明なイベントと不正な値は変換に失敗する() {
    assert!(
        GameCodec
            .decode("Unknown", 1, serde_json::json!({}))
            .is_err()
    );
    assert!(
        SessionCodec
            .decode("Unknown", 1, serde_json::json!({}))
            .is_err()
    );
    assert!(
        GameCodec
            .decode(
                "RoleAssigned",
                1,
                serde_json::json!({"participantId": "x", "role": "RETAILER"})
            )
            .is_err()
    );
    assert!(
        SessionCodec
            .decode("SessionEnded", 1, serde_json::json!({"reason": "OTHER"}))
            .is_err()
    );
    assert!(
        GameCodec
            .decode("RoleAssigned", 1, serde_json::json!({"role": "RETAILER"}))
            .is_err()
    );
}

#[test]
fn d7__イベントに表示名を含めない() -> R<()> {
    let (_, _, payload) = GameCodec.encode(&beergame_domain::GameEvent::ParticipantJoined {
        participant_id: ParticipantId::new(1),
        credential_expires_at: Instant::from_epoch_millis(1),
    })?;
    if payload.to_string().contains("displayName") {
        Err("表示名がイベントに入った".to_owned())
    } else {
        Ok(())
    }
}
