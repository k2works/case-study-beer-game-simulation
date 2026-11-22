//! シナリオの世界。進行役・参加者の状態と、HTTP のアプリ（実 PostgreSQL）への呼び出し。

use std::collections::BTreeMap;
use std::sync::Arc;

use axum::Router;
use axum::body::Body;
use axum::http::Request;
use beergame_adapter_http::router;
use beergame_app::{PgBackend, SystemEnv};
use beergame_application::{AppSettings, Secret};
use cucumber::World;
use http_body_util::BodyExt;
use serde_json::{Value, json};
use sqlx::PgPool;
use testcontainers::core::{IntoContainerPort, WaitFor};
use testcontainers::runners::AsyncRunner;
use testcontainers::{ContainerAsync, GenericImage, ImageExt};
use tokio::sync::OnceCell;
use tower::ServiceExt;

/// 実行全体で 1 つの PostgreSQL（シナリオごとに別のゲームを作る）。
static DB: OnceCell<(ContainerAsync<GenericImage>, PgPool)> = OnceCell::const_new();

async fn database() -> Result<PgPool, String> {
    let (_, pool) = DB
        .get_or_try_init(|| async {
            let container = GenericImage::new("postgres", "18.6")
                .with_exposed_port(5432.tcp())
                .with_wait_for(WaitFor::message_on_stderr(
                    "database system is ready to accept connections",
                ))
                .with_env_var("POSTGRES_PASSWORD", "pw")
                .start()
                .await
                .map_err(|e| format!("PostgreSQL のコンテナを起動できない: {e}"))?;
            let port = container
                .get_host_port_ipv4(5432)
                .await
                .map_err(|e| e.to_string())?;
            let url = format!("postgres://postgres:pw@127.0.0.1:{port}/postgres");
            let mut last = String::new();
            for _ in 0..60 {
                match sqlx::postgres::PgPoolOptions::new()
                    .max_connections(8)
                    .connect(&url)
                    .await
                {
                    Ok(pool) => {
                        beergame_adapter_persistence::migrate(&pool)
                            .await
                            .map_err(|e| e.to_string())?;
                        return Ok((container, pool));
                    }
                    Err(e) => {
                        last = e.to_string();
                        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                    }
                }
            }
            Err(format!("PostgreSQL に接続できない: {last}"))
        })
        .await?;
    Ok(pool.clone())
}

/// 直近の応答。
#[derive(Clone, Debug)]
pub struct Reply {
    pub status: u16,
    pub body: Value,
    pub cookie: Option<String>,
    pub location: Option<String>,
}

/// 1 つのゲーム。
#[derive(Clone, Debug, Default)]
pub struct GameCtx {
    pub id: String,
    pub facilitator: String,
    pub join_code: String,
    /// 役割（英語名）→ 参加者 ID・Cookie。
    pub players: BTreeMap<String, (String, String)>,
    /// 表示名 → 参加者 ID・Cookie。
    pub named: BTreeMap<String, (String, String)>,
    /// 役割（英語名）→ 当週に保存した意思決定の版。
    pub versions: BTreeMap<String, u32>,
}

#[derive(Debug, World)]
#[world(init = Self::new)]
pub struct ApiWorld {
    pub app: Option<Router>,
    pub pool: Option<PgPool>,
    pub games: Vec<GameCtx>,
    pub last: Option<Reply>,
    pub counter: u32,
    pub roots_before: i64,
    /// 付け替え前の役割。
    pub moved_from: Option<(String, String)>,
    /// 操作中のゲーム（`None` は最後に作ったゲーム）。2 つのゲームを比べるシナリオが切り替える。
    pub current: Option<usize>,
    /// 次の呼び出しに付ける `If-Match`（意思決定の版）。使うと空に戻る。
    pub if_match: Option<String>,
}

impl ApiWorld {
    fn new() -> Self {
        ApiWorld {
            app: None,
            pool: None,
            games: Vec::new(),
            last: None,
            counter: 0,
            roots_before: 0,
            moved_from: None,
            current: None,
            if_match: None,
        }
    }

    /// アプリを（初回だけ）用意する。
    pub async fn ready(&mut self) -> Result<(), String> {
        if self.app.is_none() {
            let pool = database().await?;
            let settings = AppSettings {
                credential_key: Secret::new(vec![5; 32]),
                key_version: 1,
                credential_ttl_millis: 86_400_000,
                retention_days: 30,
                max_attempts: 3,
            };
            self.app = Some(router(Arc::new(PgBackend::new(
                pool.clone(),
                SystemEnv,
                settings,
                false,
            ))));
            self.pool = Some(pool);
        }
        Ok(())
    }

    pub fn pool(&self) -> Result<&PgPool, String> {
        self.pool.as_ref().ok_or_else(|| "DB が無い".to_owned())
    }

    fn index(&self) -> usize {
        self.current
            .unwrap_or_else(|| self.games.len().saturating_sub(1))
    }

    pub fn game(&self) -> Result<&GameCtx, String> {
        self.games
            .get(self.index())
            .ok_or_else(|| "ゲームが無い".to_owned())
    }

    pub fn game_mut(&mut self) -> Result<&mut GameCtx, String> {
        let index = self.index();
        self.games
            .get_mut(index)
            .ok_or_else(|| "ゲームが無い".to_owned())
    }

    pub fn reply(&self) -> Result<&Reply, String> {
        self.last.as_ref().ok_or_else(|| "応答が無い".to_owned())
    }

    pub fn next_key(&mut self) -> String {
        self.counter += 1;
        format!("key-{}", self.counter)
    }

    /// HTTP を呼ぶ。応答を `last` に保存して返す。
    pub async fn call(
        &mut self,
        method: &str,
        uri: &str,
        cookie: Option<&str>,
        key: Option<&str>,
        body: &str,
    ) -> Result<Reply, String> {
        self.ready().await?;
        let mut builder = Request::builder()
            .method(method)
            .uri(uri)
            .header("content-type", "application/json");
        if let Some(cookie) = cookie {
            builder = builder.header("cookie", cookie);
        }
        if let Some(key) = key {
            builder = builder.header("idempotency-key", key);
        }
        if let Some(version) = self.if_match.take() {
            builder = builder.header("if-match", version);
        }
        let app = self.app.clone().ok_or("アプリが無い")?;
        let response = app
            .oneshot(
                builder
                    .body(Body::from(body.to_owned()))
                    .map_err(|e| e.to_string())?,
            )
            .await
            .map_err(|e| e.to_string())?;
        let (parts, body) = response.into_parts();
        let bytes = body.collect().await.map_err(|e| e.to_string())?.to_bytes();
        let cookie = parts
            .headers
            .get("set-cookie")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.split(';').next())
            .map(str::to_owned);
        let location = parts
            .headers
            .get("location")
            .and_then(|v| v.to_str().ok())
            .map(str::to_owned);
        let reply = Reply {
            status: parts.status.as_u16(),
            body: serde_json::from_slice(&bytes).unwrap_or(Value::Null),
            cookie,
            location,
        };
        self.last = Some(reply.clone());
        Ok(reply)
    }

    /// ゲームを作成し、進行役の資格・参加コードを控える（ゲームを `games` に足す）。
    pub async fn create_game(&mut self, final_week: i64, demand: &[i64]) -> Result<Reply, String> {
        self.ready().await?;
        self.roots_before = sqlx::query_scalar("SELECT count(*) FROM game_roots")
            .fetch_one(self.pool()?)
            .await
            .map_err(|e| e.to_string())?;
        let body = json!({"kind": "KIT", "finalWeek": final_week, "demand": demand}).to_string();
        let reply = self
            .call("POST", "/api/v1/games", None, None, &body)
            .await?;
        if reply.status == 201 {
            let id = reply
                .location
                .as_deref()
                .and_then(|l| l.strip_prefix("/api/v1/games/"))
                .and_then(|l| l.strip_suffix("/state"))
                .ok_or("Location からゲームの ID を取れない")?
                .to_owned();
            let facilitator = reply.cookie.clone().ok_or("進行役の Cookie が無い")?;
            let join_code: String = sqlx::query_scalar(
                "SELECT join_code FROM game_join_codes WHERE game_id = $1::uuid",
            )
            .bind(&id)
            .fetch_one(self.pool()?)
            .await
            .map_err(|e| e.to_string())?;
            self.games.push(GameCtx {
                id,
                facilitator,
                join_code,
                ..GameCtx::default()
            });
        }
        Ok(reply)
    }
}
