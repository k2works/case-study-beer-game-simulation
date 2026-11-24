//! ゲームの開始（AC1.2.3）。2 つのストリームへ追記するイベントの組を返す。

use crate::fixtures::*;
use beergame_domain::{
    Actor, GameError, GameEvent, GameId, KitPreset, Role, SessionError, SessionEvent, SessionState,
    StartError, StartGame, start_game,
};

fn start(actor: Actor) -> StartGame {
    StartGame { actor, at: at() }
}

#[test]
fn ac1_2_3__全役割に参加者がいれば_GameStarted_と_SessionStarted_を返す() -> R<()> {
    let game = game_of(&fully_assigned_events()?)?;
    let decision =
        start_game(&game, &SessionState::NotStarted, &start(facilitator())).map_err(err)?;
    assert_eq!(
        decision.game,
        vec![GameEvent::GameStarted { game_id: GAME }]
    );
    let started = decision.session.first().ok_or("SessionStarted が無い")?;
    let SessionEvent::SessionStarted {
        game_id,
        assignments,
        initial_states,
        ..
    } = started
    else {
        return Err("SessionStarted ではない".to_owned());
    };
    assert_eq!(*game_id, GAME);
    assert_eq!(assignments.retailer.iter().next(), Some(&pid(4)));
    // 設定と役割の写しに加え、キット準拠の初期状態を持つ（D4）
    assert_eq!(
        *initial_states,
        KitPreset::initial_states(&settings()?.demand)
    );
    Ok(())
}

#[test]
fn ac1_2_3__役割が足りないと_不足を上流から下流の順に示して拒否する() -> R<()> {
    let game = game_of(&[
        game_created()?,
        participant_joined(1),
        role_assigned(1, Role::Distributor),
        participant_joined(2),
        role_assigned(2, Role::Retailer),
    ])?;
    assert_eq!(
        start_game(&game, &SessionState::NotStarted, &start(facilitator())),
        Err(StartError::Game(GameError::StartConditionNotMet(vec![
            Role::Factory,
            Role::Wholesaler
        ])))
    );
    Ok(())
}

#[test]
fn ac1_2_3__開始は進行役だけができる() -> R<()> {
    let game = game_of(&fully_assigned_events()?)?;
    for actor in [
        participant(1),
        Actor::Anonymous,
        Actor::Facilitator(GameId::new(2)),
    ] {
        let result = start_game(&game, &SessionState::NotStarted, &start(actor));
        assert!(matches!(
            result,
            Err(StartError::Game(GameError::Forbidden(_)))
        ));
    }
    Ok(())
}

#[test]
fn ac1_2_3__未作成のゲームは_NotPreparing() -> R<()> {
    assert_eq!(
        start_game(
            &beergame_domain::GameState::NotCreated,
            &SessionState::NotStarted,
            &start(facilitator())
        ),
        Err(StartError::Game(GameError::NotPreparing))
    );
    Ok(())
}

#[test]
fn ac1_2_3__開始済みのゲームは_AlreadyStarted() -> R<()> {
    let mut events = fully_assigned_events()?;
    events.push(GameEvent::GameStarted { game_id: GAME });
    let game = game_of(&events)?;
    let session = session_of(&[session_started()?])?;
    let result = start_game(&game, &session, &start(facilitator()));
    assert_eq!(
        result,
        Err(StartError::Session(SessionError::AlreadyStarted))
    );
    assert_eq!(result.map_err(|e| e.code()), Err("session.already_started"));
    Ok(())
}
