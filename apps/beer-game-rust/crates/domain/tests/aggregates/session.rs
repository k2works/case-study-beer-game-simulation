//! Session 集約（AC2.2.1、AC2.2.2、AC2.3.1〜AC2.3.5）。

use crate::fixtures::*;
use beergame_domain::{
    Actor, CommitKind, EndReason, ErrorCategory, Role, RoleMap, SAVE_LIMIT_PER_ROLE_WEEK,
    SessionCommand, SessionError, SessionEvent, SessionState, decide_session, evolve_session,
    replay_session,
};

fn save(actor: Actor, role: Role, week_n: i64, q: i64, expected: u32) -> R<SessionCommand> {
    Ok(SessionCommand::SaveDecision {
        actor,
        at: at(),
        role,
        requested_week: week(week_n)?,
        quantity: quantity(q)?,
        expected_decision_version: version(expected),
    })
}

fn saved(role: Role, week_n: i64, q: i64, v: u32, who: u128, count: usize) -> R<SessionEvent> {
    Ok(SessionEvent::DecisionSaved {
        week: week(week_n)?,
        role,
        quantity: quantity(q)?,
        decision_version: version(v),
        editor: beergame_domain::Editor::ByParticipant(pid(who)),
        submitted_role_count: count,
    })
}

fn owner_of(role: Role) -> u128 {
    match role {
        Role::Factory => 1,
        Role::Distributor => 2,
        Role::Wholesaler => 3,
        Role::Retailer => 4,
    }
}

/// 全役割が当週に 4 を保存した後のイベント（版は 1）。
fn all_saved(week_n: i64, q: i64) -> R<Vec<SessionEvent>> {
    Role::ALL
        .iter()
        .enumerate()
        .map(|(i, role)| saved(*role, week_n, q, 1, owner_of(*role), i + 1))
        .collect()
}

fn commit(week_n: i64, versions: u32) -> R<SessionCommand> {
    Ok(SessionCommand::CommitWeek {
        actor: facilitator(),
        at: at(),
        requested_week: week(week_n)?,
        basis: RoleMap::all(&version(versions)),
    })
}

fn active() -> R<SessionState> {
    session_of(&[session_started()?])
}

#[test]
fn ac2_2_1__その役割の参加者は当週の入力を保存できる() -> R<()> {
    assert_eq!(
        decide_session(&active()?, &save(participant(4), Role::Retailer, 1, 8, 0)?),
        Ok(vec![saved(Role::Retailer, 1, 8, 1, 4, 1)?])
    );
    Ok(())
}

#[test]
fn ac2_2_1__保存した役割の数を数える() -> R<()> {
    let state = session_of(&[session_started()?, saved(Role::Retailer, 1, 8, 1, 4, 1)?])?;
    assert_eq!(
        decide_session(&state, &save(participant(1), Role::Factory, 1, 6, 0)?),
        Ok(vec![saved(Role::Factory, 1, 6, 1, 1, 2)?])
    );
    Ok(())
}

#[test]
fn ac2_2_1__他の役割の参加者と進行役と匿名は入力できない() -> R<()> {
    for actor in [participant(1), facilitator(), Actor::Anonymous] {
        assert!(matches!(
            decide_session(&active()?, &save(actor, Role::Retailer, 1, 8, 0)?),
            Err(SessionError::Forbidden(_))
        ));
    }
    Ok(())
}

#[test]
fn ac2_2_2__古い週への保存は_WeekAdvanced() -> R<()> {
    assert_eq!(
        decide_session(&active()?, &save(participant(4), Role::Retailer, 2, 8, 0)?),
        Err(SessionError::WeekAdvanced {
            requested: week(2)?,
            current: week(1)?
        })
    );
    Ok(())
}

#[test]
fn ac2_2_2__期待する版が現在と違えば_DecisionConflict_で最新の入力を返す() -> R<()> {
    let state = session_of(&[session_started()?, saved(Role::Retailer, 1, 8, 1, 4, 1)?])?;
    let result = decide_session(&state, &save(participant(4), Role::Retailer, 1, 9, 0)?);
    let Err(SessionError::DecisionConflict { role, latest }) = result else {
        return Err(format!("DecisionConflict ではない: {result:?}"));
    };
    assert_eq!(role, Role::Retailer);
    assert_eq!(latest.map(|e| e.version), Some(version(1)));
    Ok(())
}

#[test]
fn ac2_2_2__保存は上限の回数まで_その次は_SaveLimitReached() -> R<()> {
    let mut events = vec![session_started()?];
    for v in 1..=SAVE_LIMIT_PER_ROLE_WEEK {
        events.push(saved(Role::Retailer, 1, 4, v, 4, 1)?);
    }
    let state = session_of(&events)?;
    assert_eq!(
        decide_session(
            &state,
            &save(
                participant(4),
                Role::Retailer,
                1,
                5,
                SAVE_LIMIT_PER_ROLE_WEEK
            )?
        ),
        Err(SessionError::SaveLimitReached)
    );
    Ok(())
}

#[test]
fn ac2_2_1__開始前は_NotActive_終了後は_AlreadyEnded() -> R<()> {
    assert_eq!(
        decide_session(
            &SessionState::NotStarted,
            &save(participant(4), Role::Retailer, 1, 8, 0)?
        ),
        Err(SessionError::NotActive)
    );
    let mut events = vec![session_started()?];
    for week_n in 1..=3 {
        events.extend(all_saved(week_n, 4)?);
        events.extend(commit_events(&session_of(&events)?, week_n)?);
    }
    let ended = session_of(&events)?;
    assert!(matches!(ended, SessionState::Ended(_)));
    assert_eq!(
        decide_session(&ended, &save(participant(4), Role::Retailer, 3, 8, 0)?),
        Err(SessionError::AlreadyEnded)
    );
    Ok(())
}

/// 手動の確定を decide して得たイベント。
fn commit_events(state: &SessionState, week_n: i64) -> R<Vec<SessionEvent>> {
    decide_session(state, &commit(week_n, 1)?).map_err(err)
}

#[test]
fn ac2_3_1__4役割の入力がそろえば進行役は週を確定できる() -> R<()> {
    let mut events = vec![session_started()?];
    events.extend(all_saved(1, 4)?);
    let state = session_of(&events)?;
    let committed = commit_events(&state, 1)?;
    let [
        SessionEvent::WeekCommitted {
            week: w,
            commit_kind,
            decisions,
            contributors,
            ..
        },
    ] = committed.as_slice()
    else {
        return Err(format!("WeekCommitted の 1 件ではない: {committed:?}"));
    };
    assert_eq!(*w, week(1)?);
    assert_eq!(*commit_kind, CommitKind::Manual);
    assert_eq!(decisions.retailer, quantity(4)?);
    assert_eq!(*contributors, 4);
    Ok(())
}

#[test]
fn ac2_3_1__確定は進行役だけができる() -> R<()> {
    let mut events = vec![session_started()?];
    events.extend(all_saved(1, 4)?);
    let state = session_of(&events)?;
    for actor in [participant(4), Actor::Anonymous] {
        let command = SessionCommand::CommitWeek {
            actor,
            at: at(),
            requested_week: week(1)?,
            basis: RoleMap::all(&version(1)),
        };
        assert!(matches!(
            decide_session(&state, &command),
            Err(SessionError::Forbidden(_))
        ));
    }
    Ok(())
}

#[test]
fn ac2_3_2__入力がそろっていなければ_不足を示して拒否する() -> R<()> {
    let state = session_of(&[session_started()?, saved(Role::Retailer, 1, 8, 1, 4, 1)?])?;
    let command = SessionCommand::CommitWeek {
        actor: facilitator(),
        at: at(),
        requested_week: week(1)?,
        basis: RoleMap {
            factory: version(0),
            distributor: version(0),
            wholesaler: version(0),
            retailer: version(1),
        },
    };
    assert_eq!(
        decide_session(&state, &command),
        Err(SessionError::IncompleteDecisions {
            missing: vec![Role::Factory, Role::Distributor, Role::Wholesaler]
        })
    );
    Ok(())
}

#[test]
fn ac2_3_2__週が違えば_WeekAdvanced_根拠の版が違えば_DecisionsChanged_の順に判定する() -> R<()> {
    let mut events = vec![session_started()?];
    events.extend(all_saved(1, 4)?);
    let state = session_of(&events)?;
    // 週も版も違う場合は、週の判定が先
    let both_wrong = SessionCommand::CommitWeek {
        actor: facilitator(),
        at: at(),
        requested_week: week(2)?,
        basis: RoleMap::all(&version(0)),
    };
    assert!(matches!(
        decide_session(&state, &both_wrong),
        Err(SessionError::WeekAdvanced { .. })
    ));
    let stale_basis = commit(1, 0)?;
    assert!(matches!(
        decide_session(&state, &stale_basis),
        Err(SessionError::DecisionsChanged { .. })
    ));
    Ok(())
}

#[test]
fn ac2_3_3__確定すると次の週に進み_入力と版が空に戻る() -> R<()> {
    let mut events = vec![session_started()?];
    events.extend(all_saved(1, 4)?);
    events.extend(commit_events(&session_of(&events)?, 1)?);
    let SessionState::Active(data) = session_of(&events)? else {
        return Err("進行中ではない".to_owned());
    };
    assert_eq!(data.week, week(2)?);
    assert!(data.decisions.is_empty());
    assert_eq!(data.decision_versions, RoleMap::all(&version(0)));
    Ok(())
}

#[test]
fn ac2_3_3__同じ週を二度確定することはできない() -> R<()> {
    let mut events = vec![session_started()?];
    events.extend(all_saved(1, 4)?);
    events.extend(commit_events(&session_of(&events)?, 1)?);
    // 第 2 週に進んだ後の、第 1 週の確定の再送
    assert!(matches!(
        decide_session(&session_of(&events)?, &commit(1, 1)?),
        Err(SessionError::WeekAdvanced { .. })
    ));
    Ok(())
}

#[test]
fn ac2_3_4__最終週の確定は_WeekCommitted_と_SessionEnded_を同時に返す() -> R<()> {
    let mut events = vec![session_started()?];
    for week_n in 1..=2 {
        events.extend(all_saved(week_n, 4)?);
        events.extend(commit_events(&session_of(&events)?, week_n)?);
    }
    events.extend(all_saved(3, 4)?);
    let committed = commit_events(&session_of(&events)?, 3)?;
    assert!(matches!(
        committed.as_slice(),
        [
            SessionEvent::WeekCommitted { .. },
            SessionEvent::SessionEnded {
                reason: EndReason::FinalWeek
            }
        ]
    ));
    Ok(())
}

#[test]
fn ac2_3_4__同じ入力から同じ確定のイベントを返す_決定論() -> R<()> {
    let mut events = vec![session_started()?];
    events.extend(all_saved(1, 4)?);
    let state = session_of(&events)?;
    assert_eq!(commit_events(&state, 1)?, commit_events(&state, 1)?);
    Ok(())
}

#[test]
fn ac2_3_5__確定のイベントは役割別の週結果と次週の状態を持つ() -> R<()> {
    let mut events = vec![session_started()?];
    events.extend(all_saved(1, 4)?);
    let committed = commit_events(&session_of(&events)?, 1)?;
    let [
        SessionEvent::WeekCommitted {
            results,
            next_states,
            ..
        },
    ] = committed.as_slice()
    else {
        return Err("WeekCommitted の 1 件ではない".to_owned());
    };
    // 定常状態（需要 4・発注 4）: 全役割が出荷 4・在庫 12・週次費用 600
    assert_eq!(results.retailer.shipped.get(), 4);
    assert_eq!(results.retailer.ending_inventory.get(), 12);
    assert_eq!(results.retailer.weekly_cost.minor(), 600);
    assert_eq!(next_states.retailer.cumulative_cost.minor(), 600);
    Ok(())
}

#[test]
fn evolve__decide_が作らない列は_Ignored_で状態が変わらない() -> R<()> {
    let started = session_started()?;
    // 開始前の保存と確定、開始済みへの再開始、終了前の SessionEnded
    let committed = SessionEvent::SessionEnded {
        reason: EndReason::FinalWeek,
    };
    assert!(
        evolve_session(
            SessionState::NotStarted,
            &saved(Role::Retailer, 1, 4, 1, 4, 1)?
        )
        .is_ignored()
    );
    assert!(evolve_session(SessionState::NotStarted, &committed).is_ignored());
    assert!(evolve_session(active()?, &started).is_ignored());
    Ok(())
}

#[test]
fn replay__decide_が作らない列の位置を返す() -> R<()> {
    let (_, ignored) = replay_session(&[
        saved(Role::Retailer, 1, 4, 1, 4, 1)?,
        session_started()?,
        session_started()?,
    ]);
    assert_eq!(ignored, vec![0, 2]);
    Ok(())
}

#[test]
fn エラーの_code_と_category_は_API_の契約として固定される() -> R<()> {
    let cases = [
        (
            SessionError::NotActive,
            "session.not_active",
            ErrorCategory::InvalidState,
        ),
        (
            SessionError::AlreadyEnded,
            "session.already_ended",
            ErrorCategory::InvalidState,
        ),
        (
            SessionError::AlreadyStarted,
            "session.already_started",
            ErrorCategory::InvalidState,
        ),
        (
            SessionError::SaveLimitReached,
            "session.save_limit_reached",
            ErrorCategory::InvalidState,
        ),
        (
            SessionError::Forbidden("x"),
            "session.forbidden",
            ErrorCategory::Forbidden,
        ),
        (
            SessionError::WeekAdvanced {
                requested: week(2)?,
                current: week(1)?,
            },
            "session.week_advanced",
            ErrorCategory::Conflict,
        ),
        (
            SessionError::DecisionConflict {
                role: Role::Retailer,
                latest: None,
            },
            "session.decision_conflict",
            ErrorCategory::Conflict,
        ),
        (
            SessionError::DecisionsChanged {
                week: week(1)?,
                current: std::collections::BTreeMap::new(),
            },
            "session.decisions_changed",
            ErrorCategory::Conflict,
        ),
        (
            SessionError::IncompleteDecisions { missing: vec![] },
            "session.incomplete_decisions",
            ErrorCategory::RuleViolation,
        ),
    ];
    for (error, code, category) in cases {
        assert_eq!(error.code(), code);
        assert_eq!(error.category(), category);
    }
    Ok(())
}
