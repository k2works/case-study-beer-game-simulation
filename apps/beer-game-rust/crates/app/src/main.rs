//! API サーバーの起動。設定は環境変数から読む（DATABASE_URL、CREDENTIAL_KEY、PORT）。
//! 起動モード（第 1 引数）: `api`（既定。SIGTERM で完了を待って終了コード 0）、`migrate`（マイグレーションだけ適用して終了）、
//! `healthcheck`（`/api/v1/health` を自分に問い合わせ、200 なら 0。シェルのない実行イメージの HEALTHCHECK 用。RI3）。
//! 設定の誤りは終了コード 78、未実装のモードは 64。

use std::io::Write;
use std::process::ExitCode;
use std::sync::Arc;

use axum::serve;
use beergame_adapter_http::{EmfMetricSink, router};
use beergame_adapter_persistence::migrate;
use beergame_app::{PgBackend, SystemEnv, init_logging};
use beergame_application::{AppSettings, Env, MetricSink, Secret, sweep_metrics};
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
    let maintenance = mode == "rebuild-projections" || mode == "verify-projections";
    if mode != "api" && mode != "migrate" && mode != "retention" && !maintenance {
        drop(writeln!(
            std::io::stderr(),
            "未実装の起動モード: {mode}（api・migrate・retention・rebuild-projections・verify-projections・healthcheck）"
        ));
        return ExitCode::from(64);
    }
    init_logging();
    // `DATABASE_URL`、または部品（`DB_HOST`・`DB_USER`・`DB_PASSWORD` ほか。ECS は秘密を 1 つの URL に合成できない）から
    let Some(database_url) = beergame_app::config::database_url(|key| std::env::var(key).ok())
    else {
        return config_error("DATABASE_URL、または DB_HOST・DB_USER・DB_PASSWORD が必要です。");
    };
    // メトリクスは EMF の JSON 行を標準出力へ（BD9）。環境の名前は `ENVIRONMENT`（既定 local）
    let environment = std::env::var("ENVIRONMENT").unwrap_or_else(|_| "local".to_owned());
    let metrics: Arc<dyn MetricSink> =
        Arc::new(EmfMetricSink::new(&environment, std::io::stdout()));
    if maintenance {
        // 資格の鍵は要らない。ゲーム ID は、モードの後ろの引数
        let args: Vec<String> = std::env::args().skip(2).collect();
        let Ok(pool) = PgPoolOptions::new()
            .max_connections(2)
            .connect(&database_url)
            .await
        else {
            tracing::error!("データベースに接続できません");
            return ExitCode::from(beergame_app::maintenance_mode::EXIT_UNAVAILABLE);
        };
        return ExitCode::from(
            beergame_app::maintenance_mode::run(&mode, pool, &args, metrics.as_ref()).await,
        );
    }
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
    let settings_for_retention = || AppSettings {
        credential_key: Secret::new(key.clone()),
        key_version: 1,
        credential_ttl_millis: 2_592_000_000,
        retention_days: 90,
        max_attempts: beergame_app::config::MAX_ATTEMPTS,
        retired_keys: Vec::new(),
        session_ttl_millis: 86_400_000,
        max_failed_attempts: 10,
        attempt_window_millis: 600_000,
    };
    if mode == "retention" {
        // 期限に達したゲームを削除して終了する（定期の起動は運用側。B15）
        let store = beergame_adapter_persistence::PgRetentionStore::new(pool);
        return match beergame_application::run_retention(
            &store,
            &SystemEnv,
            &settings_for_retention(),
            None,
        )
        .await
        {
            Ok(report) => {
                tracing::info!(
                    completed = report.completed,
                    abandoned = report.abandoned.len(),
                    "retention"
                );
                // 心拍（掃引が動くたびに出る）と、再試行をやめたゲームのアラームの元（AC5.1.3・AC6.1.6）
                metrics.record(&sweep_metrics(&report, SystemEnv.now().epoch_millis()));
                if !report.abandoned.is_empty() {
                    tracing::error!(
                        abandoned = report.abandoned.len(),
                        "削除の再試行の上限に達したゲームがある"
                    );
                }
                ExitCode::SUCCESS
            }
            Err(_) => ExitCode::FAILURE,
        };
    }
    // 鍵の版（既定 1）と、旧版の鍵（`版:鍵` をカンマ区切り。残している間は旧版の資格を使える。外すと使えなくなる）
    let key_version: i32 = std::env::var("CREDENTIAL_KEY_VERSION")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(1);
    let retired_keys: Vec<(i32, Secret<Vec<u8>>)> = std::env::var("CREDENTIAL_RETIRED_KEYS")
        .unwrap_or_default()
        .split(',')
        .filter_map(|pair| pair.split_once(':'))
        .filter_map(|(version, key)| {
            Some((
                version.trim().parse().ok()?,
                Secret::new(key.trim().as_bytes().to_vec()),
            ))
        })
        .collect();
    let settings = AppSettings {
        credential_key: Secret::new(key),
        key_version,
        // 復帰資格は 30 日、ブラウザセッションは 24 時間
        credential_ttl_millis: 2_592_000_000,
        retention_days: 90,
        max_attempts: beergame_app::config::MAX_ATTEMPTS,
        retired_keys,
        session_ttl_millis: 86_400_000,
        max_failed_attempts: 10,
        attempt_window_millis: 600_000,
    };
    // 実行環境の観測（RSS・タスク数・panic・接続プール）を 60 秒ごとに出す。panic は数えるだけで、継続・終了は変えない
    beergame_app::runtime_metrics::install_panic_counter();
    let sampler = beergame_app::runtime_metrics::spawn_sampler(
        pool.clone(),
        Arc::clone(&metrics),
        std::time::Duration::from_secs(60),
    );
    // Cookie の Secure は、ENVIRONMENT が local 以外のとき（NF-S2。以前は常に付けていなかった）
    let secure = beergame_app::config::secure_cookies(|key| std::env::var(key).ok());
    let app = router(Arc::new(
        PgBackend::new(pool, SystemEnv, settings, secure).with_metrics(metrics),
    ));
    let listener = match tokio::net::TcpListener::bind(("0.0.0.0", port)).await {
        Ok(listener) => listener,
        Err(e) => return config_error(&format!("ポート {port} を待ち受けられません: {e}")),
    };
    let served = serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await;
    // 終了するときは、観測の定期の出力も止める
    sampler.abort();
    match served {
        Ok(()) => ExitCode::SUCCESS,
        Err(_) => ExitCode::FAILURE,
    }
}
