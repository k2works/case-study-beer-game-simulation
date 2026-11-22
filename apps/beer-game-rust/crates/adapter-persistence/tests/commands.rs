// 理由: RT1 の命名（承認済み）の `__` を使うため。
#![allow(non_snake_case)]

//! ユースケースを実 PostgreSQL で。作成・参加・割り当てが、イベント・投影・周辺ストアを 1 つのトランザクションで更新する。

use beergame_adapter_persistence::PgGameStore;
use beergame_application::{
    AppSettings, CreateGameInput, Env, Secret, assign_role, create_game, join_game,
};
use beergame_domain::{Actor, GameId, Instant, Role};
use uuid::Uuid;

mod support;
use support::start;

fn e<T: std::fmt::Debug>(x: T) -> String {
    format!("{x:?}")
}

struct RealEnv;

impl Env for RealEnv {
    fn now(&self) -> Instant {
        Instant::from_epoch_millis(1_700_000_000_000)
    }
    fn new_id(&self) -> u128 {
        Uuid::new_v4().as_u128()
    }
    fn token_bytes(&self) -> [u8; 32] {
        let mut bytes = [0_u8; 32];
        bytes[..16].copy_from_slice(Uuid::new_v4().as_bytes());
        bytes[16..].copy_from_slice(Uuid::new_v4().as_bytes());
        bytes
    }
    fn join_code(&self) -> String {
        Uuid::new_v4().simple().to_string()[..10].to_owned()
    }
}

fn settings() -> AppSettings {
    AppSettings {
        credential_key: Secret::new(vec![9; 32]),
        key_version: 1,
        credential_ttl_millis: 86_400_000,
        retention_days: 90,
        max_attempts: 3,
        retired_keys: Vec::new(),
        session_ttl_millis: 86_400_000,
        max_failed_attempts: 10,
        attempt_window_millis: 600_000,
    }
}

#[tokio::test]
async fn ac1_1_1__作成と参加と割り当てが_イベント_投影_周辺ストアを一緒に更新する()
-> Result<(), String> {
    let Some(env) = start().await? else {
        return Ok(());
    };
    let input = CreateGameInput {
        final_week: 3,
        demand: vec![4, 4, 4],
        ..CreateGameInput::default()
    };
    // 作成: ゲームの ID は作成時に決まるので、ストアは ID ごとに作る。まず ID を知るため、作成だけ専用の ID でストアを作る
    // （PgGameStore はゲームの ID を持つので、Env が返す ID と同じ値でストアを作る）
    struct OneId(u128);
    impl Env for OneId {
        fn now(&self) -> Instant {
            RealEnv.now()
        }
        fn new_id(&self) -> u128 {
            self.0
        }
        fn token_bytes(&self) -> [u8; 32] {
            RealEnv.token_bytes()
        }
        fn join_code(&self) -> String {
            RealEnv.join_code()
        }
    }
    let game_uuid = Uuid::new_v4();
    let store = PgGameStore::new(env.pool.clone(), game_uuid);
    let one = OneId(game_uuid.as_u128());
    let created = create_game(
        &store,
        &one,
        &settings(),
        GameId::new(game_uuid.as_u128()),
        &input,
        None,
    )
    .await
    .map_err(e)?;
    assert_eq!(created.game_id, GameId::new(game_uuid.as_u128()));

    let joined = join_game(&store, &RealEnv, &settings(), created.game_id, "山本", None)
        .await
        .map_err(e)?;
    assign_role(
        &store,
        &RealEnv,
        &settings(),
        Actor::Facilitator(created.game_id),
        joined.participant_id,
        Role::Retailer,
        None,
    )
    .await
    .map_err(e)?;

    let (status, code): (String, String) = sqlx::query_as(
        "SELECT o.status, c.join_code FROM game_overview o JOIN game_join_codes c USING (game_id) WHERE game_id = $1",
    ).bind(game_uuid).fetch_one(&env.pool).await.map_err(e)?;
    assert_eq!(status, "PREPARING");
    assert_eq!(code, created.join_code);
    let role: Option<String> =
        sqlx::query_scalar("SELECT role FROM lobby_participants WHERE participant_id = $1")
            .bind(Uuid::from_u128(joined.participant_id.get()))
            .fetch_one(&env.pool)
            .await
            .map_err(e)?;
    assert_eq!(role.as_deref(), Some("RETAILER"));
    let name: String =
        sqlx::query_scalar("SELECT display_name FROM display_profiles WHERE game_id = $1")
            .bind(game_uuid)
            .fetch_one(&env.pool)
            .await
            .map_err(e)?;
    assert_eq!(name, "山本");
    let digests: Vec<(String, String)> = sqlx::query_as(
        "SELECT kind, credential_digest FROM credentials WHERE game_id = $1 ORDER BY kind",
    )
    .bind(game_uuid)
    .fetch_all(&env.pool)
    .await
    .map_err(e)?;
    assert_eq!(
        digests.iter().map(|(k, _)| k.as_str()).collect::<Vec<_>>(),
        vec!["FACILITATOR", "PARTICIPANT"]
    );
    for (_, digest) in &digests {
        assert_eq!(digest.len(), 64);
        assert!(!digest.contains(created.facilitator_credential.expose().as_str()));
        assert!(!digest.contains(joined.credential.expose().as_str()));
    }
    // 表示名・資格の値は、イベントに入らない
    let leaked: i64 = sqlx::query_scalar("SELECT count(*) FROM events WHERE game_id = $1 AND (payload::text LIKE '%山本%' OR payload::text LIKE '%' || $2 || '%')")
        .bind(game_uuid).bind(created.facilitator_credential.expose()).fetch_one(&env.pool).await.map_err(e)?;
    assert_eq!(leaked, 0);
    Ok(())
}

#[tokio::test]
async fn ac1_2_2__存在しないゲームへの参加は拒否され_何も残らない() -> Result<(), String> {
    let Some(env) = start().await? else {
        return Ok(());
    };
    let ghost = Uuid::new_v4();
    let store = PgGameStore::new(env.pool.clone(), ghost);
    let result = join_game(
        &store,
        &RealEnv,
        &settings(),
        GameId::new(ghost.as_u128()),
        "山本",
        None,
    )
    .await;
    assert!(result.is_err());
    let rows: i64 = sqlx::query_scalar("SELECT (SELECT count(*) FROM game_roots) + (SELECT count(*) FROM credentials) + (SELECT count(*) FROM display_profiles)")
        .fetch_one(&env.pool).await.map_err(e)?;
    assert_eq!(rows, 0);
    Ok(())
}

/// 指定の時刻・ゲーム ID を返す環境。
struct Fixed {
    now: i64,
    game: u128,
}

impl Env for Fixed {
    fn now(&self) -> Instant {
        Instant::from_epoch_millis(self.now)
    }
    fn new_id(&self) -> u128 {
        if self.game == 0 {
            Uuid::new_v4().as_u128()
        } else {
            self.game
        }
    }
    fn token_bytes(&self) -> [u8; 32] {
        RealEnv.token_bytes()
    }
    fn join_code(&self) -> String {
        RealEnv.join_code()
    }
}

#[tokio::test]
async fn ac2_3_1__認証した操作者で_開始から入力と確定まで通る_資格の期限と失効も効く()
-> Result<(), String> {
    use beergame_application::{AppFailure, authenticate, commit_week, save_decision, start_game};
    use beergame_domain::{DecisionVersion, Quantity, RoleMap, Week};

    let Some(env) = start().await? else {
        return Ok(());
    };
    let game_uuid = Uuid::new_v4();
    let store = PgGameStore::new(env.pool.clone(), game_uuid);
    let now = 1_700_000_000_000;
    let at = Fixed {
        now,
        game: game_uuid.as_u128(),
    };
    let created = create_game(
        &store,
        &at,
        &settings(),
        GameId::new(game_uuid.as_u128()),
        &CreateGameInput {
            final_week: 2,
            demand: vec![4, 4],
            ..CreateGameInput::default()
        },
        None,
    )
    .await
    .map_err(e)?;
    let (_, facilitator) = authenticate(&store, &at, &settings(), &created.facilitator_credential)
        .await
        .map_err(e)?;
    assert_eq!(facilitator, Actor::Facilitator(created.game_id));

    let mut participants = Vec::new();
    for role in Role::ALL {
        let joined = join_game(
            &store,
            &Fixed { now, game: 0 },
            &settings(),
            created.game_id,
            "参加者",
            None,
        )
        .await
        .map_err(e)?;
        assign_role(
            &store,
            &at,
            &settings(),
            facilitator,
            joined.participant_id,
            role,
            None,
        )
        .await
        .map_err(e)?;
        participants.push((role, joined));
    }
    start_game(&store, &at, &settings(), facilitator, None)
        .await
        .map_err(e)?;

    for (role, joined) in &participants {
        let (_, actor) = authenticate(&store, &at, &settings(), &joined.credential)
            .await
            .map_err(e)?;
        save_decision(
            &store,
            &at,
            &settings(),
            actor,
            *role,
            Week::FIRST,
            Quantity::of(5).map_err(e)?,
            DecisionVersion::ZERO,
            None,
        )
        .await
        .map_err(e)?;
    }
    commit_week(
        &store,
        &at,
        &settings(),
        facilitator,
        Week::FIRST,
        RoleMap::all(&DecisionVersion::new(1)),
        None,
    )
    .await
    .map_err(e)?;
    let week: i32 = sqlx::query_scalar("SELECT week FROM session_overview WHERE game_id = $1")
        .bind(game_uuid)
        .fetch_one(&env.pool)
        .await
        .map_err(e)?;
    assert_eq!(week, 2);

    // 認証: 不明な資格・期限切れ・失効は、区別せず Unauthorized
    let unknown = Secret::new("x".repeat(43));
    assert_eq!(
        authenticate(&store, &at, &settings(), &unknown).await.err(),
        Some(AppFailure::Unauthorized)
    );
    let later = Fixed {
        now: now + 86_400_001,
        game: game_uuid.as_u128(),
    };
    assert_eq!(
        authenticate(&store, &later, &settings(), &created.facilitator_credential)
            .await
            .err(),
        Some(AppFailure::Unauthorized)
    );
    sqlx::query(
        "UPDATE credentials SET revoked_at = now() WHERE game_id = $1 AND kind = 'FACILITATOR'",
    )
    .bind(game_uuid)
    .execute(&env.pool)
    .await
    .map_err(e)?;
    assert_eq!(
        authenticate(&store, &at, &settings(), &created.facilitator_credential)
            .await
            .err(),
        Some(AppFailure::Unauthorized)
    );
    // 別の参加者は、進行役の操作（確定）ができない
    let (_, actor) = authenticate(&store, &at, &settings(), &participants[0].1.credential)
        .await
        .map_err(e)?;
    let result = commit_week(
        &store,
        &at,
        &settings(),
        actor,
        Week::of(2).map_err(e)?,
        RoleMap::all(&DecisionVersion::ZERO),
        None,
    )
    .await;
    assert!(matches!(result.err(), Some(AppFailure::Domain(_))));
    Ok(())
}
