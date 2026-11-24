// 理由: RT1 の命名（承認済み）の `__` を使うため。
#![allow(non_snake_case)]

//! 構造化ログ（AC6.1.1・X-3）。相関 ID・操作・結果・所要時間を出し、資格・表示名・参加コード・本文を含めない。

use std::io::Write;
use std::sync::{Arc, Mutex};

use serde_json::json;
use tracing_subscriber::fmt::MakeWriter;

mod support;
use support::api::{app, cookie_of, send};
use support::start;

#[derive(Clone, Default)]
struct Buf(Arc<Mutex<Vec<u8>>>);

impl Write for Buf {
    fn write(&mut self, data: &[u8]) -> std::io::Result<usize> {
        if let Ok(mut inner) = self.0.lock() {
            inner.extend_from_slice(data);
        }
        Ok(data.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

impl<'a> MakeWriter<'a> for Buf {
    type Writer = Buf;

    fn make_writer(&'a self) -> Buf {
        self.clone()
    }
}

#[tokio::test]
async fn ac6_1_1__ログは相関_ID_操作_結果_所要時間を出し_資格_表示名_参加コード_本文を含めない()
-> Result<(), String> {
    let Some(env) = start().await? else {
        return Ok(());
    };
    let app = app(env.pool.clone());
    let buf = Buf::default();
    let _guard = tracing::subscriber::set_default(
        tracing_subscriber::fmt()
            .json()
            .with_writer(buf.clone())
            .finish(),
    );
    let id = "5a1c8a0e-3b1d-4c0e-9d0a-0e0d6f6a1b2c";
    let (_, headers, _) = send(
        &app,
        "POST",
        "/api/v1/games",
        &[("x-correlation-id", id)],
        &json!({"finalWeek": 2, "demand": [4, 4]}).to_string(),
    )
    .await?;
    let facilitator = cookie_of(&headers)?;
    let token = facilitator.split('=').nth(1).ok_or("値が無い")?.to_owned();
    let code: String = sqlx::query_scalar("SELECT join_code FROM game_join_codes")
        .fetch_one(&env.pool)
        .await
        .map_err(|e| e.to_string())?;
    send(
        &app,
        "POST",
        "/api/v1/participations/join",
        &[],
        &json!({"joinCode": code, "displayName": "山本さん"}).to_string(),
    )
    .await?;
    // 失敗（422）も記録される
    send(
        &app,
        "POST",
        "/api/v1/games",
        &[],
        &json!({"finalWeek": 2, "demand": [4, 1001]}).to_string(),
    )
    .await?;

    let text = String::from_utf8(buf.0.lock().map_err(|e| e.to_string())?.clone())
        .map_err(|e| e.to_string())?;
    let lines: Vec<serde_json::Value> = text
        .lines()
        .filter_map(|l| serde_json::from_str(l).ok())
        .collect();
    assert_eq!(lines.len(), 3, "要求ごとに 1 行: {text}");
    let first = lines
        .first()
        .and_then(|l| l.get("fields"))
        .ok_or("fields が無い")?;
    assert_eq!(first.get("correlation_id"), Some(&json!(id)));
    assert_eq!(
        (first.get("method"), first.get("path"), first.get("status")),
        (
            Some(&json!("POST")),
            Some(&json!("/api/v1/games")),
            Some(&json!(201))
        )
    );
    assert!(
        first
            .get("elapsed_ms")
            .is_some_and(serde_json::Value::is_number)
    );
    assert!(
        lines
            .iter()
            .filter_map(|l| l.pointer("/fields/status"))
            .any(|s| s == &json!(422)),
        "失敗の結果も記録する"
    );
    for secret in [
        token.as_str(),
        "山本さん",
        code.as_str(),
        "demand",
        "joinCode",
        "bg_session",
    ] {
        assert!(!text.contains(secret), "ログに秘密が含まれる: {secret}");
    }
    Ok(())
}
