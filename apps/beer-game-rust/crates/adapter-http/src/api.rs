//! axum のルーター。ハンドラーは薄く、入力の形の検証・認証の結果の受け渡し・応答の組み立てだけを行う（業務ルールはドメイン）。

use std::future::Future;
use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::Path;
use axum::extract::State;
use axum::http::{HeaderMap, HeaderName, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::put;
use axum::routing::{get, post};
use beergame_application::{
    AppFailure, AppSettings, CreateGameInput, CredentialLookup, Env, EventStore, Executed,
    Idempotency, ResponseShape, Secret, StartExecuted, assign_role, authenticate, commit_week,
    create_game, digest, join_game, save_decision, start_game,
};
use beergame_domain::{
    Actor, DecisionVersion, GameEvent, GameId, Instant, ParticipantId, Quantity, Role, RoleMap,
    SessionEvent, Week,
};
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
    /// 参加者の役割（投影 `lobby_participants`）。役割が無い（未割り当て・不明）なら `None`。
    fn participant_role(
        &self,
        game_id: GameId,
        participant_id: ParticipantId,
    ) -> impl Future<Output = Result<Option<Role>, AppFailure>> + Send;
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
        .route(
            "/api/v1/games/{game_id}/participants/{participant_id}/role",
            put(assign::<B>),
        )
        .route("/api/v1/games/{game_id}/start", post(start::<B>))
        .route("/api/v1/sessions/{session_id}/decisions", put(decide::<B>))
        .route(
            "/api/v1/sessions/{session_id}/weeks/{week}/commit",
            post(commit::<B>),
        )
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

// ---- 認証・冪等性・変更系のルート ----

fn not_found() -> Problem {
    Problem {
        status: 404,
        code: "app.not_found".to_owned(),
        title: "見つかりません。".to_owned(),
        detail: None,
        retry_after_seconds: None,
        errors: Vec::new(),
        extras: serde_json::Map::new(),
    }
}

fn parse_game_id(text: &str) -> Result<GameId, Box<Problem>> {
    Uuid::parse_str(text)
        .map(|u| GameId::new(u.as_u128()))
        .map_err(|_| Box::new(not_found()))
}

/// Cookie ヘッダーから、資格の Cookie の値を取り出す（名前は `X-Tab-Id` で決まる）。
fn credential_token(headers: &HeaderMap) -> Option<Secret<String>> {
    let name = cookie_name(headers);
    headers
        .get(header::COOKIE)
        .and_then(|v| v.to_str().ok())?
        .split(';')
        .filter_map(|pair| pair.trim().split_once('='))
        .find(|(k, _)| *k == name)
        .map(|(_, v)| Secret::new(v.to_owned()))
}

/// 認証。資格が無い・無効・別のゲームのものは、区別せず 403。
async fn authenticate_for<B: Backend>(
    backend: &B,
    headers: &HeaderMap,
    game_id: GameId,
) -> Result<Actor, Box<Problem>> {
    let unauthorized = || Box::new(problem_of(&AppFailure::Unauthorized));
    let token = credential_token(headers).ok_or_else(unauthorized)?;
    let store = backend.store(game_id);
    match authenticate(&store, backend.env(), backend.settings(), &token).await {
        Ok((credential_game, actor)) if credential_game == game_id => Ok(actor),
        Ok(_) => Err(unauthorized()),
        Err(failure) => Err(Box::new(problem_of(&failure))),
    }
}

/// `Idempotency-Key` から、冪等性の情報を作る。キーが無ければ 400。
fn idempotency_for<B: Backend>(
    backend: &B,
    headers: &HeaderMap,
    game_id: GameId,
    scope: &str,
    request: &str,
    shape: ResponseShape,
) -> Result<Idempotency, Box<Problem>> {
    let key = headers
        .get("idempotency-key")
        .and_then(|v| v.to_str().ok())
        .filter(|v| !v.is_empty() && v.len() <= 200)
        .ok_or_else(|| Box::new(bad_request_problem("Idempotency-Key ヘッダーが必要です。")))?;
    let secret_key = &backend.settings().credential_key;
    let internal = || {
        Box::new(problem_of(&AppFailure::Persistence(
            beergame_application::PersistenceFailure::Storage(
                "資格の鍵が設定されていない".to_owned(),
            ),
        )))
    };
    let key_digest =
        digest(secret_key, &Secret::new(format!("idem:{key}"))).ok_or_else(internal)?;
    let request_digest =
        digest(secret_key, &Secret::new(format!("{scope}\n{request}"))).ok_or_else(internal)?;
    let now = backend.env().now();
    Ok(Idempotency {
        game_id,
        scope: scope.to_owned(),
        key_digest,
        request_digest,
        shape,
        expires_at: Instant::from_epoch_millis(now.epoch_millis().saturating_add(86_400_000)),
    })
}

fn executed_response(executed: &Executed, shape: ResponseShape, correlation: &str) -> Response {
    match executed {
        Executed::Fresh(version) => raw_json(200, &shape.body(*version), correlation),
        Executed::Replayed(stored) => raw_json(stored.status_code, &stored.body, correlation),
    }
}

fn raw_json(status: u16, body: &[u8], correlation: &str) -> Response {
    let response = (
        StatusCode::from_u16(status).unwrap_or(StatusCode::OK),
        [(header::CONTENT_TYPE, "application/json")],
        body.to_vec(),
    )
        .into_response();
    // 保存した応答かどうかは、利用者には区別させない（同じ応答）
    with_correlation(response, correlation)
}

fn role_of_name(name: &str) -> Option<Role> {
    Role::ALL.into_iter().find(|r| match r {
        Role::Factory => name == "FACTORY",
        Role::Distributor => name == "DISTRIBUTOR",
        Role::Wholesaler => name == "WHOLESALER",
        Role::Retailer => name == "RETAILER",
    })
}

fn field(name: &str, message: &str) -> FieldError {
    FieldError {
        field: name.to_owned(),
        message: message.to_owned(),
        week: None,
    }
}

async fn assign<B: Backend>(
    State(backend): State<Arc<B>>,
    Path((game, participant)): Path<(String, String)>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let correlation = correlation_id(&*backend, &headers);
    let result = async {
        let game_id = parse_game_id(&game)?;
        let participant_id = Uuid::parse_str(&participant)
            .map(|u| ParticipantId::new(u.as_u128()))
            .map_err(|_| Box::new(not_found()))?;
        let actor = authenticate_for(&*backend, &headers, game_id).await?;
        let parsed = parse_json(&body)?;
        let role = parsed
            .get("role")
            .and_then(Value::as_str)
            .and_then(role_of_name)
            .ok_or_else(|| {
                Box::new(validation_problem(vec![field(
                    "role",
                    "役割は FACTORY・DISTRIBUTOR・WHOLESALER・RETAILER のいずれかにしてください。",
                )]))
            })?;
        let idem = idempotency_for(
            &*backend,
            &headers,
            game_id,
            "assign_role",
            &format!("{participant}\n{parsed}"),
            ResponseShape::Game,
        )?;
        let store = backend.store(game_id);
        assign_role(
            &store,
            backend.env(),
            backend.settings(),
            actor,
            participant_id,
            role,
            Some(&idem),
        )
        .await
        .map(|executed| executed_response(&executed, ResponseShape::Game, &correlation))
        .map_err(|failure| Box::new(problem_of(&failure)))
    }
    .await;
    result.unwrap_or_else(|problem| problem_response(&problem, &correlation))
}

async fn start<B: Backend>(
    State(backend): State<Arc<B>>,
    Path(game): Path<String>,
    headers: HeaderMap,
) -> Response {
    let correlation = correlation_id(&*backend, &headers);
    let result = async {
        let game_id = parse_game_id(&game)?;
        let actor = authenticate_for(&*backend, &headers, game_id).await?;
        let idem = idempotency_for(
            &*backend,
            &headers,
            game_id,
            "start_game",
            "",
            ResponseShape::Both,
        )?;
        let store = backend.store(game_id);
        start_game(
            &store,
            backend.env(),
            backend.settings(),
            actor,
            Some(&idem),
        )
        .await
        .map(|executed| match executed {
            StartExecuted::Fresh(g, s) => {
                raw_json(200, &ResponseShape::body_both(g, s), &correlation)
            }
            StartExecuted::Replayed(stored) => {
                raw_json(stored.status_code, &stored.body, &correlation)
            }
        })
        .map_err(|failure| Box::new(problem_of(&failure)))
    }
    .await;
    result.unwrap_or_else(|problem| problem_response(&problem, &correlation))
}

/// `If-Match`（意思決定の版。`"3"` のように引用符で囲んでもよい）。無ければ 0。整数でなければ 422。
fn parse_if_match(headers: &HeaderMap) -> Result<DecisionVersion, Box<Problem>> {
    let Some(raw) = headers.get(header::IF_MATCH).and_then(|v| v.to_str().ok()) else {
        return Ok(DecisionVersion::ZERO);
    };
    raw.trim()
        .trim_matches('"')
        .parse::<u32>()
        .map(DecisionVersion::new)
        .map_err(|_| {
            Box::new(validation_problem(vec![field(
                "If-Match",
                "If-Match は意思決定の版（整数）にしてください。",
            )]))
        })
}

async fn decide<B: Backend>(
    State(backend): State<Arc<B>>,
    Path(session): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let correlation = correlation_id(&*backend, &headers);
    let result = async {
        let game_id = parse_game_id(&session)?;
        let actor = authenticate_for(&*backend, &headers, game_id).await?;
        let parsed = parse_json(&body)?;
        let expected = parse_if_match(&headers)?;
        let mut errors = Vec::new();
        let week = parsed
            .get("week")
            .and_then(Value::as_i64)
            .map(|n| Week::of(n).map_err(|e| crate::field_error(&e)));
        let quantity = parsed
            .get("quantity")
            .and_then(Value::as_i64)
            .map(|n| Quantity::of(n).map_err(|e| crate::field_error(&e)));
        if week.is_none() {
            errors.push(field("week", "週は 1 以上 50 以下の整数にしてください。"));
        }
        if quantity.is_none() {
            errors.push(field(
                "quantity",
                "数量は 0 以上 1000 以下の整数にしてください。",
            ));
        }
        let (Some(week), Some(quantity)) = (week, quantity) else {
            return Err(Box::new(validation_problem(errors)));
        };
        let (week, quantity) = match (week, quantity) {
            (Ok(w), Ok(q)) => (w, q),
            (w, q) => {
                return Err(Box::new(validation_problem(
                    w.err().into_iter().chain(q.err()).collect(),
                )));
            }
        };
        // 入力する役割は、資格から決まる。役割が無い操作者は、資格の失敗と同じ 403
        let role = match actor {
            Actor::Participant(id) => backend
                .participant_role(game_id, id)
                .await
                .map_err(|f| Box::new(problem_of(&f)))?,
            Actor::Facilitator(_) | Actor::Anonymous => None,
        }
        .ok_or_else(|| Box::new(problem_of(&AppFailure::Unauthorized)))?;
        let idem = idempotency_for(
            &*backend,
            &headers,
            game_id,
            "save_decision",
            &format!("{expected:?}\n{parsed}"),
            ResponseShape::Session,
        )?;
        let store = backend.store(game_id);
        save_decision(
            &store,
            backend.env(),
            backend.settings(),
            actor,
            role,
            week,
            quantity,
            expected,
            Some(&idem),
        )
        .await
        .map(|executed| executed_response(&executed, ResponseShape::Session, &correlation))
        .map_err(|failure| Box::new(problem_of(&failure)))
    }
    .await;
    result.unwrap_or_else(|problem| problem_response(&problem, &correlation))
}

async fn commit<B: Backend>(
    State(backend): State<Arc<B>>,
    Path((session, week_path)): Path<(String, i64)>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let correlation = correlation_id(&*backend, &headers);
    let result =
        async {
            let game_id = parse_game_id(&session)?;
            let actor = authenticate_for(&*backend, &headers, game_id).await?;
            let parsed = parse_json(&body)?;
            let requested = parsed.get("requestedWeek").and_then(Value::as_i64);
            let basis = parsed.get("basis");
            let version = |name: &str| {
                basis
                    .and_then(|b| b.get(name))
                    .and_then(Value::as_u64)
                    .and_then(|n| u32::try_from(n).ok())
                    .map(DecisionVersion::new)
            };
            let (
                Some(requested),
                Some(factory),
                Some(distributor),
                Some(wholesaler),
                Some(retailer),
            ) = (
                requested,
                version("FACTORY"),
                version("DISTRIBUTOR"),
                version("WHOLESALER"),
                version("RETAILER"),
            )
            else {
                return Err(Box::new(validation_problem(vec![field(
                    "basis",
                    "requestedWeek と、役割ごとの basis（0 以上の整数）が必要です。",
                )])));
            };
            if requested != week_path {
                return Err(Box::new(validation_problem(vec![field(
                    "requestedWeek",
                    "経路の週と requestedWeek を同じにしてください。",
                )])));
            }
            let week = Week::of(requested)
                .map_err(|e| Box::new(validation_problem(vec![crate::field_error(&e)])))?;
            let idem = idempotency_for(
                &*backend,
                &headers,
                game_id,
                "commit_week",
                &format!("{week_path}\n{parsed}"),
                ResponseShape::Session,
            )?;
            let store = backend.store(game_id);
            let basis = RoleMap {
                factory,
                distributor,
                wholesaler,
                retailer,
            };
            commit_week(
                &store,
                backend.env(),
                backend.settings(),
                actor,
                week,
                basis,
                Some(&idem),
            )
            .await
            .map(|executed| executed_response(&executed, ResponseShape::Session, &correlation))
            .map_err(|failure| Box::new(problem_of(&failure)))
        }
        .await;
    result.unwrap_or_else(|problem| problem_response(&problem, &correlation))
}
