// 理由: RT1 の命名（承認済み）の `__` を使うため。
#![allow(non_snake_case)]

//! 復帰・資格の失効と再発行（US3.2）。HTTP 越しに、復帰資格とブラウザセッションの分離、失効、復帰を確かめる。実 PostgreSQL 18.6。

use axum::Router;
use axum::http::{HeaderMap, StatusCode};
use serde_json::{Value, json};

mod support;
use support::api::{app, cookie_of, e, send};
use support::start;

struct Created {
    id: String,
    session: String,
    recovery: String,
    code: String,
}

fn recovery_of(headers: &HeaderMap) -> Result<String, String> {
    headers
        .get_all("set-cookie")
        .iter()
        .filter_map(|v| v.to_str().ok())
        .find_map(|v| v.strip_prefix("bg_recovery="))
        .and_then(|v| v.split(';').next())
        .map(str::to_owned)
        .ok_or_else(|| "復帰資格の Cookie が無い".to_owned())
}

async fn create(app: &Router) -> Result<Created, String> {
    let (status, headers, body) = send(
        app,
        "POST",
        "/api/v1/games",
        &[],
        &json!({"kind": "KIT", "finalWeek": 2, "demand": [4, 4]}).to_string(),
    )
    .await?;
    assert_eq!(status, StatusCode::CREATED);
    let id = headers
        .get("location")
        .and_then(|v| v.to_str().ok())
        .map(|l| {
            l.trim_start_matches("/api/v1/games/")
                .trim_end_matches("/state")
                .to_owned()
        })
        .ok_or("Location が無い")?;
    Ok(Created {
        id,
        session: cookie_of(&headers)?,
        recovery: recovery_of(&headers)?,
        code: body
            .get("recoveryCode")
            .and_then(Value::as_str)
            .ok_or("復帰コードが無い")?
            .to_owned(),
    })
}

async fn recover(
    app: &Router,
    game: &str,
    cookie: Option<&str>,
    code: Option<&str>,
) -> Result<(StatusCode, HeaderMap, Value), String> {
    let body = match code {
        Some(code) => json!({"gameId": game, "recoveryCode": code}),
        None => json!({"gameId": game}),
    };
    let headers: Vec<(&str, &str)> = cookie.map(|c| ("cookie", c)).into_iter().collect();
    send(
        app,
        "POST",
        "/api/v1/participations/recover",
        &headers,
        &body.to_string(),
    )
    .await
}

#[tokio::test]
async fn ac3_2_1__参加の応答はゲームの_ID_を含み_復帰すると同じゲームの参加者として戻る()
-> Result<(), String> {
    let Some(env) = start().await? else {
        return Ok(());
    };
    let app = app(env.pool.clone());
    let game = create(&app).await?;
    let code: String =
        sqlx::query_scalar("SELECT join_code FROM game_join_codes WHERE game_id = $1::uuid")
            .bind(&game.id)
            .fetch_one(&env.pool)
            .await
            .map_err(e)?;
    let (status, headers, body) = send(
        &app,
        "POST",
        "/api/v1/participations/join",
        &[],
        &json!({"joinCode": code, "displayName": "田中"}).to_string(),
    )
    .await?;
    assert_eq!(
        (status, body["gameId"].clone()),
        (StatusCode::OK, json!(game.id))
    );
    // 復帰資格（bg_recovery）とブラウザセッション（bg_session）は別の値
    let (session, recovery) = (cookie_of(&headers)?, recovery_of(&headers)?);
    assert_ne!(session.trim_start_matches("bg_session="), recovery);
    let (status, headers, body) = recover(
        &app,
        &game.id,
        Some(&format!("bg_recovery={recovery}")),
        None,
    )
    .await?;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(
        (body["gameId"].clone(), body["kind"].clone()),
        (json!(game.id), json!("PARTICIPANT"))
    );
    // 新しいブラウザセッションは、以前のものと違う
    assert_ne!(cookie_of(&headers)?, session);
    Ok(())
}

#[tokio::test]
async fn ac3_2_2__無効な復帰資格は_不明な資格と同じ_403_で_セッションを発行しない()
-> Result<(), String> {
    let Some(env) = start().await? else {
        return Ok(());
    };
    let app = app(env.pool.clone());
    let game = create(&app).await?;
    let (unknown_status, unknown_headers, unknown) =
        recover(&app, &game.id, Some("bg_recovery=unknown-credential"), None).await?;
    assert_eq!(unknown_status, StatusCode::FORBIDDEN);
    assert!(unknown_headers.get("set-cookie").is_none());
    // 期限切れ
    sqlx::query(
        "UPDATE credentials SET expires_at = now() - interval '1 day' WHERE game_id = $1::uuid",
    )
    .bind(&game.id)
    .execute(&env.pool)
    .await
    .map_err(e)?;
    let (status, headers, expired) = recover(&app, &game.id, None, Some(&game.code)).await?;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert!(headers.get("set-cookie").is_none());
    for key in ["type", "title", "status", "code"] {
        assert_eq!(expired[key], unknown[key], "{key}");
    }
    // 別のゲームの ID では、有効な復帰コードでも 403
    let other = create(&app).await?;
    let (status, _, _) = recover(&app, &other.id, None, Some(&game.code)).await?;
    assert_eq!(status, StatusCode::FORBIDDEN);
    Ok(())
}

#[tokio::test]
async fn ac3_2_3__古いタブの保存は_週が進んでいれば_WeekAdvanced_で拒否される() -> Result<(), String>
{
    let Some(env) = start().await? else {
        return Ok(());
    };
    let app = app(env.pool.clone());
    let game = support::api::prepared(&app, &env.pool).await?;
    let (status, _, _) = send(
        &app,
        "POST",
        &format!("/api/v1/games/{}/start", game.id),
        &[("cookie", &game.facilitator), ("idempotency-key", "s")],
        "",
    )
    .await?;
    assert_eq!(status, StatusCode::OK);
    // 週 1 の画面を見たまま、別のタブで確定された後の保存
    let uri = format!("/api/v1/sessions/{}/decisions", game.id);
    for (i, (_, _, cookie)) in game.players.iter().enumerate() {
        let (status, _, _) = send(
            &app,
            "PUT",
            &uri,
            &[("cookie", cookie), ("idempotency-key", &format!("k{i}"))],
            &json!({"week": 1, "quantity": 4}).to_string(),
        )
        .await?;
        assert_eq!(status, StatusCode::OK);
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
    let (status, _, body) = send(
        &app,
        "PUT",
        &uri,
        &[
            ("cookie", &game.players[3].2),
            ("idempotency-key", "stale"),
            ("if-match", "1"),
        ],
        &json!({"week": 1, "quantity": 9}).to_string(),
    )
    .await?;
    assert_eq!(
        (status, body["code"].clone(), body["currentWeek"].clone()),
        (
            StatusCode::CONFLICT,
            json!("session.week_advanced"),
            json!(2)
        )
    );
    Ok(())
}

#[tokio::test]
async fn ac3_2_4__進行役は作成時に控えた復帰コードでも_復帰資格の_Cookie_でも戻れる()
-> Result<(), String> {
    let Some(env) = start().await? else {
        return Ok(());
    };
    let app = app(env.pool.clone());
    let game = create(&app).await?;
    assert_eq!(game.code, game.recovery);
    for (cookie, code) in [
        (Some(format!("bg_recovery={}", game.recovery)), None),
        (None, Some(game.code.as_str())),
    ] {
        let (status, headers, body) = recover(&app, &game.id, cookie.as_deref(), code).await?;
        assert_eq!(
            (status, body["kind"].clone()),
            (StatusCode::OK, json!("FACILITATOR"))
        );
        let session = cookie_of(&headers)?;
        let (status, _, state) = send(
            &app,
            "GET",
            &format!("/api/v1/games/{}/state", game.id),
            &[("cookie", &session)],
            "",
        )
        .await?;
        assert_eq!(
            (status, state["gameId"].clone()),
            (StatusCode::OK, json!(game.id))
        );
    }
    // 以前のブラウザセッションも、復帰したあとも使える
    let (status, _, _) = send(
        &app,
        "GET",
        &format!("/api/v1/games/{}/state", game.id),
        &[("cookie", &game.session)],
        "",
    )
    .await?;
    assert_eq!(status, StatusCode::OK);
    Ok(())
}

#[tokio::test]
async fn ac3_2_5__失効するとセッションも復帰も使えず_再発行した復帰コードで戻れる()
-> Result<(), String> {
    let Some(env) = start().await? else {
        return Ok(());
    };
    let app = app(env.pool.clone());
    let game = create(&app).await?;
    let code: String =
        sqlx::query_scalar("SELECT join_code FROM game_join_codes WHERE game_id = $1::uuid")
            .bind(&game.id)
            .fetch_one(&env.pool)
            .await
            .map_err(e)?;
    let (_, headers, _) = send(
        &app,
        "POST",
        "/api/v1/participations/join",
        &[],
        &json!({"joinCode": code, "displayName": "田中"}).to_string(),
    )
    .await?;
    let (session, recovery) = (cookie_of(&headers)?, recovery_of(&headers)?);
    let pid: String = sqlx::query_scalar(
        "SELECT participant_id::text FROM lobby_participants WHERE game_id = $1::uuid",
    )
    .bind(&game.id)
    .fetch_one(&env.pool)
    .await
    .map_err(e)?;
    let subject = json!({"subject": {"kind": "PARTICIPANT", "id": pid}}).to_string();
    let uri = |action: &str| format!("/api/v1/games/{}/credentials/{action}", game.id);
    // 失効していない再発行は拒否
    let (status, _, body) = send(
        &app,
        "POST",
        &uri("reissue"),
        &[("cookie", &game.session), ("idempotency-key", "r0")],
        &subject,
    )
    .await?;
    assert_eq!(
        (status, body["code"].clone()),
        (StatusCode::CONFLICT, json!("game.credential_not_revoked"))
    );
    let (status, _, _) = send(
        &app,
        "POST",
        &uri("revoke"),
        &[("cookie", &game.session), ("idempotency-key", "v1")],
        &subject,
    )
    .await?;
    assert_eq!(status, StatusCode::OK);
    // 失効後は、ブラウザセッションも復帰資格も使えない
    let (status, _, _) = send(
        &app,
        "GET",
        &format!("/api/v1/games/{}/state", game.id),
        &[("cookie", &session)],
        "",
    )
    .await?;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, _, _) = recover(
        &app,
        &game.id,
        Some(&format!("bg_recovery={recovery}")),
        None,
    )
    .await?;
    assert_eq!(status, StatusCode::FORBIDDEN);
    // 再発行すると、新しい復帰コードで戻れる。古い復帰資格は使えないまま
    let (status, _, body) = send(
        &app,
        "POST",
        &uri("reissue"),
        &[("cookie", &game.session), ("idempotency-key", "r1")],
        &subject,
    )
    .await?;
    assert_eq!(status, StatusCode::OK, "{body}");
    let new_code = body["recoveryCode"].as_str().ok_or("復帰コードが無い")?;
    assert!(
        body["expiresAt"]
            .as_str()
            .is_some_and(|t| t.ends_with('Z') && t.len() == 24)
    );
    let (status, _, _) = recover(&app, &game.id, None, Some(new_code)).await?;
    assert_eq!(status, StatusCode::OK);
    let (status, _, _) = recover(
        &app,
        &game.id,
        Some(&format!("bg_recovery={recovery}")),
        None,
    )
    .await?;
    assert_eq!(status, StatusCode::FORBIDDEN);
    Ok(())
}

#[tokio::test]
async fn nf_s11__復帰の失敗が上限を超えると_有効な復帰コードでも_429_で_成功は数えない()
-> Result<(), String> {
    let Some(env) = start().await? else {
        return Ok(());
    };
    let app = app(env.pool.clone());
    let game = create(&app).await?;
    // 成功した復帰は、上限を超えて繰り返しても数えない
    for _ in 0..12 {
        let (status, _, _) = recover(&app, &game.id, None, Some(&game.code)).await?;
        assert_eq!(status, StatusCode::OK);
    }
    for _ in 0..10 {
        let (status, _, _) = recover(&app, &game.id, None, Some("wrong-code")).await?;
        assert_eq!(status, StatusCode::FORBIDDEN);
    }
    let (status, headers, body) = recover(&app, &game.id, None, Some(&game.code)).await?;
    assert_eq!(
        (status, body["code"].clone()),
        (StatusCode::TOO_MANY_REQUESTS, json!("app.rate_limited"))
    );
    let retry: u32 = headers
        .get("retry-after")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse().ok())
        .ok_or("Retry-After が無い")?;
    assert!((1..=600).contains(&retry));
    // 接続元が違えば、別の窓
    let (status, _, _) = send(
        &app,
        "POST",
        "/api/v1/participations/recover",
        &[("x-forwarded-for", "203.0.113.9")],
        &json!({"gameId": game.id, "recoveryCode": game.code}).to_string(),
    )
    .await?;
    assert_eq!(status, StatusCode::OK);
    Ok(())
}

#[tokio::test]
async fn nf_s5__資格を運ぶ応答は暗号化して保存し_同じキーの再送には同じ値を返す()
-> Result<(), String> {
    let Some(env) = start().await? else {
        return Ok(());
    };
    let app = app(env.pool.clone());
    let body = json!({"kind": "KIT", "finalWeek": 2, "demand": [4, 4]}).to_string();
    let first = send(
        &app,
        "POST",
        "/api/v1/games",
        &[("idempotency-key", "create-1")],
        &body,
    )
    .await?;
    let again = send(
        &app,
        "POST",
        "/api/v1/games",
        &[("idempotency-key", "create-1")],
        &body,
    )
    .await?;
    assert_eq!(
        (first.0, again.0),
        (StatusCode::CREATED, StatusCode::CREATED)
    );
    assert_eq!(first.2, again.2, "同じ復帰コード");
    assert_eq!(cookie_of(&first.1)?, cookie_of(&again.1)?);
    assert_eq!(first.1.get("location"), again.1.get("location"));
    // 内容が違えば 409
    let other = json!({"kind": "KIT", "finalWeek": 3, "demand": [4, 4, 4]}).to_string();
    let (status, _, problem) = send(
        &app,
        "POST",
        "/api/v1/games",
        &[("idempotency-key", "create-1")],
        &other,
    )
    .await?;
    assert_eq!(
        (status, problem["code"].clone()),
        (StatusCode::CONFLICT, json!("app.idempotency_key_reused"))
    );
    let games: i64 = sqlx::query_scalar("SELECT count(*) FROM game_roots")
        .fetch_one(&env.pool)
        .await
        .map_err(e)?;
    assert_eq!(games, 1);
    // 保存した応答に、復帰コードの平文が無い
    let recovery = first.2["recoveryCode"].as_str().ok_or("復帰コードが無い")?;
    let stored: Vec<u8> =
        sqlx::query_scalar("SELECT response FROM idempotency_records WHERE scope = 'create'")
            .fetch_one(&env.pool)
            .await
            .map_err(e)?;
    assert!(!String::from_utf8_lossy(&stored).contains(recovery));
    assert!(stored.len() > 12 + 16, "ノンスと認証タグを含む");
    Ok(())
}

#[tokio::test]
async fn nf_s5__参加と再発行も_同じキーの再送には同じ資格_同じ復帰コードを返す()
-> Result<(), String> {
    let Some(env) = start().await? else {
        return Ok(());
    };
    let app = app(env.pool.clone());
    let game = create(&app).await?;
    let code: String =
        sqlx::query_scalar("SELECT join_code FROM game_join_codes WHERE game_id = $1::uuid")
            .bind(&game.id)
            .fetch_one(&env.pool)
            .await
            .map_err(e)?;
    let join_body = json!({"joinCode": code, "displayName": "田中"}).to_string();
    let first = send(
        &app,
        "POST",
        "/api/v1/participations/join",
        &[("idempotency-key", "join-1")],
        &join_body,
    )
    .await?;
    let again = send(
        &app,
        "POST",
        "/api/v1/participations/join",
        &[("idempotency-key", "join-1")],
        &join_body,
    )
    .await?;
    assert_eq!((first.0, again.0), (StatusCode::OK, StatusCode::OK));
    assert_eq!(cookie_of(&first.1)?, cookie_of(&again.1)?);
    assert_eq!(recovery_of(&first.1)?, recovery_of(&again.1)?);
    let participants: i64 =
        sqlx::query_scalar("SELECT count(*) FROM lobby_participants WHERE game_id = $1::uuid")
            .bind(&game.id)
            .fetch_one(&env.pool)
            .await
            .map_err(e)?;
    assert_eq!(participants, 1, "再送で参加者は増えない");
    // 失効 → 再発行（同じキーで再送すると、同じ復帰コード）
    let pid: String = sqlx::query_scalar(
        "SELECT participant_id::text FROM lobby_participants WHERE game_id = $1::uuid",
    )
    .bind(&game.id)
    .fetch_one(&env.pool)
    .await
    .map_err(e)?;
    let subject = json!({"subject": {"kind": "PARTICIPANT", "id": pid}}).to_string();
    let uri = |action: &str| format!("/api/v1/games/{}/credentials/{action}", game.id);
    send(
        &app,
        "POST",
        &uri("revoke"),
        &[("cookie", &game.session), ("idempotency-key", "rv")],
        &subject,
    )
    .await?;
    let reissue_headers = [("cookie", game.session.as_str()), ("idempotency-key", "ri")];
    let r1 = send(&app, "POST", &uri("reissue"), &reissue_headers, &subject).await?;
    let r2 = send(&app, "POST", &uri("reissue"), &reissue_headers, &subject).await?;
    assert_eq!((r1.0, r2.0), (StatusCode::OK, StatusCode::OK), "{:?}", r2.2);
    assert_eq!(r1.2["recoveryCode"], r2.2["recoveryCode"]);
    assert_eq!(r1.2["expiresAt"], r2.2["expiresAt"]);
    Ok(())
}
