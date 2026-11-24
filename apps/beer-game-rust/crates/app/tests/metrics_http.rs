// 理由: RT1 の命名（承認済み）の `__` を使うため。
#![allow(non_snake_case)]

//! 要求ごとのメトリクス（AC6.1.3）。HTTP 越しに、EMF の元になる観測が出ること、秘密・表示名・識別子を含まないこと、
//! 操作名が `contracts/openapi.yaml` の operationId と一致することを確かめる。実 PostgreSQL 18.6。

use std::sync::{Arc, Mutex};

use axum::http::StatusCode;
use beergame_adapter_http::{OPERATIONS, UNMATCHED, emf_lines};
use beergame_application::{MetricSample, MetricSink, metric_names};
use serde_json::json;

mod support;
use support::api::{app_with_metrics, cookie_of, e, send};
use support::start;

/// 観測を捕まえる出力先。
#[derive(Default)]
struct Capture(Mutex<Vec<MetricSample>>);

impl MetricSink for Capture {
    fn record(&self, samples: &[MetricSample]) {
        if let Ok(mut all) = self.0.lock() {
            all.extend_from_slice(samples);
        }
    }
}

impl Capture {
    fn all(&self) -> Vec<MetricSample> {
        self.0.lock().map(|v| v.clone()).unwrap_or_default()
    }

    fn named(&self, name: &str, operation: &str) -> Vec<MetricSample> {
        self.all()
            .into_iter()
            .filter(|s| s.name == name && s.operation.as_deref() == Some(operation))
            .collect()
    }
}

#[tokio::test]
async fn ac6_1_3__要求を処理すると_応答時間と要求数と_5xx_のメトリクスが操作ごとに出る()
-> Result<(), String> {
    let Some(env) = start().await? else {
        return Ok(());
    };
    let capture = Arc::new(Capture::default());
    let app = app_with_metrics(env.pool.clone(), capture.clone());
    let (status, _, _) = send(&app, "GET", "/api/v1/health", &[], "").await?;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        capture
            .named(metric_names::REQUEST_COUNT, "getHealth")
            .len(),
        1
    );
    assert_eq!(
        capture
            .named(metric_names::REQUEST_DURATION_MILLIS, "getHealth")
            .len(),
        1
    );
    let server_error = capture.named(metric_names::SERVER_ERROR, "getHealth");
    assert_eq!(server_error.first().map(|s| s.value), Some(0.0));
    Ok(())
}

#[tokio::test]
async fn ac6_1_3__経路の実値はメトリクスに入らず_知らない経路は_unmatched_になる()
-> Result<(), String> {
    let Some(env) = start().await? else {
        return Ok(());
    };
    let capture = Arc::new(Capture::default());
    let app = app_with_metrics(env.pool.clone(), capture.clone());
    drop(
        send(
            &app,
            "GET",
            "/secret/00000000-0000-0000-0000-000000000009",
            &[],
            "",
        )
        .await?,
    );
    let operations: Vec<Option<String>> = capture.all().into_iter().map(|s| s.operation).collect();
    assert!(!operations.is_empty());
    assert!(operations.iter().all(|o| o.as_deref() == Some(UNMATCHED)));
    Ok(())
}

#[tokio::test]
async fn ac6_1_3__メトリクスの出力に_資格_表示名_ゲーム_ID_参加コードは含まれない()
-> Result<(), String> {
    let Some(env) = start().await? else {
        return Ok(());
    };
    let capture = Arc::new(Capture::default());
    let app = app_with_metrics(env.pool.clone(), capture.clone());
    let (status, headers, _) = send(
        &app,
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
        .ok_or("Location が無い")?
        .to_owned();
    let game_id = location
        .trim_start_matches("/api/v1/games/")
        .trim_end_matches("/state")
        .to_owned();
    let code: String =
        sqlx::query_scalar("SELECT join_code FROM game_join_codes WHERE game_id = $1::uuid")
            .bind(&game_id)
            .fetch_one(&env.pool)
            .await
            .map_err(e)?;
    let (status, join_headers, _) = send(
        &app,
        "POST",
        "/api/v1/participations/join",
        &[],
        &json!({"joinCode": code, "displayName": "田中"}).to_string(),
    )
    .await?;
    assert_eq!(status, StatusCode::OK);
    let participant = cookie_of(&join_headers)?;
    drop(
        send(
            &app,
            "GET",
            &format!("/api/v1/games/{game_id}/state"),
            &[("cookie", &facilitator)],
            "",
        )
        .await?,
    );
    let text = emf_lines("test", &capture.all()).join("\n");
    assert!(!text.is_empty());
    for secret in [
        "田中",
        &code,
        &game_id,
        participant.trim_start_matches("bg_session="),
        facilitator.trim_start_matches("bg_session="),
        "bg_session",
    ] {
        assert!(
            !text.contains(secret),
            "メトリクスに {secret} が含まれている"
        );
    }
    // 成功した作成は、主要な操作の成功と、競合ではない試行（0）になる
    assert!(
        !capture
            .named(metric_names::MAIN_OPERATION_SUCCESS, "createGame")
            .is_empty()
    );
    assert!(
        capture
            .all()
            .iter()
            .any(|s| s.name == metric_names::CONCURRENCY_CONFLICT && s.value == 0.0)
    );
    Ok(())
}

/// OpenAPI の `contracts/openapi.yaml` から、（メソッド, 経路のテンプレート, operationId）を読む。
fn contract_operations() -> Result<Vec<(String, String, String)>, String> {
    let text = std::fs::read_to_string("../../../beer-game-contracts/openapi.yaml")
        .map_err(|e| format!("openapi.yaml を読めない: {e}"))?;
    let mut found = Vec::new();
    let (mut path, mut method) = (String::new(), String::new());
    for line in text.lines() {
        if let Some(rest) = line.strip_prefix("  /")
            && let Some(p) = rest.strip_suffix(':')
        {
            path = format!("/{p}");
        } else if let Some(m) = line.strip_prefix("    ")
            && let Some(m) = m.strip_suffix(':')
            && ["get", "post", "put", "delete", "patch"].contains(&m)
        {
            method = m.to_uppercase();
        } else if let Some(id) = line.trim().strip_prefix("operationId:") {
            found.push((method.clone(), path.clone(), id.trim().to_owned()));
        }
    }
    Ok(found)
}

/// `{gameId}` と `{game_id}` の違いを無視して、区間を `{}` にそろえる。
fn normalized(path: &str) -> String {
    path.split('/')
        .map(|s| if s.starts_with('{') { "{}" } else { s })
        .collect::<Vec<_>>()
        .join("/")
}

#[test]
fn ac6_1_3__操作名の表は_OpenAPI_の_operationId_と過不足なく一致する() -> Result<(), String> {
    let contract = contract_operations()?;
    assert!(!contract.is_empty(), "openapi.yaml を読めていない");
    let mut problems = Vec::new();
    for (method, path, id) in &contract {
        let full = format!("/api/v1{path}");
        let hit = OPERATIONS
            .iter()
            .find(|(m, p, _)| m == method && normalized(p) == normalized(&full));
        match hit {
            None => problems.push(format!("表に無い: {method} {full} ({id})")),
            Some((_, _, table_id)) if table_id != id => {
                problems.push(format!(
                    "operationId が違う: {method} {full}（契約 {id} / 表 {table_id}）"
                ));
            }
            Some(_) => {}
        }
    }
    for (m, p, id) in OPERATIONS {
        if !contract
            .iter()
            .any(|(cm, cp, _)| cm == m && normalized(&format!("/api/v1{cp}")) == normalized(p))
        {
            problems.push(format!("契約に無い: {m} {p} ({id})"));
        }
    }
    assert!(problems.is_empty(), "食い違い:\n{}", problems.join("\n"));
    Ok(())
}
