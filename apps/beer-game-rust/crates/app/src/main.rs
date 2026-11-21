//! API サーバーの起動。設定は環境変数から読む（DATABASE_URL、CREDENTIAL_KEY、PORT）。
//! SIGTERM での正常終了・`healthcheck`・起動モードは Bolt 4。ここは、ローカルで共有する画面（web/）を動かすための最小の起動。

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

#[tokio::main]
async fn main() -> ExitCode {
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
    match serve(listener, app).await {
        Ok(()) => ExitCode::SUCCESS,
        Err(_) => ExitCode::FAILURE,
    }
}
