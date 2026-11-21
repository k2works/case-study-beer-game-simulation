//! API サーバーの起動。設定は環境変数から読む（DATABASE_URL、CREDENTIAL_KEY、PORT）。
//! 起動モード（第 1 引数）: `api`（既定。SIGTERM で完了を待って終了コード 0）、`migrate`（マイグレーションだけ適用して終了）、
//! `healthcheck`（`/api/v1/health` を自分に問い合わせ、200 なら 0。シェルのない実行イメージの HEALTHCHECK 用。RI3）。
//! 設定の誤りは終了コード 78、未実装のモードは 64。

use std::io::Write;
use std::process::ExitCode;
use std::sync::Arc;

use axum::serve;
use beergame_adapter_http::router;
use beergame_adapter_persistence::migrate;
use beergame_app::{PgBackend, SystemEnv, init_logging};
use beergame_application::{AppSettings, Secret};
use sqlx::postgres::PgPoolOptions;

/// 設定の誤り（終了コード 78）を、標準エラーへ一行で出す。
fn config_error(message: &str) -> ExitCode {
    drop(writeln!(std::io::stderr(), "設定の誤り: {message}"));
    ExitCode::from(78)
}

/// `/api/v1/health` を自分に問い合わせる（HTTP/1.0。追加のクライアントを使わない）。200 なら成功。
async fn healthcheck() -> ExitCode {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let port: u16 = std::env::var("PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(8080);
    let attempt = async {
        let mut stream = tokio::net::TcpStream::connect(("127.0.0.1", port))
            .await
            .ok()?;
        stream
            .write_all(b"GET /api/v1/health HTTP/1.0\r\nHost: localhost\r\n\r\n")
            .await
            .ok()?;
        let mut head = vec![0_u8; 32];
        let n = stream.read(&mut head).await.ok()?;
        head.get(..n)
            .map(|b| b.starts_with(b"HTTP/1.1 200") || b.starts_with(b"HTTP/1.0 200"))
    };
    match tokio::time::timeout(std::time::Duration::from_secs(3), attempt).await {
        Ok(Some(true)) => ExitCode::SUCCESS,
        Ok(Some(false) | None) | Err(_) => ExitCode::FAILURE,
    }
}

/// SIGTERM（コンテナの停止）か Ctrl-C を待つ。受けたら、新しい要求の受付を止め、処理中の要求の完了を待って終了する。
async fn shutdown_signal() {
    use tokio::signal::unix::{SignalKind, signal};
    let term = signal(SignalKind::terminate());
    match term {
        Ok(mut term) => {
            tokio::select! {
                _ = term.recv() => {}
                _ = tokio::signal::ctrl_c() => {}
            }
        }
        Err(_) => {
            drop(tokio::signal::ctrl_c().await);
        }
    }
}

#[tokio::main]
async fn main() -> ExitCode {
    let mode = std::env::args().nth(1).unwrap_or_else(|| "api".to_owned());
    if mode == "healthcheck" {
        return healthcheck().await;
    }
    if mode != "api" && mode != "migrate" {
        drop(writeln!(
            std::io::stderr(),
            "未実装の起動モード: {mode}（api・migrate・healthcheck）"
        ));
        return ExitCode::from(64);
    }
    init_logging();
    let Ok(database_url) = std::env::var("DATABASE_URL") else {
        return config_error("DATABASE_URL が必要です。");
    };
    let key = match std::env::var("CREDENTIAL_KEY") {
        Ok(key) if key.len() >= 32 => key.into_bytes(),
        Ok(_) | Err(_) => return config_error("CREDENTIAL_KEY（32 バイト以上）が必要です。"),
    };
    let port: u16 = std::env::var("PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(8080);
    let pool = match PgPoolOptions::new()
        .max_connections(10)
        .connect(&database_url)
        .await
    {
        Ok(pool) => pool,
        Err(e) => return config_error(&format!("データベースに接続できません: {e}")),
    };
    if let Err(e) = migrate(&pool).await {
        return config_error(&format!("マイグレーションに失敗しました: {e}"));
    }
    if mode == "migrate" {
        return ExitCode::SUCCESS;
    }
    let settings = AppSettings {
        credential_key: Secret::new(key),
        key_version: 1,
        credential_ttl_millis: 86_400_000,
        retention_days: 30,
        max_attempts: 3,
    };
    let app = router(Arc::new(PgBackend::new(pool, SystemEnv, settings, false)));
    let listener = match tokio::net::TcpListener::bind(("0.0.0.0", port)).await {
        Ok(listener) => listener,
        Err(e) => return config_error(&format!("ポート {port} を待ち受けられません: {e}")),
    };
    match serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await
    {
        Ok(()) => ExitCode::SUCCESS,
        Err(_) => ExitCode::FAILURE,
    }
}
