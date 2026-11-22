// 理由: RT1 の命名（承認済み）の `__` を使うため。
#![allow(non_snake_case)]

//! 契約テスト。共有する `contracts/openapi.yaml`（変更しない）のスキーマで、実際の応答を検証する。実 PostgreSQL 18.6。

use std::path::Path;

use axum::Router;
use axum::http::StatusCode;
use serde_json::{Value, json};

mod support;
use support::api::{Game, app, cookie_of, e, prepared, send};
use support::start;

fn contract() -> Result<Value, String> {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../beer-game-kotlin/contracts/openapi.yaml");
    let text =
        std::fs::read_to_string(&path).map_err(|err| format!("{}: {err}", path.display()))?;
    serde_saphyr::from_str::<Value>(&text).map_err(e)
}

/// `components.schemas.<name>` で、応答を検証する。違反は、すべて集めて返す。
fn validate(doc: &Value, name: &str, instance: &Value) -> Result<(), String> {
    let schema = json!({
        "$ref": format!("#/components/schemas/{name}"),
        "components": doc.get("components").cloned().ok_or("components が無い")?,
    });
    let validator = jsonschema::validator_for(&schema).map_err(e)?;
    let errors: Vec<String> = validator
        .iter_errors(instance)
        .map(|err| format!("{err} （{}）", err.instance_path()))
        .collect();
    if errors.is_empty() {
        Ok(())
    } else {
        Err(format!("{name} に違反: {errors:?}\n応答: {instance}"))
    }
}

async fn started(app: &Router, pool: &sqlx::PgPool) -> Result<Game, String> {
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

#[tokio::test]
async fn tech__契約のスキーマが読み込め_参照を解決できる() -> Result<(), String> {
    let doc = contract()?;
    for name in [
        "CommandResponse",
        "SessionState",
        "GameState",
        "Review",
        "Problem",
    ] {
        let schema = json!({"$ref": format!("#/components/schemas/{name}"), "components": doc.get("components")});
        jsonschema::validator_for(&schema).map_err(e)?;
    }
    Ok(())
}

#[tokio::test]
async fn tech__作成_参加_復帰_失効_再発行の応答は契約のスキーマに適合する() -> Result<(), String> {
    let Some(env) = start().await? else {
        return Ok(());
    };
    let doc = contract()?;
    let app = app(env.pool.clone());
    let (status, headers, created) = send(
        &app,
        "POST",
        "/api/v1/games",
        &[],
        &json!({"kind": "KIT", "finalWeek": 2, "demand": [4, 4]}).to_string(),
    )
    .await?;
    assert_eq!(status, StatusCode::CREATED);
    validate(&doc, "CreateGameResponse", &created)?;
    let facilitator = cookie_of(&headers)?;
    let game_id = headers
        .get("location")
        .and_then(|v| v.to_str().ok())
        .map(|l| {
            l.trim_start_matches("/api/v1/games/")
                .trim_end_matches("/state")
                .to_owned()
        })
        .ok_or("Location が無い")?;
    let code: String =
        sqlx::query_scalar("SELECT join_code FROM game_join_codes WHERE game_id = $1::uuid")
            .bind(&game_id)
            .fetch_one(&env.pool)
            .await
            .map_err(e)?;
    let (_, _, joined) = send(
        &app,
        "POST",
        "/api/v1/participations/join",
        &[],
        &json!({"joinCode": code, "displayName": "田中"}).to_string(),
    )
    .await?;
    validate(&doc, "JoinResponse", &joined)?;
    let (status, _, recovered) = send(
        &app,
        "POST",
        "/api/v1/participations/recover",
        &[],
        &json!({"gameId": game_id, "recoveryCode": created["recoveryCode"]}).to_string(),
    )
    .await?;
    assert_eq!(status, StatusCode::OK);
    validate(&doc, "RecoverResponse", &recovered)?;
    let pid: String = sqlx::query_scalar(
        "SELECT participant_id::text FROM lobby_participants WHERE game_id = $1::uuid",
    )
    .bind(&game_id)
    .fetch_one(&env.pool)
    .await
    .map_err(e)?;
    let subject = json!({"subject": {"kind": "PARTICIPANT", "id": pid}}).to_string();
    let uri = |a: &str| format!("/api/v1/games/{game_id}/credentials/{a}");
    let (status, _, revoked) = send(
        &app,
        "POST",
        &uri("revoke"),
        &[("cookie", &facilitator), ("idempotency-key", "r")],
        &subject,
    )
    .await?;
    assert_eq!(status, StatusCode::OK);
    validate(&doc, "CommandResponse", &revoked)?;
    let (status, _, reissued) = send(
        &app,
        "POST",
        &uri("reissue"),
        &[("cookie", &facilitator), ("idempotency-key", "i")],
        &subject,
    )
    .await?;
    assert_eq!(status, StatusCode::OK);
    validate(&doc, "ReissueResponse", &reissued)?;
    // 失効済みの再失効は、problem+json（409）
    let (status, _, problem) = send(
        &app,
        "POST",
        &uri("reissue"),
        &[("cookie", &facilitator), ("idempotency-key", "j")],
        &subject,
    )
    .await?;
    assert_eq!(status, StatusCode::CONFLICT);
    validate(&doc, "Problem", &problem)?;
    Ok(())
}

#[tokio::test]
async fn tech__進行の状態_停止_代理入力_確定_振り返りの応答は契約のスキーマに適合する()
-> Result<(), String> {
    let Some(env) = start().await? else {
        return Ok(());
    };
    let doc = contract()?;
    let app = app(env.pool.clone());
    let game = started(&app, &env.pool).await?;
    // 状態（進行役・参加者・ゲーム）
    let get = |uri: String, cookie: String| {
        let app = app.clone();
        async move { send(&app, "GET", &uri, &[("cookie", &cookie)], "").await }
    };
    let (_, _, facilitator_state) = get(
        format!("/api/v1/sessions/{}/state", game.id),
        game.facilitator.clone(),
    )
    .await?;
    validate(&doc, "SessionState", &facilitator_state)?;
    let (_, _, participant_state) = get(
        format!("/api/v1/sessions/{}/state", game.id),
        game.players[3].2.clone(),
    )
    .await?;
    validate(&doc, "SessionState", &participant_state)?;
    let (_, _, game_state) = get(
        format!("/api/v1/games/{}/state", game.id),
        game.facilitator.clone(),
    )
    .await?;
    validate(&doc, "GameState", &game_state)?;
    // 停止・代理入力・再開
    for (action, key) in [("pause", "p"), ("resume", "r")] {
        let (status, _, body) = send(
            &app,
            "POST",
            &format!("/api/v1/sessions/{}/{action}", game.id),
            &[("cookie", &game.facilitator), ("idempotency-key", key)],
            "",
        )
        .await?;
        assert_eq!(status, StatusCode::OK);
        validate(&doc, "CommandResponse", &body)?;
    }
    let (status, _, body) = send(
        &app,
        "PUT",
        &format!("/api/v1/sessions/{}/proxy-decisions/FACTORY", game.id),
        &[("cookie", &game.facilitator), ("idempotency-key", "x")],
        &json!({"requestedWeek": 1, "quantity": 6}).to_string(),
    )
    .await?;
    assert_eq!(status, StatusCode::OK);
    validate(&doc, "CommandResponse", &body)?;
    // 保存者つきの状態（進行役の代理入力）
    let (_, _, after) = get(
        format!("/api/v1/sessions/{}/state", game.id),
        game.facilitator.clone(),
    )
    .await?;
    validate(&doc, "SessionState", &after)?;
    // 競合の problem（古い版での保存）
    let (status, _, conflict) = send(
        &app,
        "PUT",
        &format!("/api/v1/sessions/{}/decisions", game.id),
        &[
            ("cookie", &game.players[0].2),
            ("idempotency-key", "c"),
            ("if-match", "0"),
        ],
        &json!({"week": 1, "quantity": 9}).to_string(),
    )
    .await?;
    assert_eq!(status, StatusCode::CONFLICT);
    validate(&doc, "ConflictProblemBody", &conflict)?;
    // 全員が入力して確定 → 終了 → 振り返り
    for (i, (_, _, cookie)) in game.players.iter().enumerate().skip(1) {
        let (status, _, _) = send(
            &app,
            "PUT",
            &format!("/api/v1/sessions/{}/decisions", game.id),
            &[
                ("cookie", cookie),
                ("idempotency-key", &format!("d{i}")),
                ("if-match", "0"),
            ],
            &json!({"week": 1, "quantity": 4}).to_string(),
        )
        .await?;
        assert_eq!(status, StatusCode::OK);
    }
    let basis = json!({"FACTORY": 1, "DISTRIBUTOR": 1, "WHOLESALER": 1, "RETAILER": 1});
    for week in 1..=2 {
        if week == 2 {
            for (i, (_, _, cookie)) in game.players.iter().enumerate() {
                send(
                    &app,
                    "PUT",
                    &format!("/api/v1/sessions/{}/decisions", game.id),
                    &[
                        ("cookie", cookie),
                        ("idempotency-key", &format!("w{i}")),
                        ("if-match", "0"),
                    ],
                    &json!({"week": 2, "quantity": 4}).to_string(),
                )
                .await?;
            }
        }
        let (status, _, body) = send(
            &app,
            "POST",
            &format!("/api/v1/sessions/{}/weeks/{week}/commit", game.id),
            &[
                ("cookie", &game.facilitator),
                ("idempotency-key", &format!("c{week}")),
            ],
            &json!({"requestedWeek": week, "basis": basis}).to_string(),
        )
        .await?;
        assert_eq!(status, StatusCode::OK, "{body}");
        validate(&doc, "CommandResponse", &body)?;
    }
    let (status, _, review) = get(
        format!("/api/v1/games/{}/review", game.id),
        game.facilitator.clone(),
    )
    .await?;
    assert_eq!(status, StatusCode::OK);
    validate(&doc, "Review", &review)?;
    Ok(())
}

#[tokio::test]
async fn tech__カスタム条件で作成したゲームの状態は契約のスキーマに適合し_種別と変更した項目を示す()
-> Result<(), String> {
    let Some(env) = start().await? else {
        return Ok(());
    };
    let doc = contract()?;
    let app = app(env.pool.clone());
    let body = json!({
        "kind": "CUSTOM", "finalWeek": 2, "demand": [4, 4],
        "conditions": {"initialInventory": {"RETAILER": 20}, "shipmentDelayWeeks": 3, "disclosurePolicy": "NONE"},
    });
    let (status, headers, created) =
        send(&app, "POST", "/api/v1/games", &[], &body.to_string()).await?;
    assert_eq!(status, StatusCode::CREATED, "{created}");
    validate(&doc, "CreateGameResponse", &created)?;
    let id = headers
        .get("location")
        .and_then(|v| v.to_str().ok())
        .map(|l| {
            l.trim_start_matches("/api/v1/games/")
                .trim_end_matches("/state")
                .to_owned()
        })
        .ok_or("Location が無い")?;
    let (_, _, state) = send(
        &app,
        "GET",
        &format!("/api/v1/games/{id}/state"),
        &[("cookie", &cookie_of(&headers)?)],
        "",
    )
    .await?;
    validate(&doc, "GameState", &state)?;
    assert_eq!(state["settingsKind"], json!("CUSTOM"));
    assert_eq!(
        state["changedSettings"],
        json!(["INITIAL_INVENTORY", "SHIPMENT_DELAY", "DISCLOSURE"])
    );
    // 範囲外は、項目ごとに集めた 422（契約の ValidationProblemBody）
    let bad = json!({
        "kind": "CUSTOM", "finalWeek": 2, "demand": [4, 4],
        "conditions": {"shipmentDelayWeeks": 0, "holdingCostMinor": -1},
    });
    let (status, _, problem) = send(&app, "POST", "/api/v1/games", &[], &bad.to_string()).await?;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    validate(&doc, "ValidationProblemBody", &problem)?;
    Ok(())
}

#[tokio::test]
async fn tech__観察者の招待_参加_観察画面_ロビーの応答は契約のスキーマに適合する()
-> Result<(), String> {
    let Some(env) = start().await? else {
        return Ok(());
    };
    let doc = contract()?;
    let app = app(env.pool.clone());
    let game = started(&app, &env.pool).await?;
    let (status, _, invite) = send(
        &app,
        "POST",
        &format!("/api/v1/games/{}/observer-invitations", game.id),
        &[("cookie", &game.facilitator), ("idempotency-key", "i")],
        "{}",
    )
    .await?;
    assert_eq!(status, StatusCode::OK);
    validate(&doc, "InviteObserverResponse", &invite)?;
    let (status, headers, joined) = send(
        &app,
        "POST",
        "/api/v1/participations/observe",
        &[],
        &json!({"invitationCode": invite.get("invitationCode"), "displayName": "見学者"})
            .to_string(),
    )
    .await?;
    assert_eq!(status, StatusCode::OK);
    validate(&doc, "JoinObserverResponse", &joined)?;
    let cookie = cookie_of(&headers)?;
    let (_, _, observation) = send(
        &app,
        "GET",
        &format!("/api/v1/games/{}/observation", game.id),
        &[("cookie", &cookie)],
        "",
    )
    .await?;
    validate(&doc, "Observation", &observation)?;
    let (_, _, lobby) = send(
        &app,
        "GET",
        &format!("/api/v1/games/{}/lobby", game.id),
        &[("cookie", &game.facilitator)],
        "",
    )
    .await?;
    validate(&doc, "Lobby", &lobby)?;
    // 不明な招待コードは、区別しない 403（problem）
    let (status, _, problem) = send(
        &app,
        "POST",
        "/api/v1/participations/observe",
        &[],
        &json!({"invitationCode": "unknown", "displayName": "x"}).to_string(),
    )
    .await?;
    assert_eq!(status, StatusCode::FORBIDDEN);
    validate(&doc, "Problem", &problem)?;
    Ok(())
}
