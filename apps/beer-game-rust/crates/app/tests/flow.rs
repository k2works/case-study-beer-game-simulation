// 理由: RT1 の命名（承認済み）の `__` を使うため。
#![allow(non_snake_case)]

//! HTTP 越しの通し（作成 → 参加 → 割り当て → 開始 → 入力 → 確定）と、冪等性・認証・競合。実 PostgreSQL 18.6。

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

fn app(pool: PgPool) -> Router {
    let settings = AppSettings {
        credential_key: Secret::new(vec![5; 32]),
        key_version: 1,
        credential_ttl_millis: 86_400_000,
        retention_days: 30,
        max_attempts: 3,
    };
    router(Arc::new(PgBackend::new(pool, SystemEnv, settings, false)))
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
    Ok((
        parts.status,
        parts.headers,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    ))
}

fn cookie_of(headers: &HeaderMap) -> Result<String, String> {
    let raw = headers
        .get("set-cookie")
        .and_then(|v| v.to_str().ok())
        .ok_or("Set-Cookie が無い")?;
    Ok(raw.split(';').next().ok_or("Cookie が空")?.to_owned())
}

struct Game {
    id: String,
    facilitator: String,
    /// （役割, 参加者 ID, Cookie）
    players: Vec<(&'static str, String, String)>,
}

/// 作成 → 4 人の参加 → 割り当て（開始はしない）。
async fn prepared(app: &Router, pool: &PgPool) -> Result<Game, String> {
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
    let code: String = sqlx::query_scalar("SELECT join_code FROM game_join_codes")
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

#[tokio::test]
async fn ac2_3_1__HTTP_で作成から確定まで通り_週が進む() -> Result<(), String> {
    let Some(env) = start().await? else {
        return Ok(());
    };
    let app = app(env.pool.clone());
    let game = prepared(&app, &env.pool).await?;
    // 開始
    let (status, _, body) = send(
        &app,
        "POST",
        &format!("/api/v1/games/{}/start", game.id),
        &[
            ("cookie", &game.facilitator),
            ("idempotency-key", "start-1"),
        ],
        "",
    )
    .await?;
    assert_eq!(status, StatusCode::OK);
    assert!(body["versions"]["game"].is_number() && body["versions"]["session"] == json!(1));
    // 4 役割の入力
    for (i, (role, _, cookie)) in game.players.iter().enumerate() {
        let (status, _, body) = send(
            &app,
            "PUT",
            &format!("/api/v1/sessions/{}/decisions", game.id),
            &[
                ("cookie", cookie),
                ("idempotency-key", &format!("save-{i}")),
            ],
            &json!({"week": 1, "quantity": 6}).to_string(),
        )
        .await?;
        assert_eq!(status, StatusCode::OK, "{role}: {body}");
    }
    // 確定（進行役。basis は各役割の版 1）
    let commit_body = json!({"requestedWeek": 1, "basis": {"FACTORY": 1, "DISTRIBUTOR": 1, "WHOLESALER": 1, "RETAILER": 1}}).to_string();
    let (status, _, body) = send(
        &app,
        "POST",
        &format!("/api/v1/sessions/{}/weeks/1/commit", game.id),
        &[
            ("cookie", &game.facilitator),
            ("idempotency-key", "commit-1"),
        ],
        &commit_body,
    )
    .await?;
    assert_eq!(
        (status, body["versions"]["session"].clone()),
        (StatusCode::OK, json!(6))
    );
    let week: i32 =
        sqlx::query_scalar("SELECT week FROM session_overview WHERE game_id = $1::uuid")
            .bind(&game.id)
            .fetch_one(&env.pool)
            .await
            .map_err(e)?;
    assert_eq!(week, 2);
    Ok(())
}

#[tokio::test]
async fn ac2_3_2__同じ冪等キーの再送は同じ応答を返し_追記しない() -> Result<(), String> {
    let Some(env) = start().await? else {
        return Ok(());
    };
    let app = app(env.pool.clone());
    let game = prepared(&app, &env.pool).await?;
    let uri = format!("/api/v1/games/{}/start", game.id);
    let first = send(
        &app,
        "POST",
        &uri,
        &[("cookie", &game.facilitator), ("idempotency-key", "k1")],
        "",
    )
    .await?;
    let events: i64 = sqlx::query_scalar("SELECT count(*) FROM events WHERE game_id = $1::uuid")
        .bind(&game.id)
        .fetch_one(&env.pool)
        .await
        .map_err(e)?;
    let again = send(
        &app,
        "POST",
        &uri,
        &[("cookie", &game.facilitator), ("idempotency-key", "k1")],
        "",
    )
    .await?;
    assert_eq!(
        (again.0, again.2.clone()),
        (first.0, first.2.clone()),
        "同じ応答"
    );
    let after: i64 = sqlx::query_scalar("SELECT count(*) FROM events WHERE game_id = $1::uuid")
        .bind(&game.id)
        .fetch_one(&env.pool)
        .await
        .map_err(e)?;
    assert_eq!(events, after, "再送は追記しない");
    // 別のキーでの開始は、開始済みとして 409
    let (status, _, problem) = send(
        &app,
        "POST",
        &uri,
        &[("cookie", &game.facilitator), ("idempotency-key", "k2")],
        "",
    )
    .await?;
    assert_eq!(
        (status, problem["code"].clone()),
        (StatusCode::CONFLICT, json!("session.already_started"))
    );
    Ok(())
}

#[tokio::test]
async fn ac2_2_2__同じ冪等キーで内容が違えば_409_idempotency_key_reused() -> Result<(), String> {
    let Some(env) = start().await? else {
        return Ok(());
    };
    let app = app(env.pool.clone());
    let game = prepared(&app, &env.pool).await?;
    send(
        &app,
        "POST",
        &format!("/api/v1/games/{}/start", game.id),
        &[("cookie", &game.facilitator), ("idempotency-key", "s")],
        "",
    )
    .await?;
    let (_, _, cookie) = (&game.players[3].0, &game.players[3].1, &game.players[3].2);
    let uri = format!("/api/v1/sessions/{}/decisions", game.id);
    let ok = send(
        &app,
        "PUT",
        &uri,
        &[("cookie", cookie), ("idempotency-key", "same")],
        &json!({"week": 1, "quantity": 5}).to_string(),
    )
    .await?;
    assert_eq!(ok.0, StatusCode::OK);
    let reused = send(
        &app,
        "PUT",
        &uri,
        &[("cookie", cookie), ("idempotency-key", "same")],
        &json!({"week": 1, "quantity": 9}).to_string(),
    )
    .await?;
    assert_eq!(
        (reused.0, reused.2["code"].clone()),
        (StatusCode::CONFLICT, json!("app.idempotency_key_reused"))
    );
    Ok(())
}

#[tokio::test]
async fn ac2_2_2__Idempotency_Key_が無ければ_400_資格が無ければ_403() -> Result<(), String> {
    let Some(env) = start().await? else {
        return Ok(());
    };
    let app = app(env.pool.clone());
    let game = prepared(&app, &env.pool).await?;
    let uri = format!("/api/v1/games/{}/start", game.id);
    let missing = send(&app, "POST", &uri, &[("cookie", &game.facilitator)], "").await?;
    assert_eq!(missing.0, StatusCode::BAD_REQUEST);
    let none = send(&app, "POST", &uri, &[("idempotency-key", "x")], "").await?;
    assert_eq!(
        (none.0, none.2["code"].clone()),
        (StatusCode::FORBIDDEN, json!("app.unauthorized"))
    );
    // 参加者は開始できない
    let player = &game.players[0].2;
    let forbidden = send(
        &app,
        "POST",
        &uri,
        &[("cookie", player), ("idempotency-key", "y")],
        "",
    )
    .await?;
    assert_eq!(forbidden.0, StatusCode::FORBIDDEN);
    Ok(())
}

#[tokio::test]
async fn ac2_2_2__数量が範囲外なら_422_版が違えば_409_で最新を示す() -> Result<(), String> {
    let Some(env) = start().await? else {
        return Ok(());
    };
    let app = app(env.pool.clone());
    let game = prepared(&app, &env.pool).await?;
    send(
        &app,
        "POST",
        &format!("/api/v1/games/{}/start", game.id),
        &[("cookie", &game.facilitator), ("idempotency-key", "s")],
        "",
    )
    .await?;
    let cookie = &game.players[3].2;
    let uri = format!("/api/v1/sessions/{}/decisions", game.id);
    let (status, _, problem) = send(
        &app,
        "PUT",
        &uri,
        &[("cookie", cookie), ("idempotency-key", "q1")],
        &json!({"week": 1, "quantity": 1001}).to_string(),
    )
    .await?;
    assert_eq!(
        (status, problem["errors"][0]["field"].clone()),
        (StatusCode::UNPROCESSABLE_ENTITY, json!("quantity"))
    );
    let (status, _, _) = send(
        &app,
        "PUT",
        &uri,
        &[("cookie", cookie), ("idempotency-key", "q2")],
        &json!({"week": 1, "quantity": 5}).to_string(),
    )
    .await?;
    assert_eq!(status, StatusCode::OK);
    // 版 0 のままの保存は、最新（版 1）と競合する
    let (status, _, problem) = send(
        &app,
        "PUT",
        &uri,
        &[
            ("cookie", cookie),
            ("idempotency-key", "q3"),
            ("if-match", "\"0\""),
        ],
        &json!({"week": 1, "quantity": 7}).to_string(),
    )
    .await?;
    assert_eq!(
        (status, problem["code"].clone()),
        (StatusCode::CONFLICT, json!("session.decision_conflict"))
    );
    assert_eq!(problem["latest"], json!({"quantity": 5, "version": 1}));
    // 古い週は week_advanced（週の判定が先）
    let (status, _, problem) = send(
        &app,
        "PUT",
        &uri,
        &[
            ("cookie", cookie),
            ("idempotency-key", "q4"),
            ("if-match", "1"),
        ],
        &json!({"week": 2, "quantity": 7}).to_string(),
    )
    .await?;
    assert_eq!(
        (status, problem["code"].clone()),
        (StatusCode::CONFLICT, json!("session.week_advanced"))
    );
    // 入力がそろっていない確定は 422
    let commit = json!({"requestedWeek": 1, "basis": {"FACTORY": 0, "DISTRIBUTOR": 0, "WHOLESALER": 0, "RETAILER": 1}}).to_string();
    let (status, _, problem) = send(
        &app,
        "POST",
        &format!("/api/v1/sessions/{}/weeks/1/commit", game.id),
        &[("cookie", &game.facilitator), ("idempotency-key", "c1")],
        &commit,
    )
    .await?;
    assert_eq!(
        (status, problem["code"].clone()),
        (
            StatusCode::UNPROCESSABLE_ENTITY,
            json!("session.incomplete_decisions")
        )
    );
    assert_eq!(
        problem["missingRoles"],
        json!(["FACTORY", "DISTRIBUTOR", "WHOLESALER"])
    );
    Ok(())
}
