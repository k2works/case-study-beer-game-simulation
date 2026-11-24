//! 役割の割り当てと入れ替え（AC1.2.4・AC1.2.5・AC3.2.5）。

use crate::fixtures::*;
use beergame_domain::{
    Actor, AssignOrReplace, GameError, GameEvent, GameState, Role, SessionError, SessionEvent,
    SessionState, StartError, assign_or_replace, evolve_game, evolve_session,
};

fn cmd(actor: Actor, n: u128, role: Role) -> AssignOrReplace {
    AssignOrReplace {
        actor,
        at: at(),
        participant_id: pid(n),
        role,
    }
}

/// 開始後のゲーム（参加者 1〜4 が各役割）と、参加者 5（役割なし）。
fn started_with_spare() -> R<(GameState, SessionState)> {
    let mut events = fully_assigned_events()?;
    events.push(participant_joined(5));
    events.push(GameEvent::GameStarted { game_id: GAME });
    Ok((game_of(&events)?, session_of(&[session_started()?])?))
}

#[test]
fn ac1_2_4__準備中の割り当ては_ゲームのイベントだけを返す() -> R<()> {
    let state = game_of(&[game_created()?, participant_joined(1)])?;
    let decision = assign_or_replace(
        &state,
        &SessionState::NotStarted,
        &cmd(facilitator(), 1, Role::Retailer),
    )
    .map_err(err)?;
    assert_eq!(decision.game, vec![role_assigned(1, Role::Retailer)]);
    assert!(decision.session.is_empty());
    Ok(())
}

#[test]
fn ac1_2_4__未作成は_準備中でない() {
    assert_eq!(
        assign_or_replace(
            &GameState::NotCreated,
            &SessionState::NotStarted,
            &cmd(facilitator(), 1, Role::Retailer)
        ),
        Err(StartError::Game(GameError::NotPreparing))
    );
}

#[test]
fn ac3_2_5__開始後に役割を持たない参加者を割り当てると_担当者全員が入れ替わる() -> R<()> {
    let (game, session) = started_with_spare()?;
    let decision =
        assign_or_replace(&game, &session, &cmd(facilitator(), 5, Role::Retailer)).map_err(err)?;
    assert_eq!(
        decision.game,
        vec![GameEvent::ParticipantReplaced {
            participant_id: pid(5),
            role: Role::Retailer,
            replaced: vec![pid(4)],
        }]
    );
    assert_eq!(
        decision.session,
        vec![SessionEvent::RoleReplaced {
            role: Role::Retailer,
            new_holder: pid(5),
        }]
    );
    // 採用すると、旧担当者は役割を失い資格が失効し、新担当者が引き継ぐ。session の担当者も入れ替わる
    let GameState::Started(data) = evolve_game(game, &decision.game[0]).into_state() else {
        return Err("開始後ではない".to_owned());
    };
    assert_eq!(data.participants.get(&pid(4)), Some(&None));
    assert_eq!(data.participants.get(&pid(5)), Some(&Some(Role::Retailer)));
    assert!(data.revoked.contains(&pid(4)));
    let SessionState::Active(active) = evolve_session(session, &decision.session[0]).into_state()
    else {
        return Err("進行中ではない".to_owned());
    };
    assert_eq!(
        active
            .assignments
            .get(Role::Retailer)
            .iter()
            .copied()
            .collect::<Vec<_>>(),
        vec![pid(5)]
    );
    Ok(())
}

#[test]
fn ac3_2_5__開始後の拒否の順序と変化なし() -> R<()> {
    let (game, session) = started_with_spare()?;
    // 進行役以外
    assert!(matches!(
        assign_or_replace(&game, &session, &cmd(participant(4), 5, Role::Retailer)),
        Err(StartError::Game(GameError::Forbidden(_)))
    ));
    // 未知の参加者
    assert_eq!(
        assign_or_replace(&game, &session, &cmd(facilitator(), 9, Role::Retailer)),
        Err(StartError::Game(GameError::ParticipantNotFound(pid(9))))
    );
    // 同じ役割への割り当て直しは、何も変わらない
    let none =
        assign_or_replace(&game, &session, &cmd(facilitator(), 4, Role::Retailer)).map_err(err)?;
    assert!(none.game.is_empty() && none.session.is_empty());
    // 別の役割にいる人の付け替えは、準備中でない
    assert_eq!(
        assign_or_replace(&game, &session, &cmd(facilitator(), 3, Role::Retailer)),
        Err(StartError::Game(GameError::NotPreparing))
    );
    // 資格が失効している人は、新担当者になれない
    let mut events = fully_assigned_events()?;
    events.push(participant_joined(5));
    events.push(GameEvent::CredentialRevoked {
        participant_id: pid(5),
    });
    events.push(GameEvent::GameStarted { game_id: GAME });
    assert_eq!(
        assign_or_replace(
            &game_of(&events)?,
            &session,
            &cmd(facilitator(), 5, Role::Retailer)
        ),
        Err(StartError::Game(GameError::CredentialAlreadyRevoked(pid(
            5
        ))))
    );
    // 終了している
    let SessionState::Active(data) = session else {
        return Err("進行中ではない".to_owned());
    };
    assert_eq!(
        assign_or_replace(
            &game,
            &SessionState::Ended(data),
            &cmd(facilitator(), 5, Role::Retailer)
        ),
        Err(StartError::Session(SessionError::AlreadyEnded))
    );
    Ok(())
}

#[test]
fn evolve__入れ替えが採用されない列は_Ignored() -> R<()> {
    let replaced = GameEvent::ParticipantReplaced {
        participant_id: pid(5),
        role: Role::Retailer,
        replaced: vec![pid(4)],
    };
    // 準備中・未作成
    assert!(evolve_game(game_of(&fully_assigned_events()?)?, &replaced).is_ignored());
    assert!(evolve_game(GameState::NotCreated, &replaced).is_ignored());
    let (started, _) = started_with_spare()?;
    // 旧担当者が空、旧担当者がその役割にいない、新担当者が未知
    for bad in [
        GameEvent::ParticipantReplaced {
            participant_id: pid(5),
            role: Role::Retailer,
            replaced: vec![],
        },
        GameEvent::ParticipantReplaced {
            participant_id: pid(5),
            role: Role::Retailer,
            replaced: vec![pid(3)],
        },
        GameEvent::ParticipantReplaced {
            participant_id: pid(9),
            role: Role::Retailer,
            replaced: vec![pid(4)],
        },
    ] {
        assert!(evolve_game(started.clone(), &bad).is_ignored());
    }
    // session: 開始前は採用しない
    assert!(
        evolve_session(
            SessionState::NotStarted,
            &SessionEvent::RoleReplaced {
                role: Role::Retailer,
                new_holder: pid(5),
            }
        )
        .is_ignored()
    );
    Ok(())
}
