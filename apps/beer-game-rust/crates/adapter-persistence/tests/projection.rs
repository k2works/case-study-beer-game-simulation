// 理由: RT1 の命名（承認済み）の `__` を使うため。
#![allow(non_snake_case)]

//! 同期投影（準備）。追記と同じトランザクションで、`game_overview`・`game_join_codes`・`game_settings`・`lobby_participants` が更新される。

use beergame_adapter_persistence::{PgGameStore, game_statements};
use beergame_application::{EventStore, execute_start};
use beergame_domain::{
    Actor, CommitMode, GameEvent, GameId, GameSettings, Instant, JoinCode, ParticipantId,
    RetentionDays, Role, StartGame,
};
use uuid::Uuid;

mod support;
use support::{new_game, start};

fn e<T: std::fmt::Debug>(x: T) -> String {
    format!("{x:?}")
}

fn created(id: GameId) -> Result<GameEvent, String> {
    Ok(GameEvent::GameCreated {
        game_id: id,
        join_code: JoinCode::of("abcd1234").map_err(e)?,
        settings: GameSettings::kit(2, &[4, 8], CommitMode::Manual).map_err(e)?,
        retention_days: RetentionDays::of(30).map_err(e)?,
        facilitator_credential_expires_at: Instant::from_epoch_millis(9),
    })
}

#[test]
fn 投影は純粋_同じイベントから同じ文を導く() -> Result<(), String> {
    let id = GameId::new(7);
    let game = Uuid::from_u128(7);
    let event = created(id)?;
    assert_eq!(game_statements(game, &event), game_statements(game, &event));
    assert_eq!(game_statements(game, &event).len(), 3);
    Ok(())
}

#[tokio::test]
async fn ac1_2_1__投影の表は追記と同じトランザクションで更新される() -> Result<(), String> {
    let Some(env) = start().await? else {
        return Ok(());
    };
    let game: Uuid = new_game(&env.pool).await?;
    let id = GameId::new(game.as_u128());
    let store = PgGameStore::new(env.pool.clone(), game);
    let expires = Instant::from_epoch_millis(9);
    let mut events = vec![created(id)?];
    for (i, role) in Role::ALL.iter().enumerate() {
        let p = ParticipantId::new(u128::try_from(i + 1).map_err(e)?);
        events.push(GameEvent::ParticipantJoined {
            participant_id: p,
            credential_expires_at: expires,
        });
        events.push(GameEvent::RoleAssigned {
            participant_id: p,
            role: *role,
        });
    }
    // 付け替えと戻し
    let p4 = ParticipantId::new(4);
    events.push(GameEvent::RoleUnassigned {
        participant_id: p4,
        role: Role::Retailer,
    });

    // 追記してもコミットしなければ、投影の行も残らない（同じトランザクション）
    let mut tx = EventStore::<GameEvent>::begin(&store).await.map_err(e)?;
    EventStore::<GameEvent>::append(&store, &mut tx, 0, events.clone())
        .await
        .map_err(e)?;
    EventStore::<GameEvent>::rollback(&store, tx)
        .await
        .map_err(e)?;
    let rows: i64 = sqlx::query_scalar("SELECT count(*) FROM game_overview WHERE game_id = $1")
        .bind(game)
        .fetch_one(&env.pool)
        .await
        .map_err(e)?;
    assert_eq!(rows, 0, "rollback で投影も戻る");

    let mut tx = EventStore::<GameEvent>::begin(&store).await.map_err(e)?;
    EventStore::<GameEvent>::append(&store, &mut tx, 0, events)
        .await
        .map_err(e)?;
    EventStore::<GameEvent>::commit(&store, tx)
        .await
        .map_err(e)?;

    let (status, final_week, kind): (String, i32, String) = sqlx::query_as(
        "SELECT status, final_week, settings_kind FROM game_overview WHERE game_id = $1",
    )
    .bind(game)
    .fetch_one(&env.pool)
    .await
    .map_err(e)?;
    assert_eq!(
        (status.as_str(), final_week, kind.as_str()),
        ("PREPARING", 2, "KIT")
    );
    let code: String =
        sqlx::query_scalar("SELECT join_code FROM game_join_codes WHERE game_id = $1")
            .bind(game)
            .fetch_one(&env.pool)
            .await
            .map_err(e)?;
    assert_eq!(code, "abcd1234");
    let costs: (i32, i32) = sqlx::query_as(
        "SELECT holding_cost_minor, backlog_cost_minor FROM game_settings WHERE game_id = $1",
    )
    .bind(game)
    .fetch_one(&env.pool)
    .await
    .map_err(e)?;
    assert_eq!(costs, (50, 100));
    let roles: Vec<Option<String>> = sqlx::query_scalar(
        "SELECT role FROM lobby_participants WHERE game_id = $1 ORDER BY participant_id",
    )
    .bind(game)
    .fetch_all(&env.pool)
    .await
    .map_err(e)?;
    assert_eq!(
        roles,
        vec![
            Some("FACTORY".to_owned()),
            Some("DISTRIBUTOR".to_owned()),
            Some("WHOLESALER".to_owned()),
            None
        ]
    );

    // 開始で STARTED になる
    let command = StartGame {
        actor: Actor::Facilitator(id),
        at: Instant::from_epoch_millis(1),
    };
    // 小売店が空いたので、開始条件を満たすよう割り当て直す
    let mut tx = EventStore::<GameEvent>::begin(&store).await.map_err(e)?;
    EventStore::<GameEvent>::append(
        &store,
        &mut tx,
        10,
        vec![GameEvent::RoleAssigned {
            participant_id: p4,
            role: Role::Retailer,
        }],
    )
    .await
    .map_err(e)?;
    EventStore::<GameEvent>::commit(&store, tx)
        .await
        .map_err(e)?;
    execute_start(&store, &command, 3).await.map_err(e)?;
    let status: String = sqlx::query_scalar("SELECT status FROM game_overview WHERE game_id = $1")
        .bind(game)
        .fetch_one(&env.pool)
        .await
        .map_err(e)?;
    assert_eq!(status, "STARTED");
    Ok(())
}

fn decide(
    state: &beergame_domain::SessionState,
    command: &beergame_domain::SessionCommand,
) -> Result<Vec<beergame_domain::SessionEvent>, beergame_application::DomainError> {
    beergame_domain::decide_session(state, command)
        .map_err(beergame_application::DomainError::Session)
}

#[tokio::test]
async fn ac2_3_5__進行と結果の投影は_確定まで追記と同じトランザクションで更新される()
-> Result<(), String> {
    use beergame_application::execute;
    use beergame_domain::{
        DecisionVersion, Quantity, RoleMap, SessionCommand, SessionState, Week, evolve_session,
    };

    let Some(env) = start().await? else {
        return Ok(());
    };
    let game: Uuid = new_game(&env.pool).await?;
    let id = GameId::new(game.as_u128());
    let store = PgGameStore::new(env.pool.clone(), game);
    let expires = Instant::from_epoch_millis(9);
    let mut events = vec![created(id)?];
    for (i, role) in Role::ALL.iter().enumerate() {
        let p = ParticipantId::new(u128::try_from(i + 1).map_err(e)?);
        events.push(GameEvent::ParticipantJoined {
            participant_id: p,
            credential_expires_at: expires,
        });
        events.push(GameEvent::RoleAssigned {
            participant_id: p,
            role: *role,
        });
    }
    let mut tx = EventStore::<GameEvent>::begin(&store).await.map_err(e)?;
    EventStore::<GameEvent>::append(&store, &mut tx, 0, events)
        .await
        .map_err(e)?;
    EventStore::<GameEvent>::commit(&store, tx)
        .await
        .map_err(e)?;
    execute_start(
        &store,
        &StartGame {
            actor: Actor::Facilitator(id),
            at: expires,
        },
        3,
    )
    .await
    .map_err(e)?;

    let (week, status, submitted): (i32, String, i32) = sqlx::query_as(
        "SELECT week, status, submitted_role_count FROM session_overview WHERE game_id = $1",
    )
    .bind(game)
    .fetch_one(&env.pool)
    .await
    .map_err(e)?;
    assert_eq!((week, status.as_str(), submitted), (1, "ACTIVE", 0));
    let states: i64 =
        sqlx::query_scalar("SELECT count(*) FROM role_current_states WHERE game_id = $1")
            .bind(game)
            .fetch_one(&env.pool)
            .await
            .map_err(e)?;
    assert_eq!(states, 4);

    for (n, role) in Role::ALL.iter().enumerate() {
        let command = SessionCommand::SaveDecision {
            actor: Actor::Participant(ParticipantId::new(u128::try_from(n + 1).map_err(e)?)),
            at: expires,
            role: *role,
            requested_week: Week::FIRST,
            quantity: Quantity::of(6).map_err(e)?,
            expected_decision_version: DecisionVersion::ZERO,
        };
        execute(
            &store,
            &SessionState::NotStarted,
            &evolve_session,
            &decide,
            &command,
            3,
        )
        .await
        .map_err(e)?;
    }
    let (submitted, decisions): (i32, i64) = sqlx::query_as(
        "SELECT (SELECT submitted_role_count FROM session_overview WHERE game_id = $1), (SELECT count(*) FROM current_decisions WHERE game_id = $1)",
    ).bind(game).fetch_one(&env.pool).await.map_err(e)?;
    assert_eq!((submitted, decisions), (4, 4));

    let commit = SessionCommand::CommitWeek {
        actor: Actor::Facilitator(id),
        at: expires,
        requested_week: Week::FIRST,
        basis: RoleMap::all(&DecisionVersion::new(1)),
    };
    execute(
        &store,
        &SessionState::NotStarted,
        &evolve_session,
        &decide,
        &commit,
        3,
    )
    .await
    .map_err(e)?;

    let (week, submitted): (i32, i32) = sqlx::query_as(
        "SELECT week, submitted_role_count FROM session_overview WHERE game_id = $1",
    )
    .bind(game)
    .fetch_one(&env.pool)
    .await
    .map_err(e)?;
    assert_eq!((week, submitted), (2, 0), "確定で週が進み、入力は空に戻る");
    let current: i64 =
        sqlx::query_scalar("SELECT count(*) FROM current_decisions WHERE game_id = $1")
            .bind(game)
            .fetch_one(&env.pool)
            .await
            .map_err(e)?;
    assert_eq!(current, 0);
    let results: Vec<(String, i32, i32)> = sqlx::query_as("SELECT role, ordered, ending_inventory FROM week_role_results WHERE game_id = $1 AND week = 1 ORDER BY role")
        .bind(game).fetch_all(&env.pool).await.map_err(e)?;
    assert_eq!(results.len(), 4);
    assert!(results.iter().all(|(_, ordered, _)| *ordered == 6));
    let (as_of, version): (i32, i64) = sqlx::query_as(
        "SELECT (SELECT as_of_week FROM role_current_states WHERE game_id = $1 AND role = 'RETAILER'), \
         (SELECT stream_version FROM week_commits WHERE game_id = $1 AND week = 1)",
    ).bind(game).fetch_one(&env.pool).await.map_err(e)?;
    assert_eq!(as_of, 2);
    assert_eq!(version, 6, "SessionStarted(1) + 4 保存 + WeekCommitted(6)");
    Ok(())
}
