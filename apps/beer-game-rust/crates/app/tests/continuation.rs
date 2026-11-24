// 理由: RT1 の命名（承認済み）の `__` を使うため。
#![allow(non_snake_case)]

//! 進行の継続（US3.1）。HTTP 越しに、停止・再開・代理入力と、監査（操作者）を確かめる。実 PostgreSQL 18.6。

use axum::Router;
use axum::http::StatusCode;
use serde_json::json;

mod support;
use support::api::{Game, app, e, prepared, send};
use support::start;

async fn started_game(app: &Router, pool: &sqlx::PgPool) -> Result<Game, String> {
    let game = prepared(app, pool).await?;
    let (status, _, _) = send(
        app,
        "POST",
        &format!("/api/v1/games/{}/start", game.id),
        &[("cookie", &game.facilitator), ("idempotency-key", "s")],
        "",
    )
    .await?;
    assert_eq!(status, StatusCode::OK);
    Ok(game)
}

async fn save_as(
    app: &Router,
    game: &Game,
    cookie: &str,
    key: &str,
) -> Result<(StatusCode, axum::http::HeaderMap, serde_json::Value), String> {
    send(
        app,
        "PUT",
        &format!("/api/v1/sessions/{}/decisions", game.id),
        &[("cookie", cookie), ("idempotency-key", key)],
        &json!({"week": 1, "quantity": 4}).to_string(),
    )
    .await
}

async fn control(
    app: &Router,
    game: &Game,
    action: &str,
    key: &str,
) -> Result<(StatusCode, serde_json::Value), String> {
    let (status, _, body) = send(
        app,
        "POST",
        &format!("/api/v1/sessions/{}/{action}", game.id),
        &[("cookie", &game.facilitator), ("idempotency-key", key)],
        "",
    )
    .await?;
    Ok((status, body))
}

#[tokio::test]
async fn ac3_1_3__停止して再開すると_状態は進行中に戻り_保存できる() -> Result<(), String> {
    let Some(env) = start().await? else {
        return Ok(());
    };
    let app = app(env.pool.clone());
    let game = started_game(&app, &env.pool).await?;
    let (status, _) = control(&app, &game, "pause", "p1").await?;
    assert_eq!(status, StatusCode::OK);
    let status_of = |pool: sqlx::PgPool, id: String| async move {
        sqlx::query_scalar::<_, String>(
            "SELECT status FROM session_overview WHERE game_id = $1::uuid",
        )
        .bind(id)
        .fetch_one(&pool)
        .await
        .map_err(e)
    };
    assert_eq!(
        status_of(env.pool.clone(), game.id.clone()).await?,
        "PAUSED"
    );
    // 停止中の二重の停止、停止中の参加者の保存は 409 session.paused
    let (status, body) = control(&app, &game, "pause", "p2").await?;
    assert_eq!(
        (status, body["code"].clone()),
        (StatusCode::CONFLICT, json!("session.paused"))
    );
    let player = &game.players[3].2;
    let (status, _, body) = save_as(&app, &game, player, "q1").await?;
    assert_eq!(
        (status, body["code"].clone()),
        (StatusCode::CONFLICT, json!("session.paused"))
    );
    // 再開すると進行中に戻り、保存できる。停止していない再開は 409 session.not_paused
    let (status, _) = control(&app, &game, "resume", "r1").await?;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        status_of(env.pool.clone(), game.id.clone()).await?,
        "ACTIVE"
    );
    let (status, body) = control(&app, &game, "resume", "r2").await?;
    assert_eq!(
        (status, body["code"].clone()),
        (StatusCode::CONFLICT, json!("session.not_paused"))
    );
    let (status, _, _) = save_as(&app, &game, player, "q2").await?;
    assert_eq!(status, StatusCode::OK);
    Ok(())
}

#[tokio::test]
async fn ac3_1_2__代理入力は停止中も保存され_操作者が進行役として監査に残る() -> Result<(), String>
{
    let Some(env) = start().await? else {
        return Ok(());
    };
    let app = app(env.pool.clone());
    let game = started_game(&app, &env.pool).await?;
    control(&app, &game, "pause", "p1").await?;
    let uri = format!("/api/v1/sessions/{}/proxy-decisions/FACTORY", game.id);
    // 参加者は代理入力できない（403）
    let (status, _, _) = send(
        &app,
        "PUT",
        &uri,
        &[("cookie", &game.players[0].2), ("idempotency-key", "x")],
        &json!({"requestedWeek": 1, "quantity": 6}).to_string(),
    )
    .await?;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, _, body) = send(
        &app,
        "PUT",
        &uri,
        &[("cookie", &game.facilitator), ("idempotency-key", "y")],
        &json!({"requestedWeek": 1, "quantity": 6}).to_string(),
    )
    .await?;
    assert_eq!(status, StatusCode::OK, "{body}");
    let (kind, who, quantity): (String, Option<String>, i64) = sqlx::query_as(
        "SELECT actor_kind, actor_id::text, (payload->>'quantity')::bigint FROM events \
         WHERE game_id = $1::uuid AND event_type = 'ProxyDecisionSubmitted'",
    )
    .bind(&game.id)
    .fetch_one(&env.pool)
    .await
    .map_err(e)?;
    assert_eq!(
        (kind.as_str(), who, quantity),
        ("FACILITATOR", Some(game.id.clone()), 6)
    );
    // 週の指定が古ければ 409 week_advanced、値の範囲外は 422
    let (status, _, body) = send(
        &app,
        "PUT",
        &uri,
        &[("cookie", &game.facilitator), ("idempotency-key", "z")],
        &json!({"requestedWeek": 2, "quantity": 6}).to_string(),
    )
    .await?;
    assert_eq!(
        (status, body["code"].clone()),
        (StatusCode::CONFLICT, json!("session.week_advanced"))
    );
    let (status, _, _) = send(
        &app,
        "PUT",
        &uri,
        &[("cookie", &game.facilitator), ("idempotency-key", "w")],
        &json!({"requestedWeek": 1, "quantity": 1001}).to_string(),
    )
    .await?;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    Ok(())
}
