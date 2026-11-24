//! 性質テスト（DS-5）: decide が返したイベントは、evolve が必ず採用する（Ignored にならない）。
//! `evolve` の腕を無効にすると、この性質が落ちる。

use crate::fixtures::*;
use beergame_domain::{
    Actor, GameState, Role, SessionCommand, SessionState, decide_game, decide_session, evolve_game,
    evolve_session,
};
use proptest::prelude::*;

#[derive(Clone, Debug)]
enum GameStep {
    Join(u8),
    Assign(u8, u8),
}

fn game_step() -> impl Strategy<Value = GameStep> {
    prop_oneof![
        (1u8..=6).prop_map(GameStep::Join),
        ((1u8..=6), (0u8..4)).prop_map(|(n, r)| GameStep::Assign(n, r)),
    ]
}

fn role_of(n: u8) -> Role {
    Role::ALL
        .get(usize::from(n))
        .copied()
        .unwrap_or(Role::Retailer)
}

proptest! {
    /// 任意の参加・割り当ての列で、decide が返したイベントは evolve が必ず採用する。
    #[test]
    fn evolve__decide_が返したゲームのイベントは必ず採用される(
        steps in prop::collection::vec(game_step(), 0..30),
    ) {
        let created = decide_game(&GameState::NotCreated, &create_game(Actor::Anonymous).map_err(TestCaseError::fail)?)
            .map_err(|e| TestCaseError::fail(format!("{e:?}")))?;
        let mut state = GameState::NotCreated;
        for event in &created {
            let next = evolve_game(state, event);
            prop_assert!(!next.is_ignored());
            state = next.into_state();
        }
        for step in steps {
            let command = match step {
                GameStep::Join(n) => join_game(u128::from(n)).map_err(TestCaseError::fail)?,
                GameStep::Assign(n, r) => assign_role(facilitator(), u128::from(n), role_of(r)),
            };
            // 規則違反（未参加への割り当てなど）は拒否されるだけ。通ったイベントは必ず採用される
            if let Ok(events) = decide_game(&state, &command) {
                for event in &events {
                    let next = evolve_game(state, event);
                    prop_assert!(!next.is_ignored(), "{event:?}");
                    state = next.into_state();
                }
            }
        }
    }

    /// 任意の入力の列で、decide が返した session のイベントは evolve が必ず採用する。
    #[test]
    fn evolve__decide_が返した進行のイベントは必ず採用される(
        saves in prop::collection::vec(((0u8..4), 0i64..=1000, 0u32..=10), 0..40),
        commits in prop::collection::vec(1i64..=3, 0..10),
    ) {
        let mut state = SessionState::NotStarted;
        let started = session_started().map_err(TestCaseError::fail)?;
        let next = evolve_session(state, &started);
        prop_assert!(!next.is_ignored());
        state = next.into_state();
        let mut commands: Vec<SessionCommand> = Vec::new();
        for (r, q, v) in saves {
            let role = role_of(r);
            let owner = match role {
                Role::Factory => 1,
                Role::Distributor => 2,
                Role::Wholesaler => 3,
                Role::Retailer => 4,
            };
            commands.push(SessionCommand::SaveDecision {
                actor: participant(owner),
                at: at(),
                role,
                requested_week: week(1).map_err(TestCaseError::fail)?,
                quantity: quantity(q).map_err(TestCaseError::fail)?,
                expected_decision_version: version(v),
            });
        }
        for w in commits {
            commands.push(SessionCommand::CommitWeek {
                actor: facilitator(),
                at: at(),
                requested_week: week(w).map_err(TestCaseError::fail)?,
                basis: beergame_domain::RoleMap::all(&version(0)),
            });
        }
        for command in &commands {
            if let Ok(events) = decide_session(&state, command) {
                for event in &events {
                    let next = evolve_session(state, event);
                    prop_assert!(!next.is_ignored(), "{event:?}");
                    state = next.into_state();
                }
            }
        }
    }
}
