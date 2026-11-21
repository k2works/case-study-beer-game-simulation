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
