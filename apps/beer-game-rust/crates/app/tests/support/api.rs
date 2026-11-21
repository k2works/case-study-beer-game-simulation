//! HTTP 越しのテストの共通部品。

use std::sync::Arc;

use axum::Router;
use axum::body::Body;
use axum::http::{HeaderMap, Request, StatusCode};
use beergame_adapter_http::router;
use beergame_app::{PgBackend, SystemEnv};
use beergame_application::{AppSettings, Secret};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use sqlx::PgPool;
use tower::ServiceExt;

pub fn e<T: std::fmt::Debug>(x: T) -> String {
    format!("{x:?}")
}

pub fn app(pool: PgPool) -> Router {
    let settings = AppSettings {
        credential_key: Secret::new(vec![5; 32]),
        key_version: 1,
        credential_ttl_millis: 86_400_000,
        retention_days: 30,
        max_attempts: 3,
    };
    router(Arc::new(PgBackend::new(pool, SystemEnv, settings, false)))
}

pub async fn send(
    app: &Router,
    method: &str,
    uri: &str,
    extra: &[(&str, &str)],
    body: &str,
) -> Result<(StatusCode, HeaderMap, Value), String> {
    let mut builder = Request::builder()
        .method(method)
        .uri(uri)
        .header("content-type", "application/json");
    for (k, v) in extra {
        builder = builder.header(*k, *v);
    }
    let response = app
        .clone()
        .oneshot(builder.body(Body::from(body.to_owned())).map_err(e)?)
        .await
        .map_err(e)?;
    let (parts, body) = response.into_parts();
    let bytes = body.collect().await.map_err(e)?.to_bytes();
    Ok((
        parts.status,
        parts.headers,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    ))
}

pub fn cookie_of(headers: &HeaderMap) -> Result<String, String> {
    let raw = headers
        .get("set-cookie")
        .and_then(|v| v.to_str().ok())
        .ok_or("Set-Cookie が無い")?;
    Ok(raw.split(';').next().ok_or("Cookie が空")?.to_owned())
}

pub struct Game {
    pub id: String,
    pub facilitator: String,
    /// （役割, 参加者 ID, Cookie）
    pub players: Vec<(&'static str, String, String)>,
}

/// 作成 → 4 人の参加 → 割り当て（開始はしない）。
pub async fn prepared(app: &Router, pool: &PgPool) -> Result<Game, String> {
    let (status, headers, _) = send(
        app,
        "POST",
        "/api/v1/games",
        &[],
        &json!({"kind": "KIT", "finalWeek": 2, "demand": [4, 4]}).to_string(),
    )
    .await?;
    assert_eq!(status, StatusCode::CREATED);
    let facilitator = cookie_of(&headers)?;
    let location = headers
        .get("location")
        .and_then(|v| v.to_str().ok())
        .ok_or("Location が無い")?;
    let id = location
        .trim_start_matches("/api/v1/games/")
        .trim_end_matches("/state")
        .to_owned();
    let code: String =
        sqlx::query_scalar("SELECT join_code FROM game_join_codes WHERE game_id = $1::uuid")
            .bind(&id)
            .fetch_one(pool)
            .await
            .map_err(e)?;
    let mut players = Vec::new();
    for (i, role) in ["FACTORY", "DISTRIBUTOR", "WHOLESALER", "RETAILER"]
        .into_iter()
        .enumerate()
    {
        let (status, headers, _) = send(
            app,
            "POST",
            "/api/v1/participations/join",
            &[],
            &json!({"joinCode": code, "displayName": format!("参加者{i}")}).to_string(),
        )
        .await?;
        assert_eq!(status, StatusCode::OK);
        let cookie = cookie_of(&headers)?;
        let pid: String = sqlx::query_scalar("SELECT participant_id::text FROM lobby_participants WHERE role IS NULL AND game_id = $1::uuid LIMIT 1")
            .bind(&id).fetch_one(pool).await.map_err(e)?;
        let (status, _, body) = send(
            app,
            "PUT",
            &format!("/api/v1/games/{id}/participants/{pid}/role"),
            &[
                ("cookie", &facilitator),
                ("idempotency-key", &format!("assign-{i}")),
            ],
            &json!({"role": role}).to_string(),
        )
        .await?;
        assert_eq!(
            (status, body.pointer("/versions/session").cloned()),
            (StatusCode::OK, Some(Value::Null))
        );
        players.push((role, pid, cookie));
    }
    Ok(Game {
        id,
        facilitator,
        players,
    })
}
