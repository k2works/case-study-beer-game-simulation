// 理由: RT1 の命名（承認済み）の `__` を使うため。
#![allow(non_snake_case)]

//! 保持と削除（AC5.1.1・AC5.1.4・AC5.1.5）。保持状態の開示、削除の完了後に `game_id` を持つ全表へ行が残らないこと。実 PostgreSQL 18.6。

use axum::http::StatusCode;
use beergame_adapter_persistence::PgRetentionStore;
use beergame_application::{AppSettings, Env, Secret, run_retention};
use beergame_domain::{GameId, Instant};
use serde_json::{Value, json};

mod support;
use support::api::{app, e, prepared, prepared_with, send};
use support::start;

const DAY: i64 = 86_400_000;

/// 実時間から `offset` 進めた時計（ID や乱数は削除の処理では使わない）。
struct ShiftedEnv(i64);

impl Env for ShiftedEnv {
    fn now(&self) -> Instant {
        let real = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(0));
        Instant::from_epoch_millis(real + self.0)
    }

    fn new_id(&self) -> u128 {
        0
    }

    fn token_bytes(&self) -> [u8; 32] {
        [0; 32]
    }

    fn join_code(&self) -> String {
        String::new()
    }
}

fn settings() -> AppSettings {
    AppSettings {
        credential_key: Secret::new(vec![5; 32]),
        key_version: 1,
        credential_ttl_millis: DAY,
        retention_days: 90,
        max_attempts: 3,
        retired_keys: Vec::new(),
        session_ttl_millis: DAY,
        max_failed_attempts: 10,
        attempt_window_millis: 600_000,
    }
}

async fn retention_of(
    app: &axum::Router,
    id: &str,
    cookie: &str,
) -> Result<(StatusCode, Value), String> {
    let (status, _, body) = send(
        app,
        "GET",
        &format!("/api/v1/games/{id}/retention"),
        &[("cookie", cookie)],
        "",
    )
    .await?;
    Ok((status, body))
}

#[tokio::test]
async fn ac5_1_1__保持期間の既定は_90_日で_指定すればその日数になり_進行役だけが保持状態を読める()
-> Result<(), String> {
    let Some(env) = start().await? else {
        return Ok(());
    };
    let app = app(env.pool.clone());
    let default = prepared(&app, &env.pool).await?;
    let (status, body) = retention_of(&app, &default.id, &default.facilitator).await?;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body.get("retentionDays"), Some(&json!(90)));
    assert_eq!(body.get("status"), Some(&json!("SCHEDULED")));
    let thirty = prepared_with(
        &app,
        &env.pool,
        &json!({"kind": "KIT", "finalWeek": 2, "demand": [4, 4], "retentionDays": 30}),
    )
    .await?;
    let (_, body) = retention_of(&app, &thirty.id, &thirty.facilitator).await?;
    assert_eq!(body.get("retentionDays"), Some(&json!(30)));
    let span: bool = sqlx::query_scalar(
        "SELECT (delete_after - retention_starts_at) = make_interval(days => 30) \
         FROM retention_policies WHERE game_id = $1::uuid",
    )
    .bind(&thirty.id)
    .fetch_one(&env.pool)
    .await
    .map_err(e)?;
    assert!(span, "削除予定日は、起点の 30 日後");
    let participant = default
        .players
        .first()
        .map(|p| p.2.clone())
        .ok_or("参加者が無い")?;
    let (status, _) = retention_of(&app, &default.id, &participant).await?;
    assert_eq!(status, StatusCode::FORBIDDEN, "参加者には開示しない");
    let (status, _) = retention_of(&app, &default.id, "").await?;
    assert_eq!(status, StatusCode::FORBIDDEN, "資格の無い人には開示しない");
    Ok(())
}

#[tokio::test]
async fn ac5_1_5__保持状態に_バックアップに削除前のデータが残る日数が示される() -> Result<(), String>
{
    let Some(env) = start().await? else {
        return Ok(());
    };
    let app = app(env.pool.clone());
    let game = prepared(&app, &env.pool).await?;
    let (_, body) = retention_of(&app, &game.id, &game.facilitator).await?;
    assert_eq!(body.get("backupRetentionDays"), Some(&json!(7)));
    Ok(())
}

#[tokio::test]
async fn ac5_1_4__削除の完了後に_game_id_を持つどの表にも_そのゲームの行が残らない()
-> Result<(), String> {
    let Some(env) = start().await? else {
        return Ok(());
    };
    let app = app(env.pool.clone());
    let game = prepared_with(
        &app,
        &env.pool,
        &json!({"kind": "KIT", "finalWeek": 2, "demand": [4, 4], "retentionDays": 1}),
    )
    .await?;
    // 同じ DB の別のゲーム（巻き込まれないことの確認）
    let other = prepared(&app, &env.pool).await?;

    let tables: Vec<String> = sqlx::query_scalar(
        "SELECT table_name::text FROM information_schema.columns \
         WHERE table_schema = 'public' AND column_name = 'game_id' ORDER BY table_name",
    )
    .fetch_all(&env.pool)
    .await
    .map_err(e)?;
    assert!(
        tables.len() >= 10,
        "game_id を持つ表を拾えていない: {tables:?}"
    );
    let rows = |id: String, table: String| {
        let pool = env.pool.clone();
        async move {
            sqlx::query_scalar::<_, i64>(sqlx::AssertSqlSafe(format!(
                "SELECT count(*) FROM \"{table}\" WHERE game_id = $1::uuid"
            )))
            .bind(id)
            .fetch_one(&pool)
            .await
            .map_err(e)
        }
    };
    assert!(rows(game.id.clone(), "events".to_owned()).await? > 0);

    let id = u128::from_str_radix(&game.id.replace('-', ""), 16).map_err(e)?;
    let store = PgRetentionStore::new(env.pool.clone());
    let report = run_retention(
        &store,
        &ShiftedEnv(2 * DAY),
        &settings(),
        Some(&[GameId::new(id)]),
    )
    .await
    .map_err(e)?;
    assert_eq!(report.completed, 1);

    for table in &tables {
        let left = rows(game.id.clone(), table.clone()).await?;
        assert_eq!(left, 0, "{table} に行が残っている");
    }
    assert!(
        rows(other.id.clone(), "game_roots".to_owned()).await? > 0,
        "別のゲームは残る"
    );
    let receipts: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM deletion_receipts WHERE game_reference_digest LIKE '%' || replace($1, '-', '') || '%'",
    )
    .bind(&game.id)
    .fetch_one(&env.pool)
    .await
    .map_err(e)?;
    assert_eq!(receipts, 0, "受領記録はゲームの ID を含まない");
    Ok(())
}
