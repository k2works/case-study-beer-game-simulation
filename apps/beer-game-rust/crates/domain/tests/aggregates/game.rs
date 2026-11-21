//! Game 集約（AC1.1.1、AC1.2.1〜AC1.2.5）。

use crate::fixtures::*;
use beergame_domain::{
    Actor, ErrorCategory, GameError, GameEvent, GameState, Role, decide_game, evolve_game,
    replay_game,
};

#[test]
fn ac1_1_1__作成は一度だけ_匿名の操作者が作ると_GameCreated_を返す() -> R<()> {
    assert_eq!(
        decide_game(&GameState::NotCreated, &create_game(Actor::Anonymous)?),
        Ok(vec![game_created()?])
    );
    Ok(())
}

#[test]
fn ac1_1_1__作成済みや開始済みへの再作成は_AlreadyCreated() -> R<()> {
    let preparing = game_of(&[game_created()?])?;
    let mut events = fully_assigned_events()?;
    events.push(GameEvent::GameStarted { game_id: GAME });
    let started = game_of(&events)?;
    for state in [preparing, started] {
        assert_eq!(
            decide_game(&state, &create_game(Actor::Anonymous)?),
            Err(GameError::AlreadyCreated)
        );
    }
    Ok(())
}

#[test]
fn ac1_1_1__作成は匿名の操作者だけができる() -> R<()> {
    for actor in [facilitator(), participant(1)] {
        assert!(matches!(
            decide_game(&GameState::NotCreated, &create_game(actor)?),
            Err(GameError::Forbidden(_))
        ));
    }
    Ok(())
}

#[test]
fn ac1_2_1__準備中は参加できる_イベントには_ID_と資格の期限だけを入れる() -> R<()> {
    let preparing = game_of(&[game_created()?])?;
    assert_eq!(
        decide_game(&preparing, &join_game(1)?),
        Ok(vec![participant_joined(1)])
    );
    Ok(())
}

#[test]
fn ac1_2_1__同じ参加者_ID_の再参加は変化なし_履歴に足さない() -> R<()> {
    // 性質テスト（property.rs）が見つけた: decide が evolve の採用しないイベントを作っていた
    let joined = game_of(&[game_created()?, participant_joined(1)])?;
    assert_eq!(decide_game(&joined, &join_game(1)?), Ok(Vec::new()));
    Ok(())
}

#[test]
fn ac1_2_2__開始済みと未作成への参加は_NotPreparing() -> R<()> {
    let mut events = fully_assigned_events()?;
    events.push(GameEvent::GameStarted { game_id: GAME });
    for state in [game_of(&events)?, GameState::NotCreated] {
        assert_eq!(
            decide_game(&state, &join_game(5)?),
            Err(GameError::NotPreparing)
        );
    }
    Ok(())
}

#[test]
fn ac1_2_5__役割なしの参加者は割り当てられる() -> R<()> {
    let joined = game_of(&[
        game_created()?,
        participant_joined(1),
        participant_joined(2),
    ])?;
    assert_eq!(
        decide_game(&joined, &assign_role(facilitator(), 1, Role::Retailer)),
        Ok(vec![role_assigned(1, Role::Retailer)])
    );
    Ok(())
}

#[test]
fn ac1_2_5__別の役割への割り当ては_解除と割り当ての_2_イベント() -> R<()> {
    let on_retailer = game_of(&[
        game_created()?,
        participant_joined(1),
        role_assigned(1, Role::Retailer),
    ])?;
    assert_eq!(
        decide_game(
            &on_retailer,
            &assign_role(facilitator(), 1, Role::Wholesaler)
        ),
        Ok(vec![
            role_unassigned(1, Role::Retailer),
            role_assigned(1, Role::Wholesaler)
        ])
    );
    Ok(())
}

#[test]
fn ac1_2_5__同じ役割への割り当ては変化なし_履歴に足さない() -> R<()> {
    let on_retailer = game_of(&[
        game_created()?,
        participant_joined(1),
        role_assigned(1, Role::Retailer),
    ])?;
    assert_eq!(
        decide_game(&on_retailer, &assign_role(facilitator(), 1, Role::Retailer)),
        Ok(Vec::new())
    );
    Ok(())
}

#[test]
fn ac1_2_4__準備中は同じ役割に別の参加者も割り当てられる() -> R<()> {
    let state = game_of(&[
        game_created()?,
        participant_joined(1),
        participant_joined(2),
        role_assigned(1, Role::Retailer),
    ])?;
    assert_eq!(
        decide_game(&state, &assign_role(facilitator(), 2, Role::Retailer)),
        Ok(vec![role_assigned(2, Role::Retailer)])
    );
    Ok(())
}

#[test]
fn ac1_2_5__割り当ては進行役だけができる() -> R<()> {
    let joined = game_of(&[game_created()?, participant_joined(1)])?;
    for actor in [
        participant(1),
        Actor::Anonymous,
        Actor::Facilitator(beergame_domain::GameId::new(2)),
    ] {
        assert!(matches!(
            decide_game(&joined, &assign_role(actor, 1, Role::Retailer)),
            Err(GameError::Forbidden(_))
        ));
    }
    Ok(())
}

#[test]
fn ac1_2_5__未知の参加者への割り当ては_ParticipantNotFound() -> R<()> {
    let created = game_of(&[game_created()?])?;
    assert_eq!(
        decide_game(&created, &assign_role(facilitator(), 9, Role::Retailer)),
        Err(GameError::ParticipantNotFound(pid(9)))
    );
    Ok(())
}

#[test]
fn ac1_2_5__準備中でなければ割り当てられない() -> R<()> {
    assert_eq!(
        decide_game(
            &GameState::NotCreated,
            &assign_role(facilitator(), 1, Role::Retailer)
        ),
        Err(GameError::NotPreparing)
    );
    Ok(())
}

#[test]
fn evolve__イベントを畳み込むと参加者と役割が状態に反映される() -> R<()> {
    let state = game_of(&fully_assigned_events()?)?;
    let data = state.data().ok_or("データが無い")?;
    assert_eq!(data.participants.len(), 4);
    let assignments = data.role_assignments();
    assert_eq!(assignments.retailer.iter().next(), Some(&pid(4)));
    assert_eq!(assignments.factory.iter().next(), Some(&pid(1)));
    Ok(())
}

#[test]
fn evolve__付け替えのイベントで元の役割から外れる() -> R<()> {
    let state = game_of(&[
        game_created()?,
        participant_joined(1),
        role_assigned(1, Role::Retailer),
        role_unassigned(1, Role::Retailer),
        role_assigned(1, Role::Wholesaler),
    ])?;
    let assignments = state.data().ok_or("データが無い")?.role_assignments();
    assert!(assignments.retailer.is_empty());
    assert_eq!(assignments.wholesaler.len(), 1);
    Ok(())
}

#[test]
fn evolve__decide_が作らない列は_Ignored_で状態が変わらない() -> R<()> {
    // 未作成への参加、重複した参加、未知の参加者への割り当て、開始前の GameStarted の再適用
    let created = game_of(&[game_created()?])?;
    let cases = [
        (GameState::NotCreated, participant_joined(1)),
        (
            game_of(&[game_created()?, participant_joined(1)])?,
            participant_joined(1),
        ),
        (created.clone(), role_assigned(9, Role::Retailer)),
        (created.clone(), role_unassigned(9, Role::Retailer)),
        (created, game_created()?),
    ];
    for (state, event) in cases {
        let next = evolve_game(state.clone(), &event);
        assert!(next.is_ignored(), "{event:?}");
        assert_eq!(next.into_state(), state);
    }
    Ok(())
}

#[test]
fn evolve__開始済みへの割り当てと再開始は_Ignored() -> R<()> {
    let mut events = fully_assigned_events()?;
    events.push(GameEvent::GameStarted { game_id: GAME });
    let started = game_of(&events)?;
    for event in [
        role_assigned(1, Role::Retailer),
        participant_joined(9),
        GameEvent::GameStarted { game_id: GAME },
    ] {
        assert!(
            evolve_game(started.clone(), &event).is_ignored(),
            "{event:?}"
        );
    }
    Ok(())
}

#[test]
fn replay__decide_が作らない列の位置を返す() -> R<()> {
    let (_, ignored) = replay_game(&[
        game_created()?,
        participant_joined(1),
        participant_joined(1),
        role_assigned(9, Role::Retailer),
    ]);
    assert_eq!(ignored, vec![2, 3]);
    Ok(())
}

#[test]
fn エラーの_code_と_category_は_API_の契約として固定される() {
    let cases = [
        (
            GameError::AlreadyCreated,
            "game.already_created",
            ErrorCategory::InvalidState,
        ),
        (
            GameError::NotPreparing,
            "game.not_preparing",
            ErrorCategory::InvalidState,
        ),
        (
            GameError::Forbidden("x"),
            "game.forbidden",
            ErrorCategory::Forbidden,
        ),
        (
            GameError::ParticipantNotFound(pid(1)),
            "game.participant_not_found",
            ErrorCategory::NotFound,
        ),
        (
            GameError::StartConditionNotMet(vec![Role::Factory]),
            "game.start_condition_not_met",
            ErrorCategory::RuleViolation,
        ),
    ];
    for (error, code, category) in cases {
        assert_eq!(error.code(), code);
        assert_eq!(error.category(), category);
    }
}
