//! 役割の割り当て（準備中）と入れ替え（開始後）。開始後の入れ替えは `game` と `session` の 2 本のストリームにまたがるため、
//! `GameCommand` ではなく、`start_game` と同じく両方の状態を受け取る関数にする。

use crate::foundation::Actor;
use crate::game::{GameCommand, GameError, GameEvent, GameState, decide_game};
use crate::role::Role;
use crate::session::{SessionError, SessionEvent, SessionState};
use crate::start_game::{StartDecision, StartError};
use crate::values::{Instant, ParticipantId};

/// 割り当ての入力。
/// @landmark ddd 戦術的設計 | 2 つの集約にまたがる規則。開始後の入れ替えは game と session の 2 本のストリームに同時に事実を残すので、単独の集約ではなく、ここで束ねる
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AssignOrReplace {
    pub actor: Actor,
    pub at: Instant,
    pub participant_id: ParticipantId,
    pub role: Role,
}

/// 準備中は、割り当て・付け替え・割り当て直し（`decide_game`）。開始後は、**入れ替え**だけを受け付ける:
/// 役割を持たない参加者を、すでに担当者のいる役割へ割り当てると、その役割の担当者全員が外れ（資格は失効）、新担当者が引き継ぐ。
/// 判定順: 権限 → 終了済み → 対象の参加者 → 資格の失効 → 同じ役割への割り当て直し（変化なし）→ 別の役割にいる／担当者のいない役割（準備中でない）。
///
/// # Errors
/// 規則に反するとき、`StartError`（どちらの集約の誤りかを保つ）。
pub fn assign_or_replace(
    game: &GameState,
    session: &SessionState,
    command: &AssignOrReplace,
) -> Result<StartDecision, StartError> {
    let preparing = GameCommand::AssignRole {
        actor: command.actor,
        at: command.at,
        participant_id: command.participant_id,
        role: command.role,
    };
    let GameState::Started(data) = game else {
        return decide_game(game, &preparing)
            .map(|events| StartDecision {
                game: events,
                session: Vec::new(),
            })
            .map_err(StartError::Game);
    };
    if !command.actor.is_facilitator_of(data.game_id) {
        return Err(StartError::Game(GameError::Forbidden(
            "割り当ては進行役だけができる",
        )));
    }
    if matches!(session, SessionState::Ended(_)) {
        return Err(StartError::Session(SessionError::AlreadyEnded));
    }
    let current = data
        .participants
        .get(&command.participant_id)
        .ok_or(StartError::Game(GameError::ParticipantNotFound(
            command.participant_id,
        )))?;
    if data.revoked.contains(&command.participant_id) {
        return Err(StartError::Game(GameError::CredentialAlreadyRevoked(
            command.participant_id,
        )));
    }
    if *current == Some(command.role) {
        return Ok(StartDecision {
            game: Vec::new(),
            session: Vec::new(),
        });
    }
    let holders: Vec<ParticipantId> = data
        .role_assignments()
        .get(command.role)
        .iter()
        .copied()
        .collect();
    if current.is_some() || holders.is_empty() {
        return Err(StartError::Game(GameError::NotPreparing));
    }
    Ok(StartDecision {
        game: vec![GameEvent::ParticipantReplaced {
            participant_id: command.participant_id,
            role: command.role,
            replaced: holders,
        }],
        session: vec![SessionEvent::RoleReplaced {
            role: command.role,
            new_holder: command.participant_id,
        }],
    })
}
