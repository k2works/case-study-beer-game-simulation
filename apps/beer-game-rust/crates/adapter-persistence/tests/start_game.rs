// 理由: RT1 の命名（承認済み）の `__` を使うため。
#![allow(non_snake_case)]

//! `execute_start` を実 PostgreSQL で（`game` と `session` の 2 本へ 1 トランザクション。AC1.2.3）。

use beergame_adapter_persistence::PgGameStore;
use beergame_application::{AppFailure, EventStore, StartExecuted, execute_start};
use beergame_domain::{
    Actor, CommitMode, GameEvent, GameId, GameSettings, Instant, JoinCode, ParticipantId,
    RetentionDays, Role, SessionEvent, StartGame,
};
use uuid::Uuid;

mod support;
use support::{new_game, start};

fn e<T: std::fmt::Debug>(x: T) -> String {
    format!("{x:?}")
}

fn events(game: GameId) -> Result<Vec<GameEvent>, String> {
    let expires = Instant::from_epoch_millis(9);
    let mut events = vec![GameEvent::GameCreated {
        game_id: game,
        join_code: JoinCode::of("abcd1234").map_err(e)?,
        settings: GameSettings::kit(2, &[4, 4], CommitMode::Manual).map_err(e)?,
        retention_days: RetentionDays::of(30).map_err(e)?,
        facilitator_credential_expires_at: expires,
    }];
    for (i, role) in Role::ALL.iter().enumerate() {
        let id = ParticipantId::new(u128::try_from(i + 1).map_err(e)?);
        events.push(GameEvent::ParticipantJoined {
            participant_id: id,
            credential_expires_at: expires,
        });
        events.push(GameEvent::RoleAssigned {
            participant_id: id,
            role: *role,
        });
    }
    Ok(events)
}

#[tokio::test]
async fn ac1_2_3__開始は_game_と_session_の両方へ追記され_読み直せる() -> Result<(), String> {
    let Some(env) = start().await? else {
        return Ok(());
    };
    let game: Uuid = new_game(&env.pool).await?;
    let id = GameId::new(game.as_u128());
    let store = PgGameStore::new(env.pool.clone(), game);
    // 準備中のゲームを 1 つのトランザクションで作る
    let mut tx = EventStore::<GameEvent>::begin(&store).await.map_err(e)?;
    let prepared = events(id)?;
    let n = u64::try_from(prepared.len()).map_err(e)?;
    assert_eq!(
        EventStore::<GameEvent>::append(&store, &mut tx, 0, prepared).await,
        Ok(n)
    );
    EventStore::<GameEvent>::commit(&store, tx)
        .await
        .map_err(e)?;

    let command = StartGame {
        actor: Actor::Facilitator(id),
        at: Instant::from_epoch_millis(1),
    };
    assert_eq!(
        execute_start(&store, &command, 3, None).await,
        Ok(StartExecuted::Fresh(n + 1, 1))
    );

    let mut tx = EventStore::<GameEvent>::begin(&store).await.map_err(e)?;
    let games = EventStore::<GameEvent>::read(&store, &mut tx)
        .await
        .map_err(e)?;
    let sessions = EventStore::<SessionEvent>::read(&store, &mut tx)
        .await
        .map_err(e)?;
    EventStore::<GameEvent>::rollback(&store, tx)
        .await
        .map_err(e)?;
    assert_eq!(games.version, n + 1);
    assert!(matches!(
        games.events.last(),
        Some(GameEvent::GameStarted { .. })
    ));
    assert!(matches!(
        sessions.events.as_slice(),
        [SessionEvent::SessionStarted { .. }]
    ));
    Ok(())
}

#[tokio::test]
async fn ac1_2_3__同時の開始は一方だけが成功し_開始のイベントは_1_回だけ() -> Result<(), String> {
    let Some(env) = start().await? else {
        return Ok(());
    };
    let game: Uuid = new_game(&env.pool).await?;
    let id = GameId::new(game.as_u128());
    let store = PgGameStore::new(env.pool.clone(), game);
    let mut tx = EventStore::<GameEvent>::begin(&store).await.map_err(e)?;
    let prepared = events(id)?;
    let n = u64::try_from(prepared.len()).map_err(e)?;
    EventStore::<GameEvent>::append(&store, &mut tx, 0, prepared)
        .await
        .map_err(e)?;
    EventStore::<GameEvent>::commit(&store, tx)
        .await
        .map_err(e)?;
    let command = StartGame {
        actor: Actor::Facilitator(id),
        at: Instant::from_epoch_millis(1),
    };
    // 2 つの開始を同時に実行し、一方だけが成功する
    let (a, b) = tokio::join!(
        execute_start(&store, &command, 5, None),
        execute_start(&store, &command, 5, None)
    );
    let results = [a, b];
    let ok = results.iter().filter(|r| r.is_ok()).count();
    if ok != 1 {
        return Err(format!("一方だけが成功するはず: {results:?}"));
    }
    assert!(
        results
            .iter()
            .any(|r| matches!(r, Err(AppFailure::Domain(_))))
    );
    let started: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM events WHERE game_id = $1 AND event_type IN ('GameStarted', 'SessionStarted')",
    )
    .bind(game)
    .fetch_one(&env.pool)
    .await
    .map_err(e)?;
    assert_eq!(
        started, 2,
        "開始は 1 回だけ（GameStarted と SessionStarted が 1 件ずつ）"
    );
    assert_eq!(
        n + 1,
        u64::try_from(
            sqlx::query_scalar::<_, i64>(
                "SELECT count(*) FROM events WHERE game_id = $1 AND stream_type = 'GAME'"
            )
            .bind(game)
            .fetch_one(&env.pool)
            .await
            .map_err(e)?
        )
        .map_err(e)?
    );
    Ok(())
}
