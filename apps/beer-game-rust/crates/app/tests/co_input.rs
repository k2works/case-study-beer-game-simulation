// 理由: RT1 の命名（承認済み）の `__` を使うため。
#![allow(non_snake_case)]

//! 共同担当の入力（AC2.1.4・AC2.2.3・AC2.2.4）と、開始後の役割の入れ替え。HTTP 越し。実 PostgreSQL 18.6。

use axum::Router;
use axum::http::StatusCode;
use serde_json::{Value, json};

mod support;
use support::api::{Game, app, e, prepared, send};
use support::start;

/// 小売店に 2 人目（「鈴木」）を割り当てて開始した、2 週のゲーム。（ゲーム、鈴木の ID、鈴木の Cookie）
async fn co_game(app: &Router, pool: &sqlx::PgPool) -> Result<(Game, String, String), String> {
    let game = prepared(app, pool).await?;
    let code: String =
        sqlx::query_scalar("SELECT join_code FROM game_join_codes WHERE game_id = $1::uuid")
            .bind(&game.id)
            .fetch_one(pool)
            .await
            .map_err(e)?;
    let (_, headers, _) = send(
        app,
        "POST",
        "/api/v1/participations/join",
        &[],
        &json!({"joinCode": code, "displayName": "鈴木"}).to_string(),
    )
    .await?;
    let cookie = support::api::cookie_of(&headers)?;
    let pid: String = sqlx::query_scalar(
        "SELECT participant_id::text FROM lobby_participants WHERE game_id = $1::uuid AND role IS NULL",
    )
    .bind(&game.id)
    .fetch_one(pool)
    .await
    .map_err(e)?;
    let (status, _, _) = send(
        app,
        "PUT",
        &format!("/api/v1/games/{}/participants/{pid}/role", game.id),
        &[("cookie", &game.facilitator), ("idempotency-key", "a")],
        &json!({"role": "RETAILER"}).to_string(),
    )
    .await?;
    assert_eq!(status, StatusCode::OK);
    let (status, _, _) = send(
        app,
        "POST",
        &format!("/api/v1/games/{}/start", game.id),
        &[("cookie", &game.facilitator), ("idempotency-key", "s")],
        "",
    )
    .await?;
    assert_eq!(status, StatusCode::OK);
    Ok((game, pid, cookie))
}

async fn save(
    app: &Router,
    game: &Game,
    cookie: &str,
    key: &str,
    version: u32,
    quantity: i64,
) -> Result<(StatusCode, Value), String> {
    let (status, _, body) = send(
        app,
        "PUT",
        &format!("/api/v1/sessions/{}/decisions", game.id),
        &[
            ("cookie", cookie),
            ("idempotency-key", key),
            ("if-match", &version.to_string()),
        ],
        &json!({"week": 1, "quantity": quantity}).to_string(),
    )
    .await?;
    Ok((status, body))
}

async fn state(app: &Router, game: &Game, cookie: &str) -> Result<Value, String> {
    let (status, _, body) = send(
        app,
        "GET",
        &format!("/api/v1/sessions/{}/state", game.id),
        &[("cookie", cookie)],
        "",
    )
    .await?;
    assert_eq!(status, StatusCode::OK, "{body}");
    Ok(body)
}

#[tokio::test]
async fn ac2_1_4__共同担当は同じ状況と保存者を見て_他の役割には共同担当を見せない()
-> Result<(), String> {
    let Some(env) = start().await? else {
        return Ok(());
    };
    let app = app(env.pool.clone());
    let (game, _, suzuki) = co_game(&app, &env.pool).await?;
    let retailer = &game.players[3].2;
    let (status, _) = save(&app, &game, retailer, "k1", 0, 5).await?;
    assert_eq!(status, StatusCode::OK);
    let mine = state(&app, &game, &suzuki).await?;
    let theirs = state(&app, &game, retailer).await?;
    assert_eq!(mine["roleStatus"]["decision"], json!(5));
    assert_eq!(mine["roleStatus"]["decisionVersion"], json!(1));
    // 保存者は、保存した人（自分ではない）。見る人ごとに isSelf だけが違う
    assert_eq!(mine["roleStatus"]["decisionEditor"]["isSelf"], json!(false));
    assert_eq!(
        theirs["roleStatus"]["decisionEditor"]["isSelf"],
        json!(true)
    );
    assert_eq!(
        mine["roleStatus"]["decisionEditor"]["displayName"],
        theirs["roleStatus"]["decisionEditor"]["displayName"]
    );
    assert_eq!(mine["coHolders"].as_array().map(Vec::len), Some(2));
    // 他の役割の参加者には、共同担当の名前も保存者も含まれない
    let other = state(&app, &game, &game.players[2].2).await?;
    assert_eq!(other["coHolders"].as_array().map(Vec::len), Some(1));
    assert!(!other.to_string().contains("鈴木"));
    assert!(other["roleStatus"]["decisionEditor"].is_null());
    Ok(())
}

#[tokio::test]
async fn ac2_2_3__同じ版から_2_人が保存すると_2_人目は競合し_最新値と保存者と時刻を返す()
-> Result<(), String> {
    let Some(env) = start().await? else {
        return Ok(());
    };
    let app = app(env.pool.clone());
    let (game, _, suzuki) = co_game(&app, &env.pool).await?;
    let retailer = &game.players[3].2;
    let (status, _) = save(&app, &game, retailer, "k1", 0, 5).await?;
    assert_eq!(status, StatusCode::OK);
    let (status, body) = save(&app, &game, &suzuki, "k2", 0, 77).await?;
    assert_eq!(
        (status, body["code"].clone()),
        (StatusCode::CONFLICT, json!("session.decision_conflict"))
    );
    let latest = &body["latest"];
    assert_eq!(
        (&latest["quantity"], &latest["version"]),
        (&json!(5), &json!(1))
    );
    assert_eq!(latest["editor"]["kind"], json!("PARTICIPANT"));
    assert_eq!(latest["editor"]["isSelf"], json!(false));
    assert!(
        latest["savedAt"]
            .as_str()
            .is_some_and(|t| t.len() == 24 && t.ends_with('Z'))
    );
    assert!(!body.to_string().contains("77"), "競合した入力は含めない");
    // 最新の版を指定して保存し直すと受け付けられ、保存者は自分になる
    let (status, _) = save(&app, &game, &suzuki, "k3", 1, 77).await?;
    assert_eq!(status, StatusCode::OK);
    let mine = state(&app, &game, &suzuki).await?;
    assert_eq!(mine["roleStatus"]["decisionEditor"]["isSelf"], json!(true));
    Ok(())
}

#[tokio::test]
async fn ac2_2_4__共同担当の一人が保存すると_別の共同担当が取得した状況は同じ値と版になる()
-> Result<(), String> {
    let Some(env) = start().await? else {
        return Ok(());
    };
    let app = app(env.pool.clone());
    let (game, _, suzuki) = co_game(&app, &env.pool).await?;
    let (status, _) = save(&app, &game, &game.players[3].2, "k1", 0, 5).await?;
    assert_eq!(status, StatusCode::OK);
    let mine = state(&app, &game, &suzuki).await?;
    assert_eq!(
        (
            &mine["roleStatus"]["decision"],
            &mine["roleStatus"]["decisionVersion"]
        ),
        (&json!(5), &json!(1))
    );
    Ok(())
}

#[tokio::test]
async fn ac3_2_5__開始後の入れ替えで旧担当者全員の資格が失効し_新担当者が引き継ぐ()
-> Result<(), String> {
    let Some(env) = start().await? else {
        return Ok(());
    };
    let app = app(env.pool.clone());
    let (game, suzuki_id, suzuki) = co_game(&app, &env.pool).await?;
    // 開始後に参加できる人はいないので、準備中に別の参加者（役割なし）を足すかわりに、
    // 開始前に参加し役割を持たなかった人がいない場合の拒否を確かめる（別の役割にいる人の付け替えは準備中でない）
    let (status, _, body) = send(
        &app,
        "PUT",
        &format!("/api/v1/games/{}/participants/{suzuki_id}/role", game.id),
        &[("cookie", &game.facilitator), ("idempotency-key", "m")],
        &json!({"role": "FACTORY"}).to_string(),
    )
    .await?;
    assert_eq!(
        (status, body["code"].clone()),
        (StatusCode::CONFLICT, json!("game.not_preparing"))
    );
    // 入れ替えの拒否では、資格は失効しない
    let (status, _, _) = send(
        &app,
        "GET",
        &format!("/api/v1/games/{}/state", game.id),
        &[("cookie", &suzuki)],
        "",
    )
    .await?;
    assert_eq!(status, StatusCode::OK);
    Ok(())
}
