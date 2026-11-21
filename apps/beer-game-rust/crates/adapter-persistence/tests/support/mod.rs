//! 統合テストの共通部品（実 PostgreSQL 18.6。testcontainers）。

use std::io::Write;
use std::time::Duration;

use beergame_adapter_persistence::migrate;
use sqlx::PgPool;
use sqlx::postgres::PgPoolOptions;
use testcontainers::core::{IntoContainerPort, WaitFor};
use testcontainers::runners::AsyncRunner;
use testcontainers::{ContainerAsync, GenericImage, ImageExt};
use uuid::Uuid;

pub struct Env {
    pub _container: ContainerAsync<GenericImage>,
    pub pool: PgPool,
}

pub fn say(message: &str) {
    drop(writeln!(std::io::stderr(), "{message}"));
}

/// `postgres:18.6`（タグを固定）を起動し、マイグレーションを適用する。起動できなければ `None`（CI では失敗）。
pub async fn start() -> Result<Option<Env>, String> {
    let image = GenericImage::new("postgres", "18.6")
        .with_exposed_port(5432.tcp())
        .with_wait_for(WaitFor::message_on_stderr(
            "database system is ready to accept connections",
        ))
        .with_env_var("POSTGRES_PASSWORD", "pw");
    let container = match image.start().await {
        Ok(c) => c,
        Err(e) if std::env::var_os("CI").is_some() => {
            return Err(format!("Docker が使えない（CI では失敗）: {e}"));
        }
        Err(e) => {
            say(&format!("スキップ: Docker が使えない: {e}"));
            return Ok(None);
        }
    };
    let port = container
        .get_host_port_ipv4(5432)
        .await
        .map_err(|e| e.to_string())?;
    let url = format!("postgres://postgres:pw@127.0.0.1:{port}/postgres");
    let mut last = String::new();
    for _ in 0..60 {
        match PgPoolOptions::new()
            .max_connections(8)
            .acquire_timeout(Duration::from_secs(5))
            .connect(&url)
            .await
        {
            Ok(pool) => {
                migrate(&pool).await.map_err(|e| e.to_string())?;
                return Ok(Some(Env {
                    _container: container,
                    pool,
                }));
            }
            Err(e) => {
                last = e.to_string();
                tokio::time::sleep(Duration::from_millis(500)).await;
            }
        }
    }
    Err(format!("PostgreSQL に接続できない: {last}"))
}

// 理由: 共通部品は、テストのバイナリごとに使う関数が違う（使わないバイナリで dead_code になる）。
#[allow(dead_code)]
pub async fn new_game(pool: &PgPool) -> Result<Uuid, String> {
    let game = Uuid::new_v4();
    sqlx::query("INSERT INTO game_roots (game_id, created_at) VALUES ($1, now())")
        .bind(game)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;
    Ok(game)
}
