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

fn uuid_source() -> String {
    // 世界ごとに別の接続元（乱数の源は時刻とアドレス。テスト専用で、暗号的な強さは要らない）
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
    let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_nanos());
    format!("scenario-{nanos}-{n}")
}

/// 直近の応答。
#[derive(Clone, Debug)]
pub struct Reply {
    pub status: u16,
    pub body: Value,
    pub cookie: Option<String>,
    pub location: Option<String>,
    /// 復帰資格（Cookie `bg_recovery` の値）。
    pub recovery: Option<String>,
    /// `Retry-After`（秒）。
    pub retry_after: Option<String>,
    /// 本文のそのままの文字列（CSV など）。
    pub text: String,
    /// 応答ヘッダー（名前は小文字）。
    pub headers: BTreeMap<String, String>,
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
    /// 進行役の復帰資格（作成時に控えた復帰コードと同じ）。
    pub recovery: String,
    /// 参加者 ID → 復帰資格（参加の応答の Cookie）。
    pub recoveries: BTreeMap<String, String>,
    /// 参加者 ID → 再発行した復帰コード。
    pub reissued: BTreeMap<String, String>,
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
    /// 復帰で発行されたブラウザセッション（Cookie）と、最後に復帰した参加者 ID。
    pub recovered: Option<(String, String)>,
    /// 2 つのタブの古い側が見ている、意思決定の版。
    pub stale_version: u32,
    /// 次の呼び出しに付ける `If-Match`（意思決定の版）。使うと空に戻る。
    pub if_match: Option<String>,
    /// このシナリオの接続元（`X-Forwarded-For`）。試行の窓がシナリオの間で混ざらないよう、世界ごとに別の値にする。
    pub source: String,
    /// 直近の一連の呼び出しの状態（複数回の参加など）。
    pub statuses: Vec<u16>,
    /// 直近の作成の冪等キーと本文（同じ要求の再送に使う）。
    pub create_request: Option<(String, String)>,
    /// 進行役が確認画面で控えた、役割ごとの入力の版。
    pub remembered_basis: Option<Value>,
    /// 入れ替えられた旧担当者（参加者 ID）。
    pub replaced: Option<String>,
    /// 割り当て直しの前のイベントの件数。
    pub history_size: i64,
    /// 発行した観察用の招待（招待の ID・招待コード）と、参加した観察者のブラウザセッション。
    pub invitation: Option<(String, String)>,
    pub observer_cookie: Option<String>,
    /// 直近に出力した CSV・JSON の応答。
    pub export_csv: Option<Reply>,
    pub export_json: Option<Reply>,
    /// 削除処理（掃引）に渡す時計を、実時間からずらす量（ミリ秒）。実際には待たない。
    pub clock_offset_millis: i64,
    /// 削除の処理が、この回数だけ失敗する（差し込み口）。
    pub deletion_failures: Arc<std::sync::atomic::AtomicUsize>,
    /// 直近の掃引の前の受領記録の件数。
    pub receipts_before: i64,
    /// 直近の一連の掃引で完了した削除の数と、再試行をやめて通知されたゲームの数。
    pub completed: usize,
    pub abandoned: usize,
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
            recovered: None,
            stale_version: 0,
            if_match: None,
            source: uuid_source(),
            statuses: Vec::new(),
            create_request: None,
            remembered_basis: None,
            replaced: None,
            history_size: 0,
            invitation: None,
            observer_cookie: None,
            export_csv: None,
            export_json: None,
            clock_offset_millis: 0,
            deletion_failures: Arc::new(std::sync::atomic::AtomicUsize::new(0)),
            receipts_before: 0,
            completed: 0,
            abandoned: 0,
        }
    }

    /// 署名鍵を入れ替えてアプリを組み直す（鍵のローテーション。旧版の鍵を残すか外すかを選ぶ）。
    pub async fn rebuild_with_keys(
        &mut self,
        key_version: i32,
        key: u8,
        retired: Vec<(i32, u8)>,
    ) -> Result<(), String> {
        let pool = database().await?;
        self.app = Some(router(Arc::new(PgBackend::new(
            pool.clone(),
            SystemEnv,
            Self::settings(key_version, key, retired),
            false,
        ))));
        self.pool = Some(pool);
        Ok(())
    }

    pub fn settings(key_version: i32, key: u8, retired: Vec<(i32, u8)>) -> AppSettings {
        AppSettings {
            credential_key: Secret::new(vec![key; 32]),
            key_version,
            credential_ttl_millis: 86_400_000,
            retention_days: 90,
            max_attempts: 3,
            retired_keys: retired
                .into_iter()
                .map(|(version, k)| (version, Secret::new(vec![k; 32])))
                .collect(),
            session_ttl_millis: 86_400_000,
            max_failed_attempts: 10,
            attempt_window_millis: 600_000,
        }
    }

    /// アプリを（初回だけ）用意する。
    pub async fn ready(&mut self) -> Result<(), String> {
        if self.app.is_none() {
            let pool = database().await?;
            let settings = Self::settings(1, 5, Vec::new());
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
        // 世界ごとに別の接続元の名前を含める（作成の冪等キーは、ゲームをまたいで照合されるため、シナリオ間で重ならない値にする）
        format!("{}-key-{}", self.source, self.counter)
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
        builder = builder.header("x-forwarded-for", self.source.as_str());
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
        let set_cookies: Vec<&str> = parts
            .headers
            .get_all("set-cookie")
            .iter()
            .filter_map(|v| v.to_str().ok())
            .filter_map(|v| v.split(';').next())
            .collect();
        let cookie = set_cookies
            .iter()
            .find(|c| c.starts_with("bg_session"))
            .map(|c| (*c).to_owned());
        let recovery = set_cookies
            .iter()
            .find_map(|c| c.strip_prefix("bg_recovery="))
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
            recovery,
            text: String::from_utf8_lossy(&bytes).into_owned(),
            headers: parts
                .headers
                .iter()
                .filter_map(|(k, v)| {
                    v.to_str()
                        .ok()
                        .map(|v| (k.as_str().to_owned(), v.to_owned()))
                })
                .collect(),
            retry_after: parts
                .headers
                .get("retry-after")
                .and_then(|v| v.to_str().ok())
                .map(str::to_owned),
        };
        self.last = Some(reply.clone());
        Ok(reply)
    }

    /// ゲームを作成し、進行役の資格・参加コードを控える（ゲームを `games` に足す）。
    pub async fn create_game(&mut self, final_week: i64, demand: &[i64]) -> Result<Reply, String> {
        let body = json!({"kind": "KIT", "finalWeek": final_week, "demand": demand});
        self.create_with(&body).await
    }

    /// 本文を指定してゲームを作成する（カスタム条件など）。
    pub async fn create_with(&mut self, body: &Value) -> Result<Reply, String> {
        self.ready().await?;
        self.roots_before = sqlx::query_scalar("SELECT count(*) FROM game_roots")
            .fetch_one(self.pool()?)
            .await
            .map_err(|e| e.to_string())?;
        let body = body.to_string();
        let key = self.next_key();
        self.create_request = Some((key.clone(), body.clone()));
        let reply = self
            .call("POST", "/api/v1/games", None, Some(&key), &body)
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
                recovery: reply.recovery.clone().unwrap_or_default(),
                join_code,
                ..GameCtx::default()
            });
        }
        Ok(reply)
    }
}
