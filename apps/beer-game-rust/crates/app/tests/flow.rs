// 理由: RT1 の命名（承認済み）の `__` を使うため。
#![allow(non_snake_case)]

//! HTTP 越しの通し（作成 → 参加 → 割り当て → 開始 → 入力 → 確定）と、冪等性・認証・競合。実 PostgreSQL 18.6。

use axum::http::StatusCode;
use serde_json::json;

mod support;
use support::api::{app, e, prepared, send};
use support::start;

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
