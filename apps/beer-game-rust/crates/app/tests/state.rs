// 理由: RT1 の命名（承認済み）の `__` を使うため。
#![allow(non_snake_case)]

//! 問い合わせ（状態）と開示の規則。AC2.1.1〜AC2.1.3・AC2.3.5。実 PostgreSQL 18.6。

use axum::http::StatusCode;
use serde_json::json;

mod support;
use support::api::{Game, app, prepared, send};
use support::start;

async fn started(app: &axum::Router, game: &Game) -> Result<(), String> {
    let (status, _, _) = send(
        app,
        "POST",
        &format!("/api/v1/games/{}/start", game.id),
        &[("cookie", &game.facilitator), ("idempotency-key", "start")],
        "",
    )
    .await?;
    assert_eq!(status, StatusCode::OK);
    for (i, (_, _, cookie)) in game.players.iter().enumerate() {
        let (status, _, _) = send(
            app,
            "PUT",
            &format!("/api/v1/sessions/{}/decisions", game.id),
            &[("cookie", cookie), ("idempotency-key", &format!("s{i}"))],
            &json!({"week": 1, "quantity": 6 + i}).to_string(),
        )
        .await?;
        assert_eq!(status, StatusCode::OK);
    }
    Ok(())
}

#[tokio::test]
async fn ac2_1_1__参加者には自分の役割の状況だけを返し_小売店だけが当週の需要を見る()
-> Result<(), String> {
    let Some(env) = start().await? else {
        return Ok(());
    };
    let app = app(env.pool.clone());
    let game = prepared(&app, &env.pool).await?;
    started(&app, &game).await?;
    let uri = format!("/api/v1/sessions/{}/state", game.id);
    // 小売店（4 人目）
    let (status, _, body) = send(&app, "GET", &uri, &[("cookie", &game.players[3].2)], "").await?;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body.get("role"), Some(&json!("RETAILER")));
    let own = body.get("roleStatus").ok_or("roleStatus が無い")?;
    assert_eq!(
        own.get("customerDemand"),
        Some(&json!(4)),
        "小売店は当週の需要を見る（需要系列の第 1 週）"
    );
    assert_eq!(own.get("decision"), Some(&json!(9)));
    assert!(
        body.get("roles").is_none() && body.get("results").is_none(),
        "他の役割の値を含めない"
    );
    assert!(
        !body.to_string().contains("\"demand\":[") && body.get("finalWeek").is_none(),
        "将来の需要・進行役の項目を含めない"
    );
    // 卸（3 人目）には顧客需要を開示しない
    let (_, _, body) = send(&app, "GET", &uri, &[("cookie", &game.players[2].2)], "").await?;
    let own = body.get("roleStatus").ok_or("roleStatus が無い")?;
    assert!(
        own.get("customerDemand").is_none(),
        "小売店以外には項目ごと含めない"
    );
    assert_eq!(body.get("role"), Some(&json!("WHOLESALER")));
    Ok(())
}

#[tokio::test]
async fn ac2_1_2__他の役割の状況の問い合わせは_403_で値を返さない() -> Result<(), String> {
    let Some(env) = start().await? else {
        return Ok(());
    };
    let app = app(env.pool.clone());
    let game = prepared(&app, &env.pool).await?;
    started(&app, &game).await?;
    let uri = format!("/api/v1/sessions/{}/state", game.id);
    let (status, _, body) = send(
        &app,
        "GET",
        &format!("{uri}?role=FACTORY"),
        &[("cookie", &game.players[3].2)],
        "",
    )
    .await?;
    assert_eq!(
        (status, body.get("code")),
        (StatusCode::FORBIDDEN, Some(&json!("app.unauthorized")))
    );
    assert!(body.get("roleStatus").is_none() && body.get("inventory").is_none());
    // 自分の役割の指定は通る
    let (status, _, _) = send(
        &app,
        "GET",
        &format!("{uri}?role=RETAILER"),
        &[("cookie", &game.players[3].2)],
        "",
    )
    .await?;
    assert_eq!(status, StatusCode::OK);
    // 役割の 4 値以外は 422
    let (status, _, body) = send(
        &app,
        "GET",
        &format!("{uri}?role=BOSS"),
        &[("cookie", &game.players[3].2)],
        "",
    )
    .await?;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(body.pointer("/errors/0/field"), Some(&json!("role")));
    Ok(())
}

#[tokio::test]
async fn ac2_3_5__進行役には全役割の状況と確定した週の役割別の結果を返す() -> Result<(), String> {
    let Some(env) = start().await? else {
        return Ok(());
    };
    let app = app(env.pool.clone());
    let game = prepared(&app, &env.pool).await?;
    started(&app, &game).await?;
    let commit = json!({"requestedWeek": 1, "basis": {"FACTORY": 1, "DISTRIBUTOR": 1, "WHOLESALER": 1, "RETAILER": 1}}).to_string();
    let (status, _, _) = send(
        &app,
        "POST",
        &format!("/api/v1/sessions/{}/weeks/1/commit", game.id),
        &[("cookie", &game.facilitator), ("idempotency-key", "c")],
        &commit,
    )
    .await?;
    assert_eq!(status, StatusCode::OK);
    let (status, _, body) = send(
        &app,
        "GET",
        &format!("/api/v1/sessions/{}/state", game.id),
        &[("cookie", &game.facilitator)],
        "",
    )
    .await?;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body.get("week"), Some(&json!(2)));
    assert_eq!(body.get("finalWeek"), Some(&json!(2)));
    assert_eq!(
        body.pointer("/roles")
            .and_then(|r| r.as_object())
            .map(|r| r.len()),
        Some(4)
    );
    let results = body
        .get("results")
        .and_then(|r| r.as_array())
        .ok_or("results が無い")?;
    assert_eq!(results.len(), 4);
    let retailer = results
        .iter()
        .find(|r| r.get("role") == Some(&json!("RETAILER")))
        .ok_or("小売店の結果が無い")?;
    // 小売店: 需要 4、発注 9、在庫 12 + 4 - 4 = 12、費用 600（キット準拠。BR-09）
    for (k, v) in [
        ("week", 1),
        ("orders", 4),
        ("order", 9),
        ("inventory", 12),
        ("backlog", 0),
        ("shipment", 4),
        ("cost", 600),
        ("cumulativeCost", 600),
    ] {
        assert_eq!(retailer.get(k), Some(&json!(v)), "{k}");
    }
    Ok(())
}

#[tokio::test]
async fn ac2_1_1__開始前の進行の状態は_409_資格が無ければ_403() -> Result<(), String> {
    let Some(env) = start().await? else {
        return Ok(());
    };
    let app = app(env.pool.clone());
    let game = prepared(&app, &env.pool).await?;
    let uri = format!("/api/v1/sessions/{}/state", game.id);
    let (status, _, body) = send(&app, "GET", &uri, &[("cookie", &game.facilitator)], "").await?;
    assert_eq!(
        (status, body.get("code")),
        (StatusCode::CONFLICT, Some(&json!("session.not_active")))
    );
    let (status, _, _) = send(&app, "GET", &uri, &[], "").await?;
    assert_eq!(status, StatusCode::FORBIDDEN);
    Ok(())
}

#[tokio::test]
async fn ac1_2_1__ゲームの状態は_進行役に参加コードと最終週_参加者に自分の_ID_と役割を返す()
-> Result<(), String> {
    let Some(env) = start().await? else {
        return Ok(());
    };
    let app = app(env.pool.clone());
    let game = prepared(&app, &env.pool).await?;
    let uri = format!("/api/v1/games/{}/state", game.id);
    let (status, _, body) = send(&app, "GET", &uri, &[("cookie", &game.facilitator)], "").await?;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        (
            body.get("status"),
            body.get("sessionId"),
            body.get("finalWeek")
        ),
        (
            Some(&json!("PREPARING")),
            Some(&json!(null)),
            Some(&json!(2))
        )
    );
    assert!(
        body.get("joinCode")
            .and_then(|c| c.as_str())
            .is_some_and(|c| c.len() >= 8)
    );
    assert_eq!(
        body.pointer("/versions/game"),
        Some(&json!(9)),
        "作成 1 + 参加 4 + 割り当て 4"
    );
    let (_, _, body) = send(&app, "GET", &uri, &[("cookie", &game.players[0].2)], "").await?;
    assert_eq!(body.get("role"), Some(&json!("FACTORY")));
    assert_eq!(body.get("participantId"), Some(&json!(game.players[0].1)));
    assert!(body.get("joinCode").is_none(), "参加コードは進行役だけ");
    started(&app, &game).await?;
    let (_, _, body) = send(&app, "GET", &uri, &[("cookie", &game.facilitator)], "").await?;
    assert_eq!(
        (body.get("status"), body.get("sessionId")),
        (Some(&json!("STARTED")), Some(&json!(game.id)))
    );
    Ok(())
}

#[tokio::test]
async fn ac2_1_2__別のゲームの資格では状態を取得できない() -> Result<(), String> {
    let Some(env) = start().await? else {
        return Ok(());
    };
    let app = app(env.pool.clone());
    let a = prepared(&app, &env.pool).await?;
    let (status, headers, _) = send(
        &app,
        "POST",
        "/api/v1/games",
        &[],
        &json!({"finalWeek": 2, "demand": [4, 4]}).to_string(),
    )
    .await?;
    assert_eq!(status, StatusCode::CREATED);
    let other = support::api::cookie_of(&headers)?;
    let (status, _, body) = send(
        &app,
        "GET",
        &format!("/api/v1/games/{}/state", a.id),
        &[("cookie", &other)],
        "",
    )
    .await?;
    assert_eq!(
        (status, body.get("code")),
        (StatusCode::FORBIDDEN, Some(&json!("app.unauthorized")))
    );
    Ok(())
}
