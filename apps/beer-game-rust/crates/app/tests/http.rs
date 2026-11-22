// 理由: RT1 の命名（承認済み）の `__` を使うため。
#![allow(non_snake_case)]

//! HTTP の統合テスト（axum のルーターを直接呼ぶ。実 PostgreSQL 18.6）。AC1.1.1・AC1.1.2・AC1.2.1・AC1.2.2、AC6.1.2・AC6.1.4。

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

mod support;
use support::start;

fn e<T: std::fmt::Debug>(x: T) -> String {
    format!("{x:?}")
}

fn app(pool: PgPool, secure: bool) -> Router {
    let settings = AppSettings {
        credential_key: Secret::new(vec![5; 32]),
        key_version: 1,
        credential_ttl_millis: 86_400_000,
        retention_days: 90,
        max_attempts: 3,
        retired_keys: Vec::new(),
        session_ttl_millis: 86_400_000,
        max_failed_attempts: 10,
        attempt_window_millis: 600_000,
    };
    router(Arc::new(PgBackend::new(pool, SystemEnv, settings, secure)))
}

async fn send(
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
    let json = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    Ok((parts.status, parts.headers, json))
}

fn create_body() -> String {
    json!({"kind": "KIT", "finalWeek": 3, "demand": [4, 4, 4]}).to_string()
}

#[tokio::test]
async fn ac6_1_4__health_は_200_ready_は_DB_に接続できれば_200_できなければ_503()
-> Result<(), String> {
    let Some(env) = start().await? else {
        return Ok(());
    };
    let app = app(env.pool.clone(), false);
    assert_eq!(
        send(&app, "GET", "/api/v1/health", &[], "").await?.0,
        StatusCode::OK
    );
    assert_eq!(
        send(&app, "GET", "/api/v1/ready", &[], "").await?.0,
        StatusCode::OK
    );
    env.pool.close().await;
    let (status, _, body) = send(&app, "GET", "/api/v1/ready", &[], "").await?;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(body["type"], json!("/problems/app.not_ready"));
    Ok(())
}

#[tokio::test]
async fn ac1_1_1__作成は_201_で_Location_と資格の_Cookie_と版を返す() -> Result<(), String> {
    let Some(env) = start().await? else {
        return Ok(());
    };
    let app = app(env.pool.clone(), false);
    let (status, headers, body) = send(&app, "POST", "/api/v1/games", &[], &create_body()).await?;
    assert_eq!(status, StatusCode::CREATED);
    // 進行役の復帰コードを、一度だけ示す（復帰資格の Cookie と同じ値）
    assert_eq!(body["versions"], json!({"game": 1, "session": null}));
    assert!(body["recoveryCode"].as_str().is_some_and(|c| c.len() == 43));
    let location = headers
        .get("location")
        .and_then(|v| v.to_str().ok())
        .ok_or("Location が無い")?
        .to_owned();
    assert!(location.starts_with("/api/v1/games/") && location.ends_with("/state"));
    let cookie = headers
        .get("set-cookie")
        .and_then(|v| v.to_str().ok())
        .ok_or("Set-Cookie が無い")?
        .to_owned();
    assert!(cookie.starts_with("bg_session="), "{cookie}");
    assert!(
        cookie.contains("HttpOnly")
            && cookie.contains("SameSite=Strict")
            && cookie.contains("Max-Age=86400")
    );
    assert!(
        !cookie.contains("Secure"),
        "HTTP の環境では Secure を付けない"
    );
    assert!(headers.contains_key("x-correlation-id"));
    // 資格の生の値は、本文にも DB にも出ない
    let token = cookie
        .trim_start_matches("bg_session=")
        .split(';')
        .next()
        .ok_or("値が無い")?
        .to_owned();
    assert!(!body.to_string().contains(&token));
    let leaked: i64 =
        sqlx::query_scalar("SELECT count(*) FROM credentials WHERE credential_digest = $1")
            .bind(&token)
            .fetch_one(&env.pool)
            .await
            .map_err(e)?;
    assert_eq!(leaked, 0);
    Ok(())
}

#[tokio::test]
async fn ac1_1_2__無効な需要系列は_422_で作成されず_対象の週と修正内容を示す() -> Result<(), String>
{
    let Some(env) = start().await? else {
        return Ok(());
    };
    let app = app(env.pool.clone(), false);
    let mut demand = vec![4; 12];
    demand[4] = 1001;
    let body = json!({"kind": "KIT", "finalWeek": 12, "demand": demand}).to_string();
    let (status, headers, problem) = send(&app, "POST", "/api/v1/games", &[], &body).await?;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(problem["code"], json!("validation.invalid_input"));
    assert_eq!(
        problem["errors"],
        json!([{"field": "demand", "week": 5, "message": "需要は 0〜1000 の整数"}])
    );
    assert_eq!(
        headers.get("content-type").and_then(|v| v.to_str().ok()),
        Some("application/problem+json")
    );
    let games: i64 = sqlx::query_scalar("SELECT count(*) FROM game_roots")
        .fetch_one(&env.pool)
        .await
        .map_err(e)?;
    assert_eq!(games, 0, "作成されない");
    // 整数でない値も、対象の週つきの形の誤り
    let (status, _, problem) = send(
        &app,
        "POST",
        "/api/v1/games",
        &[],
        &json!({"finalWeek": 3, "demand": [4, "x", 4]}).to_string(),
    )
    .await?;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(problem["errors"][0]["week"], json!(2));
    Ok(())
}

#[tokio::test]
async fn ac1_1_2__JSON_として不正な本文は_400() -> Result<(), String> {
    let Some(env) = start().await? else {
        return Ok(());
    };
    let app = app(env.pool.clone(), false);
    let (status, _, problem) = send(&app, "POST", "/api/v1/games", &[], "{").await?;
    assert_eq!(
        (status, problem["code"].clone()),
        (StatusCode::BAD_REQUEST, json!("validation.invalid_input"))
    );
    Ok(())
}

#[tokio::test]
async fn ac1_2_1__有効な参加コードで参加すると_200_でゲームの_ID_と_Cookie_を返す()
-> Result<(), String> {
    let Some(env) = start().await? else {
        return Ok(());
    };
    let app = app(env.pool.clone(), false);
    let (_, headers, _) = send(&app, "POST", "/api/v1/games", &[], &create_body()).await?;
    let location = headers
        .get("location")
        .and_then(|v| v.to_str().ok())
        .ok_or("Location が無い")?
        .to_owned();
    let code: String = sqlx::query_scalar("SELECT join_code FROM game_join_codes")
        .fetch_one(&env.pool)
        .await
        .map_err(e)?;
    let body = json!({"joinCode": code, "displayName": "山本"}).to_string();
    let (status, headers, body) =
        send(&app, "POST", "/api/v1/participations/join", &[], &body).await?;
    assert_eq!(status, StatusCode::OK);
    assert!(location.contains(body["gameId"].as_str().ok_or("gameId が無い")?));
    assert_eq!(body["versions"], json!({"game": 2, "session": null}));
    assert!(
        headers
            .get("set-cookie")
            .and_then(|v| v.to_str().ok())
            .is_some_and(|c| c.starts_with("bg_session="))
    );
    let rows: i64 = sqlx::query_scalar("SELECT count(*) FROM lobby_participants")
        .fetch_one(&env.pool)
        .await
        .map_err(e)?;
    assert_eq!(rows, 1);
    Ok(())
}

#[tokio::test]
async fn ac1_2_2__不明な参加コードは_403_で_理由を区別しない() -> Result<(), String> {
    let Some(env) = start().await? else {
        return Ok(());
    };
    let app = app(env.pool.clone(), false);
    for code in ["abcdefgh1234", "x"] {
        let body = json!({"joinCode": code, "displayName": "山本"}).to_string();
        let (status, _, problem) =
            send(&app, "POST", "/api/v1/participations/join", &[], &body).await?;
        assert_eq!(
            (status, problem["code"].clone()),
            (StatusCode::FORBIDDEN, json!("game.invitation_invalid"))
        );
    }
    Ok(())
}

#[tokio::test]
async fn ac1_2_1__表示名が空なら_422() -> Result<(), String> {
    let Some(env) = start().await? else {
        return Ok(());
    };
    let app = app(env.pool.clone(), false);
    send(&app, "POST", "/api/v1/games", &[], &create_body()).await?;
    let code: String = sqlx::query_scalar("SELECT join_code FROM game_join_codes")
        .fetch_one(&env.pool)
        .await
        .map_err(e)?;
    let (status, _, problem) = send(
        &app,
        "POST",
        "/api/v1/participations/join",
        &[],
        &json!({"joinCode": code, "displayName": "  "}).to_string(),
    )
    .await?;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(problem["errors"][0]["field"], json!("displayName"));
    Ok(())
}

#[tokio::test]
async fn adr_020__tab_id_があれば_Cookie_の名前にタブごとの接尾辞が付き_https_では_Secure_が付く()
-> Result<(), String> {
    let Some(env) = start().await? else {
        return Ok(());
    };
    let app = app(env.pool.clone(), true);
    let (_, headers, _) = send(
        &app,
        "POST",
        "/api/v1/games",
        &[("x-tab-id", "abcdef0123456789")],
        &create_body(),
    )
    .await?;
    let cookie = headers
        .get("set-cookie")
        .and_then(|v| v.to_str().ok())
        .ok_or("Set-Cookie が無い")?;
    assert!(
        cookie.starts_with("bg_session_abcdef0123456789="),
        "{cookie}"
    );
    assert!(cookie.contains("Secure"));
    // 形が不正な X-Tab-Id は、無視して既定の名前
    let (_, headers, _) = send(
        &app,
        "POST",
        "/api/v1/games",
        &[("x-tab-id", "short")],
        &create_body(),
    )
    .await?;
    assert!(
        headers
            .get("set-cookie")
            .and_then(|v| v.to_str().ok())
            .is_some_and(|c| c.starts_with("bg_session="))
    );
    Ok(())
}

#[tokio::test]
async fn ac6_1_1__相関_ID_は_UUID_ならそのまま使い_そうでなければ作る() -> Result<(), String> {
    let Some(env) = start().await? else {
        return Ok(());
    };
    let app = app(env.pool.clone(), false);
    let id = "5a1c8a0e-3b1d-4c0e-9d0a-0e0d6f6a1b2c";
    let (_, headers, _) = send(
        &app,
        "GET",
        "/api/v1/health",
        &[("x-correlation-id", id)],
        "",
    )
    .await?;
    assert_eq!(
        headers
            .get("x-correlation-id")
            .and_then(|v| v.to_str().ok()),
        Some(id)
    );
    let (_, headers, _) = send(
        &app,
        "GET",
        "/api/v1/health",
        &[("x-correlation-id", "not-a-uuid")],
        "",
    )
    .await?;
    assert!(
        headers
            .get("x-correlation-id")
            .and_then(|v| v.to_str().ok())
            .is_some_and(|v| v != "not-a-uuid" && v.len() == 36)
    );
    Ok(())
}
