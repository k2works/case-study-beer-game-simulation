// 理由: RT1 の命名（承認済み）の `__` を使うため。
#![allow(non_snake_case)]

//! 応答の待ちの上限（504）と、切り離したタスクの継続（RB2・RT2）。実 PostgreSQL 18.6。

use std::sync::Arc;
use std::time::Duration;

use axum::Router;
use axum::http::StatusCode;
use beergame_adapter_http::router;
use beergame_app::{PgBackend, SystemEnv};
use beergame_application::{AppSettings, Secret};
use serde_json::json;
use sqlx::PgPool;

mod support;
use support::api::{prepared, send};
use support::start;

fn app_with(pool: PgPool, limit: Duration) -> Router {
    let settings = AppSettings {
        credential_key: Secret::new(vec![5; 32]),
        key_version: 1,
        credential_ttl_millis: 86_400_000,
        retention_days: 30,
        max_attempts: 3,
        retired_keys: Vec::new(),
        session_ttl_millis: 86_400_000,
    };
    router(Arc::new(
        PgBackend::new(pool, SystemEnv, settings, false).with_command_timeout(limit),
    ))
}

#[tokio::test]
async fn nf_r18__タイムアウトは_type_なしの_504_で_処理は最後まで走り_同じキーの再送は同じ応答()
-> Result<(), String> {
    let Some(env) = start().await? else {
        return Ok(());
    };
    // 準備は通常の上限で行い、開始だけ上限 0 で呼ぶ
    let normal = support::api::app(env.pool.clone());
    let game = prepared(&normal, &env.pool).await?;
    let impatient = app_with(env.pool.clone(), Duration::ZERO);
    let uri = format!("/api/v1/games/{}/start", game.id);
    let headers = [
        ("cookie", game.facilitator.as_str()),
        ("idempotency-key", "start-timeout"),
    ];
    let (status, _, body) = send(&impatient, "POST", &uri, &headers, "").await?;
    assert_eq!(status, StatusCode::GATEWAY_TIMEOUT);
    assert!(
        body.get("type").is_none() && body.get("code").is_none(),
        "504 は type を持たない: {body}"
    );
    // 応答を待たなくても、処理は最後まで走る（開始が反映される）
    let mut started = false;
    for _ in 0..50 {
        let n: i64 = sqlx::query_scalar("SELECT count(*) FROM events WHERE game_id = $1::uuid AND event_type = 'SessionStarted'")
            .bind(&game.id).fetch_one(&env.pool).await.map_err(|e| e.to_string())?;
        if n == 1 {
            started = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert!(started, "タイムアウトの後も、開始は完了する");
    // 同じ冪等キーでの再送は、保存した成功の応答（二重には実行されない）
    let (status, _, body) = send(&normal, "POST", &uri, &headers, "").await?;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body.pointer("/versions/session"), Some(&json!(1)));
    let n: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM events WHERE game_id = $1::uuid AND event_type = 'GameStarted'",
    )
    .bind(&game.id)
    .fetch_one(&env.pool)
    .await
    .map_err(|e| e.to_string())?;
    assert_eq!(n, 1);
    Ok(())
}
