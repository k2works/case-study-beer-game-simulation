// 理由: RT1 の命名（承認済み）の `__` を使うため。
#![allow(non_snake_case)]

//! 終了後の振り返り（US4.2）。HTTP 越しに、終了前の拒否・終了後の開示・認可・決定論を確かめる。実 PostgreSQL 18.6。

use axum::Router;
use axum::http::StatusCode;
use serde_json::{Value, json};

mod support;
use support::api::{Game, app, prepared, send};
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

/// 全役割が同じ数量を保存し、進行役が確定する（各役割の版は 1）。
async fn commit_week(app: &Router, game: &Game, week: u32, quantity: i64) -> Result<(), String> {
    for (i, (_, _, cookie)) in game.players.iter().enumerate() {
        let (status, _, body) = send(
            app,
            "PUT",
            &format!("/api/v1/sessions/{}/decisions", game.id),
            &[
                ("cookie", cookie),
                ("idempotency-key", &format!("save-{week}-{i}")),
            ],
            &json!({"week": week, "quantity": quantity}).to_string(),
        )
        .await?;
        assert_eq!(status, StatusCode::OK, "{body}");
    }
    let basis = json!({"FACTORY": 1, "DISTRIBUTOR": 1, "WHOLESALER": 1, "RETAILER": 1});
    let (status, _, body) = send(
        app,
        "POST",
        &format!("/api/v1/sessions/{}/weeks/{week}/commit", game.id),
        &[
            ("cookie", &game.facilitator),
            ("idempotency-key", &format!("commit-{week}")),
        ],
        &json!({"requestedWeek": week, "basis": basis}).to_string(),
    )
    .await?;
    assert_eq!(status, StatusCode::OK, "{body}");
    Ok(())
}

async fn review(
    app: &Router,
    game: &Game,
    cookie: Option<&str>,
) -> Result<(StatusCode, Value), String> {
    let headers: Vec<(&str, &str)> = cookie.map(|c| ("cookie", c)).into_iter().collect();
    let (status, _, body) = send(
        app,
        "GET",
        &format!("/api/v1/games/{}/review", game.id),
        &headers,
        "",
    )
    .await?;
    Ok((status, body))
}

#[tokio::test]
async fn ac4_2_1__終了後は進行役も参加者も_全役割の全週の結果を週と役割の順に取得できる()
-> Result<(), String> {
    let Some(env) = start().await? else {
        return Ok(());
    };
    let app = app(env.pool.clone());
    let game = started_game(&app, &env.pool).await?;
    commit_week(&app, &game, 1, 4).await?;
    commit_week(&app, &game, 2, 4).await?;
    let (status, body) = review(&app, &game, Some(&game.facilitator)).await?;
    assert_eq!(status, StatusCode::OK, "{body}");
    let results = body["results"].as_array().ok_or("results が無い")?;
    assert_eq!(results.len(), 8, "4 役割 × 2 週");
    let order: Vec<(i64, String)> = results
        .iter()
        .map(|r| {
            (
                r["week"].as_i64().unwrap_or(0),
                r["role"].as_str().unwrap_or("").to_owned(),
            )
        })
        .collect();
    let roles = ["FACTORY", "DISTRIBUTOR", "WHOLESALER", "RETAILER"];
    let expected: Vec<(i64, String)> = (1..=2)
        .flat_map(|w| roles.map(|r| (w, r.to_owned())))
        .collect();
    assert_eq!(order, expected, "週・役割（工場から小売店）の順");
    // 参加者（どの役割でも）が同じ内容を取得でき、進行役と一致する（決定論）
    let participant = &game.players[0].2;
    let (status, same) = review(&app, &game, Some(participant)).await?;
    assert_eq!((status, same), (StatusCode::OK, body.clone()));
    assert_eq!(body["finalWeek"], json!(2));
    assert_eq!(body["settingsKind"], json!("KIT"));
    Ok(())
}

#[tokio::test]
async fn ac4_2_2__終了前は_進行役にも参加者にも_409_game_not_ended_で値を含めない()
-> Result<(), String> {
    let Some(env) = start().await? else {
        return Ok(());
    };
    let app = app(env.pool.clone());
    let game = started_game(&app, &env.pool).await?;
    commit_week(&app, &game, 1, 4).await?;
    for cookie in [&game.facilitator, &game.players[2].2] {
        let (status, body) = review(&app, &game, Some(cookie)).await?;
        assert_eq!(
            (status, body["code"].clone(), body.get("results").is_none()),
            (StatusCode::CONFLICT, json!("game.not_ended"), true)
        );
    }
    Ok(())
}

#[tokio::test]
async fn ac4_2_2__開始前も終了していないので_409_資格が無ければ_403() -> Result<(), String> {
    let Some(env) = start().await? else {
        return Ok(());
    };
    let app = app(env.pool.clone());
    let game = prepared(&app, &env.pool).await?;
    let (status, body) = review(&app, &game, Some(&game.facilitator)).await?;
    assert_eq!(
        (status, body["code"].clone()),
        (StatusCode::CONFLICT, json!("game.not_ended"))
    );
    let (status, body) = review(&app, &game, None).await?;
    assert_eq!(
        (status, body["code"].clone()),
        (StatusCode::FORBIDDEN, json!("app.unauthorized"))
    );
    Ok(())
}

#[tokio::test]
async fn ac4_2_2__別のゲームの資格では_終了後でも_403() -> Result<(), String> {
    let Some(env) = start().await? else {
        return Ok(());
    };
    let app = app(env.pool.clone());
    let game = started_game(&app, &env.pool).await?;
    let other = started_game(&app, &env.pool).await?;
    commit_week(&app, &game, 1, 4).await?;
    commit_week(&app, &game, 2, 4).await?;
    let (status, _) = review(&app, &game, Some(&other.facilitator)).await?;
    assert_eq!(status, StatusCode::FORBIDDEN);
    Ok(())
}
