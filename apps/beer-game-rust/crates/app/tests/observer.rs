// 理由: RT1 の命名（承認済み）の `__` を使うため。
#![allow(non_snake_case)]

//! 観察者（US1.3・US4.1）。HTTP 越しに、招待・参加・観察画面・開示と権限を確かめる。実 PostgreSQL 18.6。

use axum::Router;
use axum::http::StatusCode;
use serde_json::{Value, json};

mod support;
use support::api::{Game, app, cookie_of, e, prepared, send};
use support::start;

async fn started(
    app: &Router,
    pool: &sqlx::PgPool,
    disclosure: Option<&str>,
) -> Result<Game, String> {
    let game = match disclosure {
        None => prepared(app, pool).await?,
        Some(policy) => {
            // 公開範囲を変えたゲーム（prepared と同じ手順を、作成の本文だけ変えて行う）
            let body = json!({"kind": "CUSTOM", "finalWeek": 2, "demand": [4, 4],
                "conditions": {"disclosurePolicy": policy}});
            support::api::prepared_with(app, pool, &body).await?
        }
    };
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

/// 招待を発行し、観察者として参加する。（招待の ID・招待コード・観察者の Cookie）
async fn observer(app: &Router, game: &Game) -> Result<(String, String, String), String> {
    let (status, _, invite) = send(
        app,
        "POST",
        &format!("/api/v1/games/{}/observer-invitations", game.id),
        &[("cookie", &game.facilitator), ("idempotency-key", "i")],
        "{}",
    )
    .await?;
    assert_eq!(status, StatusCode::OK, "{invite}");
    let id = invite
        .get("invitationId")
        .and_then(Value::as_str)
        .ok_or("招待の ID が無い")?
        .to_owned();
    let code = invite
        .get("invitationCode")
        .and_then(Value::as_str)
        .ok_or("招待コードが無い")?
        .to_owned();
    let (status, headers, joined) = send(
        app,
        "POST",
        "/api/v1/participations/observe",
        &[],
        &json!({"invitationCode": code, "displayName": "見学者"}).to_string(),
    )
    .await?;
    assert_eq!(status, StatusCode::OK, "{joined}");
    Ok((id, code, cookie_of(&headers)?))
}

async fn observation(
    app: &Router,
    game: &Game,
    cookie: Option<&str>,
) -> Result<(StatusCode, Value), String> {
    let headers: Vec<(&str, &str)> = cookie.map(|c| ("cookie", c)).into_iter().collect();
    let (status, _, body) = send(
        app,
        "GET",
        &format!("/api/v1/games/{}/observation", game.id),
        &headers,
        "",
    )
    .await?;
    Ok((status, body))
}

#[tokio::test]
async fn ac1_3_2__進行役以外の招待の発行は_403_で_招待コードを含めない() -> Result<(), String> {
    let Some(env) = start().await? else {
        return Ok(());
    };
    let app = app(env.pool.clone());
    let game = started(&app, &env.pool, None).await?;
    for cookie in [Some(game.players[0].2.as_str()), None] {
        let headers: Vec<(&str, &str)> = cookie.map(|c| ("cookie", c)).into_iter().collect();
        let (status, _, body) = send(
            &app,
            "POST",
            &format!("/api/v1/games/{}/observer-invitations", game.id),
            &headers,
            "{}",
        )
        .await?;
        assert_eq!(status, StatusCode::FORBIDDEN);
        assert!(!body.to_string().contains("invitationCode"));
    }
    Ok(())
}

#[tokio::test]
async fn ac4_1_1__観察画面は現在週と入力済みの役割数と確定した週のチーム合計を返す()
-> Result<(), String> {
    let Some(env) = start().await? else {
        return Ok(());
    };
    let app = app(env.pool.clone());
    let game = started(&app, &env.pool, None).await?;
    let (_, _, cookie) = observer(&app, &game).await?;
    // 4 役割が入力して確定 → 第 2 週で 1 役割が入力
    let uri = format!("/api/v1/sessions/{}/decisions", game.id);
    for (i, (_, _, c)) in game.players.iter().enumerate() {
        send(
            &app,
            "PUT",
            &uri,
            &[
                ("cookie", c),
                ("idempotency-key", &format!("a{i}")),
                ("if-match", "0"),
            ],
            &json!({"week": 1, "quantity": 4}).to_string(),
        )
        .await?;
    }
    let basis = json!({"FACTORY": 1, "DISTRIBUTOR": 1, "WHOLESALER": 1, "RETAILER": 1});
    send(
        &app,
        "POST",
        &format!("/api/v1/sessions/{}/weeks/1/commit", game.id),
        &[("cookie", &game.facilitator), ("idempotency-key", "c")],
        &json!({"requestedWeek": 1, "basis": basis}).to_string(),
    )
    .await?;
    send(
        &app,
        "PUT",
        &uri,
        &[
            ("cookie", &game.players[3].2),
            ("idempotency-key", "b"),
            ("if-match", "0"),
        ],
        &json!({"week": 2, "quantity": 4}).to_string(),
    )
    .await?;
    let (status, body) = observation(&app, &game, Some(&cookie)).await?;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(
        (&body["week"], &body["submittedRoleCount"]),
        (&json!(2), &json!(1))
    );
    let week1 = &body["totals"]["weeks"][0];
    assert_eq!((&week1["week"], &week1["order"]), (&json!(1), &json!(16)));
    Ok(())
}

#[tokio::test]
async fn ac4_1_2__観察者は役割別の状況_ゲームの状態_ロビーを取得できず_観察画面に役割別の値を含めない()
-> Result<(), String> {
    let Some(env) = start().await? else {
        return Ok(());
    };
    let app = app(env.pool.clone());
    let game = started(&app, &env.pool, None).await?;
    let (_, _, cookie) = observer(&app, &game).await?;
    for uri in [
        format!("/api/v1/sessions/{}/state?role=RETAILER", game.id),
        format!("/api/v1/sessions/{}/state", game.id),
        format!("/api/v1/games/{}/state", game.id),
        format!("/api/v1/games/{}/lobby", game.id),
    ] {
        let (status, _, body) = send(&app, "GET", &uri, &[("cookie", &cookie)], "").await?;
        assert_eq!(status, StatusCode::FORBIDDEN, "{uri}");
        assert!(!body.to_string().contains(&game.id) || body.get("code").is_some());
    }
    let (status, body) = observation(&app, &game, Some(&cookie)).await?;
    assert_eq!(status, StatusCode::OK);
    let text = body.to_string();
    for banned in [
        "roles",
        "roleStatus",
        "results",
        "joinCode",
        "RETAILER",
        "demand",
    ] {
        assert!(!text.contains(banned), "{banned} が含まれている: {text}");
    }
    Ok(())
}

#[tokio::test]
async fn ac4_1_3__公開範囲がなしなら_合計を出さず_理由を示し_現在週は返す() -> Result<(), String> {
    let Some(env) = start().await? else {
        return Ok(());
    };
    let app = app(env.pool.clone());
    let game = started(&app, &env.pool, Some("NONE")).await?;
    let (_, _, cookie) = observer(&app, &game).await?;
    let (status, body) = observation(&app, &game, Some(&cookie)).await?;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["week"], json!(1));
    assert_eq!(body["totals"]["hiddenReason"], json!("DISCLOSURE_NONE"));
    assert_eq!(body["totals"]["weeks"], json!([]));
    Ok(())
}

#[tokio::test]
async fn ac4_1_4__観察画面は進行役と観察者だけが開ける() -> Result<(), String> {
    let Some(env) = start().await? else {
        return Ok(());
    };
    let app = app(env.pool.clone());
    let game = started(&app, &env.pool, None).await?;
    let other = started(&app, &env.pool, None).await?;
    let (_, _, cookie) = observer(&app, &game).await?;
    for denied in [
        None,
        Some(game.players[0].2.as_str()),
        Some(other.facilitator.as_str()),
    ] {
        let (status, _) = observation(&app, &game, denied).await?;
        assert_eq!(status, StatusCode::FORBIDDEN);
    }
    // 別のゲームの観察者の資格では、このゲームは開けない
    let (_, _, other_cookie) = observer(&app, &other).await?;
    let (status, _) = observation(&app, &game, Some(&other_cookie)).await?;
    assert_eq!(status, StatusCode::FORBIDDEN);
    for ok in [game.facilitator.as_str(), cookie.as_str()] {
        let (status, _) = observation(&app, &game, Some(ok)).await?;
        assert_eq!(status, StatusCode::OK);
    }
    Ok(())
}

#[tokio::test]
async fn ac4_1_5__観察者は入力_確定_停止_招待_失効_割り当てができない() -> Result<(), String> {
    let Some(env) = start().await? else {
        return Ok(());
    };
    let app = app(env.pool.clone());
    let game = started(&app, &env.pool, None).await?;
    let (_, _, cookie) = observer(&app, &game).await?;
    let basis = json!({"FACTORY": 0, "DISTRIBUTOR": 0, "WHOLESALER": 0, "RETAILER": 0});
    let pid: String = sqlx::query_scalar(
        "SELECT participant_id::text FROM lobby_participants WHERE game_id = $1::uuid LIMIT 1",
    )
    .bind(&game.id)
    .fetch_one(&env.pool)
    .await
    .map_err(e)?;
    type Call<'a> = (&'a str, String, String, Vec<(&'a str, &'a str)>);
    let calls: Vec<Call> = vec![
        (
            "PUT",
            format!("/api/v1/sessions/{}/decisions", game.id),
            json!({"week": 1, "quantity": 8}).to_string(),
            vec![("if-match", "0")],
        ),
        (
            "POST",
            format!("/api/v1/sessions/{}/weeks/1/commit", game.id),
            json!({"requestedWeek": 1, "basis": basis}).to_string(),
            vec![],
        ),
        (
            "POST",
            format!("/api/v1/sessions/{}/pause", game.id),
            String::new(),
            vec![],
        ),
        (
            "POST",
            format!("/api/v1/games/{}/observer-invitations", game.id),
            "{}".to_owned(),
            vec![],
        ),
        (
            "POST",
            format!("/api/v1/games/{}/credentials/revoke", game.id),
            json!({"subject": {"kind": "PARTICIPANT", "id": pid}}).to_string(),
            vec![],
        ),
        (
            "PUT",
            format!("/api/v1/games/{}/participants/{pid}/role", game.id),
            json!({"role": "RETAILER"}).to_string(),
            vec![],
        ),
    ];
    for (i, (method, uri, body, extra)) in calls.iter().enumerate() {
        let key = format!("o{i}");
        let mut headers = vec![
            ("cookie", cookie.as_str()),
            ("idempotency-key", key.as_str()),
        ];
        headers.extend(extra.iter().copied());
        let (status, _, _) = send(&app, method, uri, &headers, body).await?;
        assert_eq!(status, StatusCode::FORBIDDEN, "{method} {uri}");
    }
    Ok(())
}

#[tokio::test]
async fn ac1_3_4__失効した招待では参加できず_すでに参加した観察者は続けられる() -> Result<(), String>
{
    let Some(env) = start().await? else {
        return Ok(());
    };
    let app = app(env.pool.clone());
    let game = started(&app, &env.pool, None).await?;
    let (id, code, cookie) = observer(&app, &game).await?;
    let revoke = |actor: String, key: &'static str| {
        let app = app.clone();
        let uri = format!("/api/v1/games/{}/observer-invitations/{id}/revoke", game.id);
        async move {
            send(
                &app,
                "POST",
                &uri,
                &[("cookie", &actor), ("idempotency-key", key)],
                "",
            )
            .await
        }
    };
    let (status, _, _) = revoke(game.facilitator.clone(), "r1").await?;
    assert_eq!(status, StatusCode::OK);
    let (status, _, again) = revoke(game.facilitator.clone(), "r2").await?;
    assert_eq!(
        (status, again["code"].clone()),
        (
            StatusCode::CONFLICT,
            json!("game.credential_already_revoked")
        )
    );
    let (status, headers, body) = send(
        &app,
        "POST",
        "/api/v1/participations/observe",
        &[],
        &json!({"invitationCode": code, "displayName": "遅れた人"}).to_string(),
    )
    .await?;
    assert_eq!(
        (
            status,
            body["code"].clone(),
            headers.get("set-cookie").is_none()
        ),
        (
            StatusCode::FORBIDDEN,
            json!("game.invitation_invalid"),
            true
        )
    );
    let (status, _) = observation(&app, &game, Some(&cookie)).await?;
    assert_eq!(status, StatusCode::OK);
    // 招待コードは参加コードとしては使えない。ロビーに観察者が載り、参加者に含まれない
    let (status, _, lobby) = send(
        &app,
        "GET",
        &format!("/api/v1/games/{}/lobby", game.id),
        &[("cookie", &game.facilitator)],
        "",
    )
    .await?;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(lobby["observers"][0]["displayName"], json!("見学者"));
    assert_eq!(lobby["participants"].as_array().map(Vec::len), Some(4));
    Ok(())
}
