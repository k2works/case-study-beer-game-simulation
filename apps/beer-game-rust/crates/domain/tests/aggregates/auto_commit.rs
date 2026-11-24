//! 自動確定（AC1.1.6・AC2.4.1〜AC2.4.5）。

use crate::fixtures::*;
use beergame_domain::{
    Actor, CommitKind, CommitMode, Editor, Role, SessionCommand, SessionError, SessionEvent,
    SessionState, decide_session, evolve_session,
};

/// 自動確定（`mode`）で開始したセッション。
fn started(mode: CommitMode) -> R<SessionEvent> {
    let SessionEvent::SessionStarted {
        game_id,
        settings,
        assignments,
        initial_states,
        ..
    } = session_started()?
    else {
        return Err("SessionStarted ではない".to_owned());
    };
    Ok(SessionEvent::SessionStarted {
        game_id,
        settings,
        assignments,
        initial_states,
        commit_mode: mode,
    })
}

fn saved(role: Role, who: u128, count: usize) -> R<SessionEvent> {
    Ok(SessionEvent::DecisionSaved {
        week: week(1)?,
        role,
        quantity: quantity(4)?,
        decision_version: version(1),
        editor: Editor::ByParticipant(pid(who)),
        submitted_role_count: count,
    })
}

fn three_saved(mode: CommitMode) -> R<Vec<SessionEvent>> {
    Ok(vec![
        started(mode)?,
        saved(Role::Retailer, 4, 1)?,
        saved(Role::Wholesaler, 3, 2)?,
        saved(Role::Distributor, 2, 3)?,
    ])
}

fn save_factory(actor: Actor) -> R<SessionCommand> {
    Ok(SessionCommand::SaveDecision {
        actor,
        at: at(),
        role: Role::Factory,
        requested_week: week(1)?,
        quantity: quantity(4)?,
        expected_decision_version: version(0),
    })
}

fn set_mode(actor: Actor, mode: CommitMode) -> SessionCommand {
    SessionCommand::SetCommitMode {
        actor,
        at: at(),
        mode,
    }
}

fn committed_kind(events: &[SessionEvent]) -> Option<CommitKind> {
    events.iter().find_map(|e| match e {
        SessionEvent::WeekCommitted { commit_kind, .. } => Some(*commit_kind),
        SessionEvent::SessionStarted { .. }
        | SessionEvent::DecisionSaved { .. }
        | SessionEvent::ProxyDecisionSubmitted { .. }
        | SessionEvent::SessionEnded { .. }
        | SessionEvent::SessionPaused
        | SessionEvent::SessionResumed
        | SessionEvent::CommitModeChanged { .. }
        | SessionEvent::RoleReplaced { .. } => None,
    })
}

#[test]
fn ac2_4_1__最後の入力で_4_役割がそろうと_同じ追記で週が確定される() -> R<()> {
    let state = session_of(&three_saved(CommitMode::Auto)?)?;
    let events = decide_session(&state, &save_factory(participant(1))?).map_err(err)?;
    assert!(matches!(
        events.first(),
        Some(SessionEvent::DecisionSaved { .. })
    ));
    assert_eq!(committed_kind(&events), Some(CommitKind::Auto));
    // 代理入力でそろった場合も確定する
    let proxy = SessionCommand::SubmitProxyDecision {
        actor: facilitator(),
        at: at(),
        role: Role::Factory,
        requested_week: week(1)?,
        quantity: quantity(4)?,
    };
    let events = decide_session(&state, &proxy).map_err(err)?;
    assert_eq!(committed_kind(&events), Some(CommitKind::Auto));
    // そろっていなければ確定しない
    let two = session_of(&[started(CommitMode::Auto)?, saved(Role::Retailer, 4, 1)?])?;
    let events = decide_session(&two, &save_factory(participant(1))?).map_err(err)?;
    assert_eq!(committed_kind(&events), None);
    Ok(())
}

#[test]
fn ac2_4_2__手動確定のゲームでは_そろっても確定しない() -> R<()> {
    let state = session_of(&three_saved(CommitMode::Manual)?)?;
    let events = decide_session(&state, &save_factory(participant(1))?).map_err(err)?;
    assert_eq!(committed_kind(&events), None);
    assert_eq!(events.len(), 1);
    Ok(())
}

#[test]
fn ac2_4_3__停止中の代理入力ではそろっても確定せず_再開すると確定する() -> R<()> {
    let mut events = three_saved(CommitMode::Auto)?;
    events.push(SessionEvent::SessionPaused);
    let paused = session_of(&events)?;
    let proxy = SessionCommand::SubmitProxyDecision {
        actor: facilitator(),
        at: at(),
        role: Role::Factory,
        requested_week: week(1)?,
        quantity: quantity(4)?,
    };
    let proxied = decide_session(&paused, &proxy).map_err(err)?;
    assert_eq!(committed_kind(&proxied), None);
    let mut all = events.clone();
    all.extend(proxied);
    let resumed = decide_session(
        &session_of(&all)?,
        &SessionCommand::ResumeSession {
            actor: facilitator(),
            at: at(),
        },
    )
    .map_err(err)?;
    assert!(matches!(
        resumed.first(),
        Some(SessionEvent::SessionResumed)
    ));
    assert_eq!(committed_kind(&resumed), Some(CommitKind::Auto));
    // 入力がそろっていなければ、再開しても確定しない
    let not_complete = decide_session(
        &session_of(&[started(CommitMode::Auto)?, SessionEvent::SessionPaused])?,
        &SessionCommand::ResumeSession {
            actor: facilitator(),
            at: at(),
        },
    )
    .map_err(err)?;
    assert_eq!(committed_kind(&not_complete), None);
    Ok(())
}

#[test]
fn ac2_4_4__自動確定のあとの手動確定は_週がすでに進んでいるので拒否される() -> R<()> {
    let state = session_of(&three_saved(CommitMode::Auto)?)?;
    let mut events = three_saved(CommitMode::Auto)?;
    events.extend(decide_session(&state, &save_factory(participant(1))?).map_err(err)?);
    let after = session_of(&events)?;
    let manual = SessionCommand::CommitWeek {
        actor: facilitator(),
        at: at(),
        requested_week: week(1)?,
        basis: beergame_domain::RoleMap::all(&version(1)),
    };
    assert!(matches!(
        decide_session(&after, &manual),
        Err(SessionError::WeekAdvanced { .. })
    ));
    Ok(())
}

#[test]
fn ac2_4_5__確定方式を変えると_有効にした時点でそろっていれば確定する() -> R<()> {
    // 無効にする。同じ方式なら何もしない
    let auto = session_of(&three_saved(CommitMode::Auto)?)?;
    assert_eq!(
        decide_session(&auto, &set_mode(facilitator(), CommitMode::Manual)),
        Ok(vec![SessionEvent::CommitModeChanged {
            mode: CommitMode::Manual
        }])
    );
    assert_eq!(
        decide_session(&auto, &set_mode(facilitator(), CommitMode::Auto)),
        Ok(Vec::new())
    );
    // すでにそろっている手動のセッションで有効にすると、その場で確定する
    let mut events = three_saved(CommitMode::Manual)?;
    events.push(saved(Role::Factory, 1, 4)?);
    let complete = session_of(&events)?;
    let enabled =
        decide_session(&complete, &set_mode(facilitator(), CommitMode::Auto)).map_err(err)?;
    assert!(matches!(
        enabled.first(),
        Some(SessionEvent::CommitModeChanged {
            mode: CommitMode::Auto
        })
    ));
    assert_eq!(committed_kind(&enabled), Some(CommitKind::Auto));
    // 停止中は確定しない。参加者は変えられない。開始前・終了後は拒否
    events.push(SessionEvent::SessionPaused);
    let paused = decide_session(
        &session_of(&events)?,
        &set_mode(facilitator(), CommitMode::Auto),
    )
    .map_err(err)?;
    assert_eq!(committed_kind(&paused), None);
    assert!(matches!(
        decide_session(&complete, &set_mode(participant(1), CommitMode::Manual)),
        Err(SessionError::Forbidden(_))
    ));
    assert_eq!(
        decide_session(
            &SessionState::NotStarted,
            &set_mode(facilitator(), CommitMode::Auto)
        ),
        Err(SessionError::NotActive)
    );
    Ok(())
}

#[test]
fn evolve__確定方式の変更は_進行中のときだけ採用する() -> R<()> {
    let changed = SessionEvent::CommitModeChanged {
        mode: CommitMode::Auto,
    };
    assert!(evolve_session(SessionState::NotStarted, &changed).is_ignored());
    let SessionState::Active(data) =
        evolve_session(session_of(&[started(CommitMode::Manual)?])?, &changed).into_state()
    else {
        return Err("進行中ではない".to_owned());
    };
    assert_eq!(data.commit_mode, CommitMode::Auto);
    Ok(())
}
