//! axum のルーター。ハンドラーは薄く、入力の形の検証・認証の結果の受け渡し・応答の組み立てだけを行う（業務ルールはドメイン）。

use std::future::Future;
use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::State;
use axum::http::{HeaderMap, HeaderName, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use beergame_application::{
    AppFailure, AppSettings, CreateGameInput, CredentialLookup, Env, EventStore, create_game,
    join_game,
};
use beergame_domain::{GameEvent, GameId, SessionEvent};
use serde_json::{Value, json};
use uuid::Uuid;

use crate::problem::{
    FieldError, Problem, bad_request_problem, invitation_invalid_problem, not_ready_problem,
    problem_of, validation_problem,
};

/// 外側（永続化・環境）への入口。アプリのバイナリが組み立てて渡す。
pub trait Backend: Send + Sync + 'static {
    type Env: Env + Send;
    type Store: EventStore<GameEvent>
        + EventStore<SessionEvent, Tx = <Self::Store as EventStore<GameEvent>>::Tx>
        + CredentialLookup
        + Send;

    fn env(&self) -> &Self::Env;
    fn settings(&self) -> &AppSettings;
    /// ゲームごとのストア。
    fn store(&self, game_id: GameId) -> Self::Store;
    /// 参加コードからゲームを引く（投影 `game_join_codes`）。
    fn game_by_join_code(
        &self,
        code: &str,
    ) -> impl Future<Output = Result<Option<GameId>, AppFailure>> + Send;
    /// 依存先（DB）に接続できるか。
    fn is_ready(&self) -> impl Future<Output = bool> + Send;
    /// HTTPS の環境では Cookie に `Secure` を付ける。
    fn secure_cookies(&self) -> bool;
}

const SESSION_COOKIE: &str = "bg_session";
const SESSION_MAX_AGE_SECONDS: i64 = 86_400;

/// ルーターを作る。
pub fn router<B: Backend>(backend: Arc<B>) -> Router {
    Router::new()
        .route("/api/v1/health", get(health::<B>))
        .route("/api/v1/ready", get(ready::<B>))
        .route("/api/v1/games", post(create::<B>))
        .route("/api/v1/participations/join", post(join::<B>))
        .with_state(backend)
}

/// 相関 ID。要求の `x-correlation-id` が UUID ならそれを使い、そうでなければ作る。
fn correlation_id<B: Backend>(backend: &B, headers: &HeaderMap) -> String {
    headers
        .get("x-correlation-id")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| Uuid::parse_str(v).ok())
        .unwrap_or_else(|| Uuid::from_u128(backend.env().new_id()))
        .to_string()
}

fn with_correlation(mut response: Response, correlation: &str) -> Response {
    if let Ok(value) = HeaderValue::from_str(correlation) {
        response
            .headers_mut()
            .insert(HeaderName::from_static("x-correlation-id"), value);
    }
    response
}

fn problem_response(problem: &Problem, correlation: &str) -> Response {
    let status = StatusCode::from_u16(problem.status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    let mut response = (
        status,
        [(header::CONTENT_TYPE, "application/problem+json")],
        problem.body().to_string(),
    )
        .into_response();
    if let Some(seconds) = problem.retry_after_seconds
        && let Ok(value) = HeaderValue::from_str(&seconds.to_string())
    {
        response.headers_mut().insert(header::RETRY_AFTER, value);
    }
    with_correlation(response, correlation)
}

fn json_response(
    status: StatusCode,
    body: &Value,
    cookie: Option<&str>,
    location: Option<&str>,
) -> Response {
    let mut response = (
        status,
        [(header::CONTENT_TYPE, "application/json")],
        body.to_string(),
    )
        .into_response();
    if let Some(cookie) = cookie
        && let Ok(value) = HeaderValue::from_str(cookie)
    {
        response.headers_mut().append(header::SET_COOKIE, value);
    }
    if let Some(location) = location
        && let Ok(value) = HeaderValue::from_str(location)
    {
        response.headers_mut().insert(header::LOCATION, value);
    }
    response
}

/// 資格の Cookie の名前。`X-Tab-Id`（英数字 16〜64 文字）があれば `bg_session_<X-Tab-Id>`（ADR-020）。
fn cookie_name(headers: &HeaderMap) -> String {
    let tab = headers
        .get("x-tab-id")
        .and_then(|v| v.to_str().ok())
        .filter(|v| (16..=64).contains(&v.len()) && v.chars().all(|c| c.is_ascii_alphanumeric()));
    match tab {
        Some(tab) => format!("{SESSION_COOKIE}_{tab}"),
        None => SESSION_COOKIE.to_owned(),
    }
}

fn session_cookie<B: Backend>(backend: &B, headers: &HeaderMap, token: &str) -> String {
    let secure = if backend.secure_cookies() {
        "; Secure"
    } else {
        ""
    };
    format!(
        "{}={token}; Path=/; HttpOnly; SameSite=Strict; Max-Age={SESSION_MAX_AGE_SECONDS}{secure}",
        cookie_name(headers)
    )
}

async fn health<B: Backend>(State(backend): State<Arc<B>>, headers: HeaderMap) -> Response {
    let correlation = correlation_id(&*backend, &headers);
    with_correlation(
        json_response(StatusCode::OK, &json!({"status": "ok"}), None, None),
        &correlation,
    )
}

async fn ready<B: Backend>(State(backend): State<Arc<B>>, headers: HeaderMap) -> Response {
    let correlation = correlation_id(&*backend, &headers);
    if backend.is_ready().await {
        with_correlation(
            json_response(StatusCode::OK, &json!({"status": "ready"}), None, None),
            &correlation,
        )
    } else {
        problem_response(&not_ready_problem(), &correlation)
    }
}

fn parse_json(body: &Bytes) -> Result<Value, Box<Problem>> {
    serde_json::from_slice::<Value>(body)
        .map_err(|_| Box::new(bad_request_problem("JSON として解釈できません。")))
}

fn demand_error(week: usize) -> FieldError {
    FieldError {
        field: "demand".to_owned(),
        message: "需要は 0〜1000 の整数".to_owned(),
        week: Some(week),
    }
}

/// ゲーム作成の本文。整数でない値は、形の誤りとして項目ごとに集める（需要は対象の週つき）。
fn parse_create(body: &Value) -> Result<CreateGameInput, Vec<FieldError>> {
    let mut errors = Vec::new();
    let final_week = body.get("finalWeek").and_then(Value::as_i64);
    if final_week.is_none() {
        errors.push(FieldError {
            field: "finalWeek".to_owned(),
            message: "最終週は 1 以上 50 以下の整数にしてください。".to_owned(),
            week: None,
        });
    }
    let mut demand = Vec::new();
    match body.get("demand").and_then(Value::as_array) {
        Some(items) => {
            for (index, item) in items.iter().enumerate() {
                match item.as_i64() {
                    Some(n) => demand.push(n),
                    None => {
                        errors.push(demand_error(index.saturating_add(1)));
                        demand.push(-1);
                    }
                }
            }
        }
        None => errors.push(FieldError {
            field: "demand".to_owned(),
            message: "需要系列は整数の配列にしてください。".to_owned(),
            week: None,
        }),
    }
    if body.get("kind").and_then(Value::as_str) == Some("CUSTOM") {
        errors.push(FieldError {
            field: "kind".to_owned(),
            message: "カスタム条件は、まだ使えません。".to_owned(),
            week: None,
        });
    }
    match (final_week, errors.is_empty()) {
        (Some(final_week), true) => Ok(CreateGameInput { final_week, demand }),
        (_, _) => Err(errors),
    }
}

async fn create<B: Backend>(
    State(backend): State<Arc<B>>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let correlation = correlation_id(&*backend, &headers);
    let parsed = match parse_json(&body) {
        Ok(v) => v,
        Err(problem) => return problem_response(&problem, &correlation),
    };
    let input = match parse_create(&parsed) {
        Ok(input) => input,
        Err(errors) => return problem_response(&validation_problem(errors), &correlation),
    };
    let game_id = GameId::new(backend.env().new_id());
    let store = backend.store(game_id);
    match create_game(&store, backend.env(), backend.settings(), game_id, &input).await {
        Ok(outcome) => {
            let location = format!("/api/v1/games/{}/state", Uuid::from_u128(game_id.get()));
            let cookie =
                session_cookie(&*backend, &headers, outcome.facilitator_credential.expose());
            let body = json!({"versions": {"game": outcome.game_version, "session": Value::Null}});
            with_correlation(
                json_response(StatusCode::CREATED, &body, Some(&cookie), Some(&location)),
                &correlation,
            )
        }
        Err(failure) => problem_response(&problem_of(&failure), &correlation),
    }
}

async fn join<B: Backend>(
    State(backend): State<Arc<B>>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let correlation = correlation_id(&*backend, &headers);
    let parsed = match parse_json(&body) {
        Ok(v) => v,
        Err(problem) => return problem_response(&problem, &correlation),
    };
    let code = parsed.get("joinCode").and_then(Value::as_str);
    let name = parsed.get("displayName").and_then(Value::as_str);
    let (Some(code), Some(name)) = (code, name) else {
        let mut errors = Vec::new();
        if code.is_none() {
            errors.push(FieldError {
                field: "joinCode".to_owned(),
                message: "参加コードを入力してください。".to_owned(),
                week: None,
            });
        }
        if name.is_none() {
            errors.push(FieldError {
                field: "displayName".to_owned(),
                message: "表示名を入力してください。".to_owned(),
                week: None,
            });
        }
        return problem_response(&validation_problem(errors), &correlation);
    };
    // 参加コードの不明・形式不正は、区別せず同じ 403（列挙の防止）
    let game_id = match backend.game_by_join_code(code).await {
        Ok(Some(game_id)) => game_id,
        Ok(None) => return problem_response(&invitation_invalid_problem(), &correlation),
        Err(failure) => return problem_response(&problem_of(&failure), &correlation),
    };
    let store = backend.store(game_id);
    match join_game(&store, backend.env(), backend.settings(), game_id, name).await {
        Ok(outcome) => {
            let cookie = session_cookie(&*backend, &headers, outcome.credential.expose());
            let body = json!({
                "versions": {"game": outcome.game_version, "session": Value::Null},
                "gameId": Uuid::from_u128(game_id.get()).to_string(),
            });
            with_correlation(
                json_response(StatusCode::OK, &body, Some(&cookie), None),
                &correlation,
            )
        }
        Err(failure) => problem_response(&problem_of(&failure), &correlation),
    }
}
