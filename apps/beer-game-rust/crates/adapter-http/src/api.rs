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
    AppFailure, AppSettings, CreateGameInput, CredentialLookup, EXPORT_SCHEMA_VERSION, Env,
    EventStore, Executed, ExportInput, GameSnapshot, Idempotency, MetricSink, NoMetrics,
    ObservationSnapshot, RequestOutcome, ResponseShape, RetentionState, SealedIdempotency, Secret,
    SessionSnapshot, SessionWriter, StartExecuted, StoredResponse, assign_or_replace_role,
    authenticate, build_csv, build_json, checksum, commit_week, create_game, digest,
    find_invitation, invite_observer, join_game, join_observer, open_sealed, pause_session,
    recover, reissue_credential, request_metrics, resume_session, revoke_credential,
    revoke_observer_invitation, save_decision, set_commit_mode, start_game, submit_proxy_decision,
};
use beergame_domain::{
    Actor, CommitMode, ConditionsInput, DecisionVersion, GameEvent, GameId, Instant, ParticipantId,
    Quantity, Role, RoleMap, SessionEvent, Week,
};
use serde_json::{Value, json};
use uuid::Uuid;

use crate::operations::operation_of;
use crate::problem::{
    FieldError, Problem, bad_request_problem, game_not_ended_problem, invitation_invalid_problem,
    not_ready_problem, problem_of, rate_limited_problem, timeout_problem, validation_problem,
};
use crate::views::{Viewer, game_view, lobby_view, observation_view, review_view, session_view};

/// 外側（永続化・環境）への入口。アプリのバイナリが組み立てて渡す。
pub trait Backend: Send + Sync + 'static {
    type Env: Env + Send;
    type Store: EventStore<GameEvent>
        + EventStore<SessionEvent, Tx = <Self::Store as EventStore<GameEvent>>::Tx>
        + CredentialLookup
        + SessionWriter
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
    /// 進行（session）の状態。開始前は `None`。
    fn session_snapshot(
        &self,
        game_id: GameId,
    ) -> impl Future<Output = Result<Option<SessionSnapshot>, AppFailure>> + Send;
    /// ゲームの状態。存在しなければ `None`。
    fn game_snapshot(
        &self,
        game_id: GameId,
    ) -> impl Future<Output = Result<Option<GameSnapshot>, AppFailure>> + Send;
    /// 依存先（DB）に接続できるか。
    /// 観察の内容の元（観察者向けの表と公開範囲だけから作る）。
    fn observation_snapshot(
        &self,
        game_id: GameId,
    ) -> impl Future<Output = Result<Option<ObservationSnapshot>, AppFailure>> + Send;
    /// 保持状態（`retention_policies` と削除の進行）。
    fn retention_state(
        &self,
        game_id: GameId,
    ) -> impl Future<Output = Result<Option<RetentionState>, AppFailure>> + Send;
    /// 参加・復帰の失敗の窓に 1 を足し、足した後の回数を返す（検査の前に足す。NF-S11）。
    fn note_attempt(
        &self,
        scope: &str,
        key_digest: &str,
        window_start: Instant,
    ) -> impl Future<Output = Result<i64, AppFailure>> + Send;
    /// 暗号化して保存した冪等記録（作成・参加・再発行）を引く。`game_id` が無いのは作成（ゲームがまだ分からない）。
    fn stored_response(
        &self,
        game_id: Option<GameId>,
        scope: &str,
        key_digest: &str,
    ) -> impl Future<Output = Result<Option<(GameId, StoredResponse)>, AppFailure>> + Send;
    /// 足した 1 を戻す（認可の失敗でなかったとき）。0 を下回らない。
    fn forgive_attempt(
        &self,
        scope: &str,
        key_digest: &str,
        window_start: Instant,
    ) -> impl Future<Output = Result<(), AppFailure>> + Send;
    fn is_ready(&self) -> impl Future<Output = bool> + Send;
    /// コマンドの応答を待つ上限。超えても、コマンドの処理は最後まで走る（504 を返す）。
    fn command_timeout(&self) -> std::time::Duration {
        std::time::Duration::from_secs(10)
    }
    /// HTTPS の環境では Cookie に `Secure` を付ける。
    fn secure_cookies(&self) -> bool;
    /// メトリクスの出力先（B14）。既定は出さない。
    fn metrics(&self) -> &dyn MetricSink {
        &NoMetrics
    }
}

const SESSION_COOKIE: &str = "bg_session";
const SESSION_MAX_AGE_SECONDS: i64 = 86_400;
const RECOVERY_COOKIE: &str = "bg_recovery";
const RECOVERY_MAX_AGE_SECONDS: i64 = 2_592_000;
const RECOVER_PATH: &str = "/api/v1/participations/recover";

/// ルーターを作る。
pub fn router<B: Backend>(backend: Arc<B>) -> Router {
    Router::new()
        .route("/api/v1/health", get(health::<B>))
        .route("/api/v1/ready", get(ready::<B>))
        .route("/api/v1/games", post(create::<B>))
        .route("/api/v1/participations/join", post(join::<B>))
        .route("/api/v1/participations/recover", post(recover_route::<B>))
        .route(
            "/api/v1/games/{game_id}/credentials/revoke",
            post(revoke::<B>),
        )
        .route(
            "/api/v1/games/{game_id}/credentials/reissue",
            post(reissue::<B>),
        )
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
        .route("/api/v1/sessions/{session_id}/pause", post(pause::<B>))
        .route("/api/v1/sessions/{session_id}/resume", post(resume::<B>))
        .route(
            "/api/v1/sessions/{session_id}/commit-mode",
            put(commit_mode::<B>),
        )
        .route(
            "/api/v1/sessions/{session_id}/proxy-decisions/{role}",
            put(proxy_decision::<B>),
        )
        .route("/api/v1/games/{game_id}/state", get(game_state::<B>))
        .route("/api/v1/games/{game_id}/lobby", get(lobby::<B>))
        .route("/api/v1/games/{game_id}/review", get(review::<B>))
        .route("/api/v1/games/{game_id}/observation", get(observation::<B>))
        .route("/api/v1/games/{game_id}/exports", get(export::<B>))
        .route("/api/v1/games/{game_id}/retention", get(retention::<B>))
        .route(
            "/api/v1/games/{game_id}/observer-invitations",
            post(invite::<B>),
        )
        .route(
            "/api/v1/games/{game_id}/observer-invitations/{invitation_id}/revoke",
            post(revoke_invitation::<B>),
        )
        .route("/api/v1/participations/observe", post(observe::<B>))
        .route(
            "/api/v1/sessions/{session_id}/state",
            get(session_state::<B>),
        )
        .layer(axum::middleware::from_fn_with_state(
            Arc::clone(&backend),
            observe_request::<B>,
        ))
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
    // 契約（`Problem`）は、相関 ID（`correlationId`）を本文にも持つ
    let mut body = problem.body();
    if let Some(object) = body.as_object_mut() {
        object.insert("correlationId".to_owned(), json!(correlation));
    }
    let mut response = (
        status,
        [(header::CONTENT_TYPE, "application/problem+json")],
        body.to_string(),
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

/// 接続元の鍵付き要約（生の IP は保存しない）。`X-Forwarded-For` の先頭（信頼するリバースプロキシの付けた接続元）を使う。
fn source_digest<B: Backend>(backend: &B, headers: &HeaderMap) -> String {
    let source = headers
        .get("x-forwarded-for")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.split(',').next())
        .map_or("unknown", str::trim);
    digest(
        &backend.settings().credential_key,
        &Secret::new(format!("source:{source}")),
    )
    .unwrap_or_default()
}

/// 参加・復帰の失敗の窓。検査の前に 1 を足し、上限を超えていれば 429（再試行までの秒数つき）。
struct Attempt {
    scope: &'static str,
    key_digest: String,
    window_start: Instant,
}

impl Attempt {
    async fn begin<B: Backend>(
        backend: &B,
        headers: &HeaderMap,
        scope: &'static str,
    ) -> Result<Attempt, Box<Problem>> {
        let settings = backend.settings();
        let now = backend.env().now().epoch_millis();
        let window = settings.attempt_window_millis.max(1);
        let start = now - now.rem_euclid(window);
        let attempt = Attempt {
            scope,
            key_digest: source_digest(backend, headers),
            window_start: Instant::from_epoch_millis(start),
        };
        let count = backend
            .note_attempt(scope, &attempt.key_digest, attempt.window_start)
            .await
            .map_err(|f| Box::new(problem_of(&f)))?;
        if count > i64::from(settings.max_failed_attempts) {
            let remaining = start.saturating_add(window).saturating_sub(now);
            let seconds = u32::try_from(remaining.saturating_add(999) / 1000).unwrap_or(1);
            return Err(Box::new(rate_limited_problem(seconds.max(1))));
        }
        Ok(attempt)
    }

    /// 認可の失敗でなかったとき、足した 1 を戻す。
    async fn forgive<B: Backend>(&self, backend: &B) {
        // 戻せなくても、応答は変えない（数えすぎる側の誤り）
        drop(
            backend
                .forgive_attempt(self.scope, &self.key_digest, self.window_start)
                .await,
        );
    }
}

/// 秘密を含む応答（作成・参加・再発行）の冪等性。`Idempotency-Key` が無ければ記録しない（`None`）。
fn sealed_idempotency<B: Backend>(
    backend: &B,
    headers: &HeaderMap,
    scope: &str,
    request: &str,
) -> Result<Option<SealedIdempotency>, Box<Problem>> {
    let Some(key) = headers
        .get("idempotency-key")
        .and_then(|v| v.to_str().ok())
        .filter(|v| !v.is_empty() && v.len() <= 200)
    else {
        return Ok(None);
    };
    let secret_key = &backend.settings().credential_key;
    let internal = || {
        Box::new(problem_of(&AppFailure::Persistence(
            beergame_application::PersistenceFailure::Storage(
                "資格の鍵が設定されていない".to_owned(),
            ),
        )))
    };
    Ok(Some(SealedIdempotency {
        scope: scope.to_owned(),
        key_digest: digest(secret_key, &Secret::new(format!("idem:{key}"))).ok_or_else(internal)?,
        request_digest: digest(secret_key, &Secret::new(format!("{scope}\n{request}")))
            .ok_or_else(internal)?,
    }))
}

/// 作成の応答（201）。再送のときも同じ値で組み立てる。
fn created_response<B: Backend>(
    backend: &B,
    headers: &HeaderMap,
    game_id: GameId,
    game_version: u64,
    session: &str,
    recovery: &str,
) -> Response {
    let location = format!("/api/v1/games/{}/state", Uuid::from_u128(game_id.get()));
    let body = json!({
        "versions": {"game": game_version, "session": Value::Null},
        "recoveryCode": recovery,
    });
    let response = json_response(
        StatusCode::CREATED,
        &body,
        Some(&session_cookie(backend, headers, session)),
        Some(&location),
    );
    with_cookie(response, &recovery_cookie(backend, recovery))
}

/// 参加の応答（200）。再送のときも同じ値で組み立てる。
fn joined_response<B: Backend>(
    backend: &B,
    headers: &HeaderMap,
    game_id: GameId,
    game_version: u64,
    session: &str,
    recovery: &str,
) -> Response {
    let body = json!({
        "versions": {"game": game_version, "session": Value::Null},
        "gameId": Uuid::from_u128(game_id.get()).to_string(),
    });
    let response = json_response(
        StatusCode::OK,
        &body,
        Some(&session_cookie(backend, headers, session)),
        None,
    );
    with_cookie(response, &recovery_cookie(backend, recovery))
}

/// 復帰資格の Cookie（`bg_recovery`。復帰の経路にだけ送る）。
fn recovery_cookie<B: Backend>(backend: &B, token: &str) -> String {
    let secure = if backend.secure_cookies() {
        "; Secure"
    } else {
        ""
    };
    format!(
        "{RECOVERY_COOKIE}={token}; Path={RECOVER_PATH}; HttpOnly; SameSite=Strict; Max-Age={RECOVERY_MAX_AGE_SECONDS}{secure}"
    )
}

/// 応答に Set-Cookie を足す。
fn with_cookie(mut response: Response, cookie: &str) -> Response {
    if let Ok(value) = HeaderValue::from_str(cookie) {
        response.headers_mut().append(header::SET_COOKIE, value);
    }
    response
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
    // 種別 KIT に条件を付けると、カスタムで作成するよう示す（AC1.1.3）。値は null でも条件の指定とみなす
    let conditions = body.get("conditions").filter(|c| !c.is_null());
    if conditions.is_some() && body.get("kind").and_then(Value::as_str) != Some("CUSTOM") {
        errors.push(crate::field_error(
            &beergame_domain::ValidationError::ConditionsOnKit,
        ));
    }
    let conditions_input = conditions
        .map(parse_conditions)
        .transpose()
        .map_err(|more| errors.extend(more))
        .ok()
        .flatten()
        .unwrap_or_default();
    let commit_mode = match body.get("commitMode").and_then(Value::as_str) {
        None | Some("MANUAL") => CommitMode::Manual,
        Some("AUTO") => CommitMode::Auto,
        Some(_) => {
            errors.push(field(
                "commitMode",
                "確定方式は MANUAL か AUTO にしてください。",
            ));
            CommitMode::Manual
        }
    };
    match (final_week, errors.is_empty()) {
        (Some(final_week), true) => Ok(CreateGameInput {
            final_week,
            demand,
            conditions: conditions_input,
            commit_mode,
            retention_days: body.get("retentionDays").and_then(Value::as_i64),
        }),
        (_, _) => Err(errors),
    }
}

/// カスタム条件の入力（整数でない値は、項目ごとの誤りにする。範囲は domain が検証する）。
fn parse_conditions(value: &Value) -> Result<ConditionsInput, Vec<FieldError>> {
    let mut errors = Vec::new();
    let mut int = |name: &str| -> Option<i64> {
        let raw = value.get(name).filter(|v| !v.is_null())?;
        let parsed = raw.as_i64();
        if parsed.is_none() {
            errors.push(field(&format!("conditions.{name}"), "整数にしてください。"));
        }
        parsed
    };
    let initial_flow = int("initialFlow");
    let order_delay_weeks = int("orderDelayWeeks");
    let shipment_delay_weeks = int("shipmentDelayWeeks");
    let production_delay_weeks = int("productionDelayWeeks");
    let holding_cost_minor = int("holdingCostMinor");
    let backlog_cost_minor = int("backlogCostMinor");
    let mut initial_inventory = std::collections::BTreeMap::new();
    if let Some(map) = value.get("initialInventory").and_then(Value::as_object) {
        for (name, raw) in map {
            match (role_of_name(name), raw.as_i64()) {
                (Some(role), Some(n)) => {
                    initial_inventory.insert(role, n);
                }
                _ => errors.push(field(
                    &format!("conditions.initialInventory.{name}"),
                    "役割は FACTORY・DISTRIBUTOR・WHOLESALER・RETAILER、値は整数にしてください。",
                )),
            }
        }
    }
    // 文字列でない値は、どの公開範囲でもない（domain が拒否する）
    let disclosure_policy = value
        .get("disclosurePolicy")
        .filter(|v| !v.is_null())
        .map(|raw| raw.as_str().unwrap_or("").to_owned());
    if errors.is_empty() {
        Ok(ConditionsInput {
            initial_inventory,
            initial_flow,
            order_delay_weeks,
            shipment_delay_weeks,
            production_delay_weeks,
            holding_cost_minor,
            backlog_cost_minor,
            disclosure_policy,
        })
    } else {
        Err(errors)
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
    // 同じ `Idempotency-Key` の再送には、保存した（暗号化した）応答を返す。内容が違えば 409
    let sealed = match sealed_idempotency(&*backend, &headers, "create", &parsed.to_string()) {
        Ok(sealed) => sealed,
        Err(problem) => return problem_response(&problem, &correlation),
    };
    if let Some(sealed) = &sealed {
        match backend
            .stored_response(None, "create", &sealed.key_digest)
            .await
        {
            Ok(Some((game_id, stored))) => {
                return match open_sealed(backend.settings(), &sealed.request_digest, &stored) {
                    Ok(fields) => with_correlation(
                        created_response(
                            &*backend,
                            &headers,
                            game_id,
                            fields.game_version,
                            fields.first.expose(),
                            fields.second.expose(),
                        ),
                        &correlation,
                    ),
                    Err(failure) => problem_response(&problem_of(&failure), &correlation),
                };
            }
            Ok(None) => {}
            Err(failure) => return problem_response(&problem_of(&failure), &correlation),
        }
    }
    let game_id = GameId::new(backend.env().new_id());
    let store = backend.store(game_id);
    match create_game(
        &store,
        backend.env(),
        backend.settings(),
        game_id,
        &input,
        sealed.as_ref(),
    )
    .await
    {
        Ok(outcome) => with_correlation(
            created_response(
                &*backend,
                &headers,
                game_id,
                outcome.game_version,
                outcome.facilitator_credential.expose(),
                outcome.recovery_code.expose(),
            ),
            &correlation,
        ),
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
    // 試行の窓: 検査の前に 1 を足す。上限を超えていれば、正しい参加コードでも 429（NF-S11）
    let attempt = match Attempt::begin(&*backend, &headers, "join").await {
        Ok(attempt) => attempt,
        Err(problem) => return problem_response(&problem, &correlation),
    };
    // 参加コードの不明・形式不正は、区別せず同じ 403（列挙の防止。窓の失敗に数える）
    let game_id = match backend.game_by_join_code(code).await {
        Ok(Some(game_id)) => game_id,
        Ok(None) => return problem_response(&invitation_invalid_problem(), &correlation),
        Err(failure) => {
            attempt.forgive(&*backend).await;
            return problem_response(&problem_of(&failure), &correlation);
        }
    };
    let store = backend.store(game_id);
    // 参加コードが有効なら、認可の失敗ではない（以降の結果にかかわらず、窓の失敗には数えない）
    attempt.forgive(&*backend).await;
    let sealed = match sealed_idempotency(&*backend, &headers, "join", &parsed.to_string()) {
        Ok(sealed) => sealed,
        Err(problem) => return problem_response(&problem, &correlation),
    };
    if let Some(sealed) = &sealed {
        match backend
            .stored_response(Some(game_id), "join", &sealed.key_digest)
            .await
        {
            Ok(Some((_, stored))) => {
                return match open_sealed(backend.settings(), &sealed.request_digest, &stored) {
                    Ok(fields) => {
                        let version = backend
                            .game_snapshot(game_id)
                            .await
                            .ok()
                            .flatten()
                            .map_or(fields.game_version, |s| s.game_version);
                        with_correlation(
                            joined_response(
                                &*backend,
                                &headers,
                                game_id,
                                version,
                                fields.first.expose(),
                                fields.second.expose(),
                            ),
                            &correlation,
                        )
                    }
                    Err(failure) => problem_response(&problem_of(&failure), &correlation),
                };
            }
            Ok(None) => {}
            Err(failure) => return problem_response(&problem_of(&failure), &correlation),
        }
    }
    match join_game(
        &store,
        backend.env(),
        backend.settings(),
        game_id,
        name,
        sealed.as_ref(),
    )
    .await
    {
        Ok(outcome) => with_correlation(
            joined_response(
                &*backend,
                &headers,
                game_id,
                outcome.game_version,
                outcome.credential.expose(),
                outcome.recovery_code.expose(),
            ),
            &correlation,
        ),
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

/// Cookie ヘッダーから、資格の Cookie の値を取り出す。タブの名前の Cookie を優先し、無ければ従来の名前（`bg_session`）の
/// Cookie を使う（タブの識別子を付ける前に発行した資格、識別子を付けない呼び出し元が発行した資格の移行。ADR-020）。
fn credential_token(headers: &HeaderMap) -> Option<Secret<String>> {
    let cookies: Vec<(&str, &str)> = headers
        .get(header::COOKIE)
        .and_then(|v| v.to_str().ok())?
        .split(';')
        .filter_map(|pair| pair.trim().split_once('='))
        .collect();
    let find = |name: &str| {
        cookies
            .iter()
            .find(|(k, _)| *k == name)
            .map(|(_, v)| Secret::new((*v).to_owned()))
    };
    find(&cookie_name(headers)).or_else(|| find(SESSION_COOKIE))
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

fn query_role(query: Option<&str>) -> Result<Option<Role>, Box<Problem>> {
    let Some(query) = query else { return Ok(None) };
    query
        .split('&')
        .filter_map(|pair| pair.split_once('='))
        .find(|(k, _)| *k == "role")
        .map_or(Ok(None), |(_, v)| {
            role_of_name(v).map(Some).ok_or_else(|| {
                Box::new(validation_problem(vec![field(
                    "role",
                    "役割は FACTORY・DISTRIBUTOR・WHOLESALER・RETAILER のいずれかにしてください。",
                )]))
            })
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
    let backend_task = Arc::clone(&backend);
    let correlation_task = correlation.clone();
    let limit = backend.command_timeout();
    let result = detached(limit, async move {
        let backend = backend_task;
        let correlation = correlation_task;
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
        // 準備中は割り当て・付け替え、開始後は入れ替え（旧担当者の資格を同じトランザクションで失効）
        assign_or_replace_role(
            &store,
            backend.env(),
            backend.settings(),
            actor,
            participant_id,
            role,
            Some(&idem),
        )
        .await
        .map(|executed| match executed {
            StartExecuted::Fresh(g, s) => {
                raw_json(200, &ResponseShape::body_both(g, s), &correlation)
            }
            StartExecuted::FreshGame(g) => {
                raw_json(200, &ResponseShape::Game.body(g), &correlation)
            }
            StartExecuted::Replayed(stored) => {
                raw_json(stored.status_code, &stored.body, &correlation)
            }
        })
        .map_err(|failure| Box::new(problem_of(&failure)))
    })
    .await;
    result.unwrap_or_else(|problem| problem_response(&problem, &correlation))
}

async fn start<B: Backend>(
    State(backend): State<Arc<B>>,
    Path(game): Path<String>,
    headers: HeaderMap,
) -> Response {
    let correlation = correlation_id(&*backend, &headers);
    let backend_task = Arc::clone(&backend);
    let correlation_task = correlation.clone();
    let limit = backend.command_timeout();
    let result = detached(limit, async move {
        let backend = backend_task;
        let correlation = correlation_task;
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
            StartExecuted::FreshGame(g) => {
                raw_json(200, &ResponseShape::Game.body(g), &correlation)
            }
            StartExecuted::Replayed(stored) => {
                raw_json(stored.status_code, &stored.body, &correlation)
            }
        })
        .map_err(|failure| Box::new(problem_of(&failure)))
    })
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

/// 失敗を problem にする。競合（`session.decision_conflict`・`session.decisions_changed`）には、最新の入力に
/// 保存者（`DecisionEditor`）と保存の時刻を添える（表示名は、同じ役割の共同担当と進行役にだけ。呼び出した人の見え方で作る）。
async fn conflict_problem<B: Backend>(
    backend: &B,
    game_id: GameId,
    actor: &Actor,
    failure: &AppFailure,
) -> Problem {
    use beergame_application::DomainError;
    use beergame_domain::SessionError;
    let mut problem = problem_of(failure);
    let AppFailure::Domain(DomainError::Session(error)) = failure else {
        return problem;
    };
    let viewer = match actor {
        Actor::Participant(id) => backend
            .participant_role(game_id, *id)
            .await
            .ok()
            .flatten()
            .map(|role| Viewer::Participant(id.get(), role)),
        Actor::Facilitator(_) => Some(Viewer::Facilitator),
        Actor::Anonymous | Actor::Observer(_) => None,
    };
    let (Some(viewer), Ok(Some(snapshot))) = (viewer, backend.session_snapshot(game_id).await)
    else {
        return problem;
    };
    let entry_json = |role: Role, entry: &beergame_domain::DecisionEntry| {
        let current = snapshot.roles.iter().find(|r| r.role == role);
        let editor = current
            .and_then(|r| r.editor.as_ref())
            .map(|e| crate::views::editor_json(e, &viewer));
        json!({
            "quantity": entry.quantity.get(),
            "version": entry.version.get(),
            "editor": editor.unwrap_or(Value::Null),
            "savedAt": current
                .and_then(|r| r.saved_at_millis)
                .map_or(Value::Null, |ms| json!(crate::views::rfc3339_millis(ms))),
        })
    };
    match error {
        SessionError::DecisionConflict {
            role,
            latest: Some(entry),
        } => {
            problem
                .extras
                .insert("latest".to_owned(), entry_json(*role, entry));
        }
        SessionError::DecisionsChanged { current, .. } => {
            let entries: serde_json::Map<String, Value> = current
                .iter()
                .map(|(role, entry)| {
                    (
                        crate::views::role_name(*role).to_owned(),
                        entry_json(*role, entry),
                    )
                })
                .collect();
            problem
                .extras
                .insert("current".to_owned(), Value::Object(entries));
        }
        SessionError::DecisionConflict { latest: None, .. }
        | SessionError::NotActive
        | SessionError::AlreadyEnded
        | SessionError::AlreadyStarted
        | SessionError::SaveLimitReached
        | SessionError::Paused
        | SessionError::NotPaused
        | SessionError::Forbidden(_)
        | SessionError::WeekAdvanced { .. }
        | SessionError::IncompleteDecisions { .. } => {}
    }
    problem
}

async fn decide<B: Backend>(
    State(backend): State<Arc<B>>,
    Path(session): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let correlation = correlation_id(&*backend, &headers);
    let backend_task = Arc::clone(&backend);
    let correlation_task = correlation.clone();
    let limit = backend.command_timeout();
    let result = detached(limit, async move {
        let backend = backend_task;
        let correlation = correlation_task;
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
            Actor::Facilitator(_) | Actor::Observer(_) | Actor::Anonymous => None,
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
        match save_decision(
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
        {
            Ok(executed) => Ok(executed_response(
                &executed,
                ResponseShape::Session,
                &correlation,
            )),
            Err(failure) => Err(Box::new(
                conflict_problem(&*backend, game_id, &actor, &failure).await,
            )),
        }
    })
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
    let backend_task = Arc::clone(&backend);
    let correlation_task = correlation.clone();
    let limit = backend.command_timeout();
    let result =
        detached(limit, async move {
            let backend = backend_task;
            let correlation = correlation_task;
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
            match commit_week(
                &store,
                backend.env(),
                backend.settings(),
                actor,
                week,
                basis,
                Some(&idem),
            )
            .await
            {
                Ok(executed) => Ok(executed_response(
                    &executed,
                    ResponseShape::Session,
                    &correlation,
                )),
                Err(failure) => Err(Box::new(
                    conflict_problem(&*backend, game_id, &actor, &failure).await,
                )),
            }
        })
        .await;
    result.unwrap_or_else(|problem| problem_response(&problem, &correlation))
}

async fn game_state<B: Backend>(
    State(backend): State<Arc<B>>,
    Path(game): Path<String>,
    headers: HeaderMap,
) -> Response {
    let correlation = correlation_id(&*backend, &headers);
    let result = async {
        let game_id = parse_game_id(&game)?;
        let actor = authenticate_for(&*backend, &headers, game_id).await?;
        if matches!(actor, Actor::Observer(_)) {
            // 観察者は、ゲームの状態（参加コードを含む）を取得できない。観察画面だけ
            return Err(Box::new(problem_of(&AppFailure::Unauthorized)));
        }
        let snapshot = backend
            .game_snapshot(game_id)
            .await
            .map_err(|f| Box::new(problem_of(&f)))?
            .ok_or_else(|| Box::new(problem_of(&AppFailure::Unauthorized)))?;
        let role = match actor {
            Actor::Participant(id) => backend
                .participant_role(game_id, id)
                .await
                .map_err(|f| Box::new(problem_of(&f)))?,
            Actor::Facilitator(_) | Actor::Observer(_) | Actor::Anonymous => None,
        };
        Ok(json_response(
            StatusCode::OK,
            &game_view(&snapshot, &actor, role),
            None,
            None,
        ))
    }
    .await;
    result
        .map(|response: Response| with_correlation(response, &correlation))
        .unwrap_or_else(|problem: Box<Problem>| problem_response(&problem, &correlation))
}

async fn session_state<B: Backend>(
    State(backend): State<Arc<B>>,
    Path(session): Path<String>,
    axum::extract::RawQuery(query): axum::extract::RawQuery,
    headers: HeaderMap,
) -> Response {
    let correlation = correlation_id(&*backend, &headers);
    let result = async {
        let game_id = parse_game_id(&session)?;
        let actor = authenticate_for(&*backend, &headers, game_id).await?;
        let wanted = query_role(query.as_deref())?;
        let viewer = match actor {
            Actor::Facilitator(_) => Viewer::Facilitator,
            Actor::Participant(id) => {
                let own = backend
                    .participant_role(game_id, id)
                    .await
                    .map_err(|f| Box::new(problem_of(&f)))?
                    .ok_or_else(|| Box::new(problem_of(&AppFailure::Unauthorized)))?;
                // 他の役割の状況の問い合わせは、値を返さず 403（AC2.1.2）
                if wanted.is_some_and(|w| w != own) {
                    return Err(Box::new(problem_of(&AppFailure::Unauthorized)));
                }
                Viewer::Participant(id.get(), own)
            }
            Actor::Anonymous | Actor::Observer(_) => {
                return Err(Box::new(problem_of(&AppFailure::Unauthorized)));
            }
        };
        let snapshot = backend
            .session_snapshot(game_id)
            .await
            .map_err(|f| Box::new(problem_of(&f)))?
            .ok_or_else(|| {
                Box::new(problem_of(&AppFailure::Domain(
                    beergame_application::DomainError::Session(
                        beergame_domain::SessionError::NotActive,
                    ),
                )))
            })?;
        Ok(json_response(
            StatusCode::OK,
            &session_view(&snapshot, &viewer),
            None,
            None,
        ))
    }
    .await;
    result
        .map(|response: Response| with_correlation(response, &correlation))
        .unwrap_or_else(|problem: Box<Problem>| problem_response(&problem, &correlation))
}

/// コマンドの処理を、**別のタスクで実行する**（RB2）。クライアントが切断してルートの future が drop されても、
/// 処理は最後まで走る（COMMIT が中途半端にならない）。応答の待ちには上限があり、超えたら 504（`type` なし）を返す。
/// 処理そのものは止めない（実行済みの可能性があるので、画面は同じ `Idempotency-Key` で再送する）。
async fn detached<T: Send + 'static>(
    limit: std::time::Duration,
    work: impl Future<Output = Result<T, Box<Problem>>> + Send + 'static,
) -> Result<T, Box<Problem>> {
    let mut handle = tokio::spawn(work);
    match tokio::time::timeout(limit, &mut handle).await {
        Ok(Ok(result)) => result,
        // タスクの panic。利用者には相関 ID だけを返す（500）。release は panic = "unwind" が前提
        Ok(Err(_)) => Err(Box::new(problem_of(&AppFailure::Persistence(
            beergame_application::PersistenceFailure::Storage("タスクが異常終了した".to_owned()),
        )))),
        Err(_) => Err(Box::new(timeout_problem())),
    }
}

/// すべての応答に付けるセキュリティヘッダー（NF-S9。成功・拒否・存在しない経路のすべて）。
/// API は JSON だけを返すので、CSP は何も読み込まない設定（画面は CloudFront の別のポリシー）。
/// HSTS の max-age は、CloudFront のヘッダーポリシー（`infra/modules/web`）と同じ（1 年）。
const SECURITY_HEADERS: [(&str, &str); 5] = [
    (
        "content-security-policy",
        "default-src 'none'; frame-ancestors 'none'",
    ),
    (
        "strict-transport-security",
        "max-age=31536000; includeSubDomains",
    ),
    ("x-content-type-options", "nosniff"),
    ("referrer-policy", "no-referrer"),
    ("cache-control", "no-store"),
];

fn apply_security_headers(headers: &mut HeaderMap) {
    for (name, value) in SECURITY_HEADERS {
        headers.insert(
            HeaderName::from_static(name),
            HeaderValue::from_static(value),
        );
    }
}

/// 構造化ログ（AC6.1.1）。**相関 ID・操作（メソッドと経路）・結果（状態）・所要時間**だけを出す。
/// Cookie（資格）・本文（表示名・数量）・参加コード・クエリは含めない。
/// あわせて、要求ごとのメトリクス（応答時間・要求数・5xx・主要な操作の成功）を出す（AC6.1.3）。
/// メトリクスの操作名は、経路のテンプレートから引く固定の集合（URL の実値は入らない）。
async fn observe_request<B: Backend>(
    State(backend): State<Arc<B>>,
    request: axum::extract::Request,
    next: axum::middleware::Next,
) -> Response {
    let method = request.method().to_string();
    let path = request.uri().path().to_owned();
    let started = std::time::Instant::now();
    let mut response = next.run(request).await;
    apply_security_headers(response.headers_mut());
    let status = response.status().as_u16();
    let correlation = response
        .headers()
        .get("x-correlation-id")
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default()
        .to_owned();
    let elapsed_ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);
    if status >= 500 {
        tracing::error!(target: "http", correlation_id = %correlation, %method, %path, status, elapsed_ms, "request failed");
    } else {
        tracing::info!(target: "http", correlation_id = %correlation, %method, %path, status, elapsed_ms, "request");
    }
    let outcome = RequestOutcome {
        operation: operation_of(&method, &path).to_owned(),
        status,
        duration_millis: elapsed_ms,
    };
    backend.metrics().record(&request_metrics(
        &outcome,
        backend.env().now().epoch_millis(),
    ));
    response
}

/// ロビー（進行役だけ）。参加者・無資格は、資格の失敗と同じ 403。
async fn lobby<B: Backend>(
    State(backend): State<Arc<B>>,
    Path(game): Path<String>,
    headers: HeaderMap,
) -> Response {
    let correlation = correlation_id(&*backend, &headers);
    let result = async {
        let game_id = parse_game_id(&game)?;
        let actor = authenticate_for(&*backend, &headers, game_id).await?;
        if !actor.is_facilitator_of(game_id) {
            return Err(Box::new(problem_of(&AppFailure::Unauthorized)));
        }
        let snapshot = backend
            .game_snapshot(game_id)
            .await
            .map_err(|f| Box::new(problem_of(&f)))?
            .ok_or_else(|| Box::new(problem_of(&AppFailure::Unauthorized)))?;
        Ok(json_response(
            StatusCode::OK,
            &lobby_view(&snapshot),
            None,
            None,
        ))
    }
    .await;
    result
        .map(|response: Response| with_correlation(response, &correlation))
        .unwrap_or_else(|problem: Box<Problem>| problem_response(&problem, &correlation))
}

/// 終了後の振り返り（進行役・参加者。観察者は B9）。終了するまでは開示しない（409）。
async fn review<B: Backend>(
    State(backend): State<Arc<B>>,
    Path(game): Path<String>,
    headers: HeaderMap,
) -> Response {
    let correlation = correlation_id(&*backend, &headers);
    let result = async {
        let game_id = parse_game_id(&game)?;
        let actor = authenticate_for(&*backend, &headers, game_id).await?;
        if matches!(actor, Actor::Anonymous) {
            return Err(Box::new(problem_of(&AppFailure::Unauthorized)));
        }
        let ended = backend
            .session_snapshot(game_id)
            .await
            .map_err(|f| Box::new(problem_of(&f)))?
            .filter(|s| s.status == "ENDED")
            .ok_or_else(|| Box::new(game_not_ended_problem()))?;
        let snapshot = backend
            .game_snapshot(game_id)
            .await
            .map_err(|f| Box::new(problem_of(&f)))?
            .ok_or_else(|| Box::new(problem_of(&AppFailure::Unauthorized)))?;
        Ok(json_response(
            StatusCode::OK,
            &review_view(&ended, &snapshot),
            None,
            None,
        ))
    }
    .await;
    result
        .map(|response: Response| with_correlation(response, &correlation))
        .unwrap_or_else(|problem: Box<Problem>| problem_response(&problem, &correlation))
}

/// 停止・再開（進行役だけ。本文なし）。`scope` は冪等記録の範囲、`run` が実際の操作。
async fn session_control<B, F, Fut>(
    backend: Arc<B>,
    session: String,
    headers: HeaderMap,
    scope: &'static str,
    run: F,
) -> Response
where
    B: Backend,
    F: FnOnce(Arc<B>, GameId, Actor, Idempotency) -> Fut + Send + 'static,
    Fut: Future<Output = Result<Executed, AppFailure>> + Send + 'static,
{
    let correlation = correlation_id(&*backend, &headers);
    let correlation_task = correlation.clone();
    let limit = backend.command_timeout();
    let result = detached(limit, async move {
        let game_id = parse_game_id(&session)?;
        let actor = authenticate_for(&*backend, &headers, game_id).await?;
        let idem = idempotency_for(
            &*backend,
            &headers,
            game_id,
            scope,
            "",
            ResponseShape::Session,
        )?;
        run(backend, game_id, actor, idem)
            .await
            .map(|executed| executed_response(&executed, ResponseShape::Session, &correlation_task))
            .map_err(|failure| Box::new(problem_of(&failure)))
    })
    .await;
    result.unwrap_or_else(|problem| problem_response(&problem, &correlation))
}

async fn pause<B: Backend>(
    State(backend): State<Arc<B>>,
    Path(session): Path<String>,
    headers: HeaderMap,
) -> Response {
    session_control(
        backend,
        session,
        headers,
        "pause_session",
        |b, game, actor, idem| async move {
            pause_session(&b.store(game), b.env(), b.settings(), actor, Some(&idem)).await
        },
    )
    .await
}

async fn resume<B: Backend>(
    State(backend): State<Arc<B>>,
    Path(session): Path<String>,
    headers: HeaderMap,
) -> Response {
    session_control(
        backend,
        session,
        headers,
        "resume_session",
        |b, game, actor, idem| async move {
            resume_session(&b.store(game), b.env(), b.settings(), actor, Some(&idem)).await
        },
    )
    .await
}

/// 進行役の代理入力。意思決定の版は要求せず、`requestedWeek` で古い画面を区別する。
async fn proxy_decision<B: Backend>(
    State(backend): State<Arc<B>>,
    Path((session, role_path)): Path<(String, String)>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let correlation = correlation_id(&*backend, &headers);
    let correlation_task = correlation.clone();
    let limit = backend.command_timeout();
    let result = detached(limit, async move {
        let game_id = parse_game_id(&session)?;
        let actor = authenticate_for(&*backend, &headers, game_id).await?;
        let parsed = parse_json(&body)?;
        let role = role_of_name(&role_path).ok_or_else(|| {
            Box::new(validation_problem(vec![field(
                "role",
                "役割は FACTORY・DISTRIBUTOR・WHOLESALER・RETAILER のどれかにしてください。",
            )]))
        })?;
        let week = parsed
            .get("requestedWeek")
            .and_then(Value::as_i64)
            .map(|n| Week::of(n).map_err(|e| crate::field_error(&e)));
        let quantity = parsed
            .get("quantity")
            .and_then(Value::as_i64)
            .map(|n| Quantity::of(n).map_err(|e| crate::field_error(&e)));
        let (week, quantity) = match (week, quantity) {
            (Some(Ok(w)), Some(Ok(q))) => (w, q),
            (w, q) => {
                let mut errors: Vec<FieldError> = Vec::new();
                match w {
                    None => errors.push(field(
                        "requestedWeek",
                        "週は 1 以上 50 以下の整数にしてください。",
                    )),
                    Some(Err(e)) => errors.push(e),
                    Some(Ok(_)) => {}
                }
                match q {
                    None => errors.push(field(
                        "quantity",
                        "数量は 0 以上 1000 以下の整数にしてください。",
                    )),
                    Some(Err(e)) => errors.push(e),
                    Some(Ok(_)) => {}
                }
                return Err(Box::new(validation_problem(errors)));
            }
        };
        let idem = idempotency_for(
            &*backend,
            &headers,
            game_id,
            "proxy_decision",
            &format!("{role_path}\n{parsed}"),
            ResponseShape::Session,
        )?;
        submit_proxy_decision(
            &backend.store(game_id),
            backend.env(),
            backend.settings(),
            actor,
            role,
            week,
            quantity,
            Some(&idem),
        )
        .await
        .map(|executed| executed_response(&executed, ResponseShape::Session, &correlation_task))
        .map_err(|failure| Box::new(problem_of(&failure)))
    })
    .await;
    result.unwrap_or_else(|problem| problem_response(&problem, &correlation))
}

/// 復帰資格を、Cookie `bg_recovery` から取り出す。
fn recovery_token_from_cookie(headers: &HeaderMap) -> Option<Secret<String>> {
    headers
        .get(header::COOKIE)
        .and_then(|v| v.to_str().ok())?
        .split(';')
        .filter_map(|pair| pair.trim().split_once('='))
        .find(|(k, _)| *k == RECOVERY_COOKIE)
        .map(|(_, v)| Secret::new(v.to_owned()))
}

/// 復帰（復帰資格が認可）。復帰コード（本文）か Cookie `bg_recovery`。無効な資格は、理由を区別しない 403。
async fn recover_route<B: Backend>(
    State(backend): State<Arc<B>>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let correlation = correlation_id(&*backend, &headers);
    let result = async {
        let parsed = parse_json(&body)?;
        let game_id = parsed
            .get("gameId")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                Box::new(validation_problem(vec![field(
                    "gameId",
                    "復帰するゲームの ID が必要です。",
                )]))
            })
            .and_then(parse_game_id)?;
        // 試行の窓: 検査の前に 1 を足し、復帰できたら戻す（失敗だけが数えられる）
        let attempt = Attempt::begin(&*backend, &headers, "recover").await?;
        let token = parsed
            .get("recoveryCode")
            .and_then(Value::as_str)
            .map(|code| Secret::new(code.to_owned()))
            .or_else(|| recovery_token_from_cookie(&headers))
            .ok_or_else(|| Box::new(problem_of(&AppFailure::Unauthorized)))?;
        let outcome = recover(
            &backend.store(game_id),
            backend.env(),
            backend.settings(),
            game_id,
            &token,
        )
        .await
        .map_err(|f| Box::new(problem_of(&f)))?;
        attempt.forgive(&*backend).await;
        let snapshot = backend
            .game_snapshot(game_id)
            .await
            .map_err(|f| Box::new(problem_of(&f)))?;
        let (game_version, session_version) =
            snapshot.map_or((0, None), |s| (s.game_version, s.session_version));
        let (kind, role) = match outcome.actor {
            Actor::Participant(id) => (
                "PARTICIPANT",
                backend
                    .participant_role(game_id, id)
                    .await
                    .map_err(|f| Box::new(problem_of(&f)))?,
            ),
            Actor::Facilitator(_) | Actor::Observer(_) | Actor::Anonymous => ("FACILITATOR", None),
        };
        let mut view = json!({
            "versions": {"game": game_version, "session": session_version},
            "gameId": Uuid::from_u128(game_id.get()).to_string(),
            "kind": kind,
        });
        if let (Some(role), Some(object)) = (role, view.as_object_mut()) {
            object.insert("role".to_owned(), json!(crate::views::role_name(role)));
        }
        let cookie = session_cookie(&*backend, &headers, outcome.session.expose());
        Ok(json_response(StatusCode::OK, &view, Some(&cookie), None))
    }
    .await;
    result
        .map(|response: Response| with_correlation(response, &correlation))
        .unwrap_or_else(|problem: Box<Problem>| problem_response(&problem, &correlation))
}

/// 失効・再発行の対象（`{"subject": {"kind": "PARTICIPANT", "id": <uuid>}}`）。
fn parse_subject(parsed: &Value) -> Result<ParticipantId, Box<Problem>> {
    let subject = parsed.get("subject");
    let kind = subject.and_then(|s| s.get("kind")).and_then(Value::as_str);
    let id = subject
        .and_then(|s| s.get("id"))
        .and_then(Value::as_str)
        .and_then(|text| Uuid::parse_str(text).ok());
    match (kind, id) {
        (Some("PARTICIPANT"), Some(id)) => Ok(ParticipantId::new(id.as_u128())),
        _ => Err(Box::new(validation_problem(vec![field(
            "subject",
            "対象は {kind: PARTICIPANT, id: 参加者の ID} にしてください。",
        )]))),
    }
}

async fn revoke<B: Backend>(
    State(backend): State<Arc<B>>,
    Path(game): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let correlation = correlation_id(&*backend, &headers);
    let correlation_task = correlation.clone();
    let limit = backend.command_timeout();
    let result = detached(limit, async move {
        let game_id = parse_game_id(&game)?;
        let actor = authenticate_for(&*backend, &headers, game_id).await?;
        let parsed = parse_json(&body)?;
        let participant_id = parse_subject(&parsed)?;
        let idem = idempotency_for(
            &*backend,
            &headers,
            game_id,
            "revoke_credential",
            &parsed.to_string(),
            ResponseShape::Game,
        )?;
        revoke_credential(
            &backend.store(game_id),
            backend.env(),
            backend.settings(),
            actor,
            participant_id,
            Some(&idem),
        )
        .await
        .map(|executed| executed_response(&executed, ResponseShape::Game, &correlation_task))
        .map_err(|failure| Box::new(problem_of(&failure)))
    })
    .await;
    result.unwrap_or_else(|problem| problem_response(&problem, &correlation))
}

/// 再発行。新しい復帰コードを、この応答で一度だけ示す（応答は冪等記録に保存しない。秘密を含むため）。
async fn reissue<B: Backend>(
    State(backend): State<Arc<B>>,
    Path(game): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let correlation = correlation_id(&*backend, &headers);
    let correlation_task = correlation.clone();
    let limit = backend.command_timeout();
    let result = detached(limit, async move {
        let game_id = parse_game_id(&game)?;
        let actor = authenticate_for(&*backend, &headers, game_id).await?;
        let parsed = parse_json(&body)?;
        let participant_id = parse_subject(&parsed)?;
        // Idempotency-Key は必須。再送には、暗号化して保存した同じ復帰コードを返す
        idempotency_for(
            &*backend,
            &headers,
            game_id,
            "reissue_credential",
            &parsed.to_string(),
            ResponseShape::Game,
        )?;
        let sealed = sealed_idempotency(
            &*backend,
            &headers,
            "reissue_credential",
            &parsed.to_string(),
        )?;
        if let Some(sealed) = &sealed
            && let Some((_, stored)) = backend
                .stored_response(Some(game_id), "reissue_credential", &sealed.key_digest)
                .await
                .map_err(|f| Box::new(problem_of(&f)))?
        {
            let fields = open_sealed(backend.settings(), &sealed.request_digest, &stored)
                .map_err(|f| Box::new(problem_of(&f)))?;
            let expires = fields.second.expose().parse::<i64>().unwrap_or_default();
            let version = backend
                .game_snapshot(game_id)
                .await
                .ok()
                .flatten()
                .map_or(0, |s| s.game_version);
            let view = json!({
                "versions": {"game": version, "session": Value::Null},
                "recoveryCode": fields.first.expose(),
                "expiresAt": expires_at_text(Instant::from_epoch_millis(expires)),
            });
            return Ok(with_correlation(
                json_response(StatusCode::OK, &view, None, None),
                &correlation_task,
            ));
        }
        let outcome = reissue_credential(
            &backend.store(game_id),
            backend.env(),
            backend.settings(),
            actor,
            participant_id,
            sealed.as_ref(),
        )
        .await
        .map_err(|failure| Box::new(problem_of(&failure)))?;
        let view = json!({
            "versions": {"game": outcome.game_version, "session": Value::Null},
            "recoveryCode": outcome.recovery_code.expose(),
            "expiresAt": expires_at_text(outcome.expires_at),
        });
        Ok(with_correlation(
            json_response(StatusCode::OK, &view, None, None),
            &correlation_task,
        ))
    })
    .await;
    result.unwrap_or_else(|problem| problem_response(&problem, &correlation))
}

/// 期限を RFC 3339（UTC、ミリ秒）の文字列にする。
fn expires_at_text(at: Instant) -> String {
    crate::views::rfc3339_millis(at.epoch_millis())
}

/// 確定方式の変更（進行役だけ）。本文は `{"commitMode": "MANUAL" | "AUTO"}`。
async fn commit_mode<B: Backend>(
    State(backend): State<Arc<B>>,
    Path(session): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let correlation = correlation_id(&*backend, &headers);
    let correlation_task = correlation.clone();
    let limit = backend.command_timeout();
    let result = detached(limit, async move {
        let game_id = parse_game_id(&session)?;
        let actor = authenticate_for(&*backend, &headers, game_id).await?;
        let parsed = parse_json(&body)?;
        let mode = match parsed.get("commitMode").and_then(Value::as_str) {
            Some("MANUAL") => CommitMode::Manual,
            Some("AUTO") => CommitMode::Auto,
            _ => {
                return Err(Box::new(validation_problem(vec![field(
                    "commitMode",
                    "確定方式は MANUAL か AUTO にしてください。",
                )])));
            }
        };
        let idem = idempotency_for(
            &*backend,
            &headers,
            game_id,
            "commit_mode",
            &parsed.to_string(),
            ResponseShape::Session,
        )?;
        match set_commit_mode(
            &backend.store(game_id),
            backend.env(),
            backend.settings(),
            actor,
            mode,
            Some(&idem),
        )
        .await
        {
            Ok(executed) => Ok(executed_response(
                &executed,
                ResponseShape::Session,
                &correlation_task,
            )),
            Err(failure) => Err(Box::new(problem_of(&failure))),
        }
    })
    .await;
    result.unwrap_or_else(|problem| problem_response(&problem, &correlation))
}

/// 観察画面（進行役と、そのゲームの観察者。参加者・資格の無い人・別のゲームは 403）。
async fn observation<B: Backend>(
    State(backend): State<Arc<B>>,
    Path(game): Path<String>,
    headers: HeaderMap,
) -> Response {
    let correlation = correlation_id(&*backend, &headers);
    let result = async {
        let game_id = parse_game_id(&game)?;
        let actor = authenticate_for(&*backend, &headers, game_id).await?;
        if !matches!(actor, Actor::Facilitator(_) | Actor::Observer(_)) {
            return Err(Box::new(problem_of(&AppFailure::Unauthorized)));
        }
        let snapshot = backend
            .observation_snapshot(game_id)
            .await
            .map_err(|f| Box::new(problem_of(&f)))?
            .ok_or_else(|| Box::new(problem_of(&AppFailure::Unauthorized)))?;
        Ok(json_response(
            StatusCode::OK,
            &observation_view(&snapshot),
            None,
            None,
        ))
    }
    .await;
    result
        .map(|response: Response| with_correlation(response, &correlation))
        .unwrap_or_else(|problem: Box<Problem>| problem_response(&problem, &correlation))
}

/// 観察用の招待の発行（進行役だけ）。招待コードは、この応答で一度だけ示す。
async fn invite<B: Backend>(
    State(backend): State<Arc<B>>,
    Path(game): Path<String>,
    headers: HeaderMap,
) -> Response {
    let correlation = correlation_id(&*backend, &headers);
    let correlation_task = correlation.clone();
    let limit = backend.command_timeout();
    let result = detached(limit, async move {
        let game_id = parse_game_id(&game)?;
        let actor = authenticate_for(&*backend, &headers, game_id).await?;
        let outcome = invite_observer(
            &backend.store(game_id),
            backend.env(),
            backend.settings(),
            actor,
        )
        .await
        .map_err(|f| Box::new(problem_of(&f)))?;
        let view = json!({
            "versions": {"game": outcome.game_version, "session": Value::Null},
            "invitationId": Uuid::from_u128(outcome.invitation_id.get()).to_string(),
            "invitationCode": outcome.invitation_code.expose(),
            "expiresAt": expires_at_text(outcome.expires_at),
        });
        Ok(with_correlation(
            json_response(StatusCode::OK, &view, None, None),
            &correlation_task,
        ))
    })
    .await;
    result.unwrap_or_else(|problem| problem_response(&problem, &correlation))
}

/// 観察用の招待の失効（進行役だけ）。
async fn revoke_invitation<B: Backend>(
    State(backend): State<Arc<B>>,
    Path((game, invitation)): Path<(String, String)>,
    headers: HeaderMap,
) -> Response {
    let correlation = correlation_id(&*backend, &headers);
    let correlation_task = correlation.clone();
    let limit = backend.command_timeout();
    let result = detached(limit, async move {
        let game_id = parse_game_id(&game)?;
        let actor = authenticate_for(&*backend, &headers, game_id).await?;
        let invitation_id = Uuid::parse_str(&invitation)
            .map(|u| beergame_domain::InvitationId::new(u.as_u128()))
            .map_err(|_| Box::new(not_found()))?;
        let idem = idempotency_for(
            &*backend,
            &headers,
            game_id,
            "revoke_invitation",
            &invitation,
            ResponseShape::Game,
        )?;
        revoke_observer_invitation(
            &backend.store(game_id),
            backend.env(),
            backend.settings(),
            actor,
            invitation_id,
            Some(&idem),
        )
        .await
        .map(|executed| executed_response(&executed, ResponseShape::Game, &correlation_task))
        .map_err(|failure| Box::new(problem_of(&failure)))
    })
    .await;
    result.unwrap_or_else(|problem| problem_response(&problem, &correlation))
}

/// 観察者としての参加（招待コードが認可）。不明・失効・期限切れ・形式不正は、区別しない同じ 403（`game.invitation_invalid`）。
async fn observe<B: Backend>(
    State(backend): State<Arc<B>>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let correlation = correlation_id(&*backend, &headers);
    let result = async {
        let parsed = parse_json(&body)?;
        let code = parsed.get("invitationCode").and_then(Value::as_str);
        let name = parsed.get("displayName").and_then(Value::as_str);
        let (Some(code), Some(name)) = (code, name) else {
            let mut errors = Vec::new();
            if code.is_none() {
                errors.push(field("invitationCode", "招待コードを入力してください。"));
            }
            if name.is_none() {
                errors.push(field("displayName", "表示名を入力してください。"));
            }
            return Err(Box::new(validation_problem(errors)));
        };
        let attempt = Attempt::begin(&*backend, &headers, "join").await?;
        // 招待コードを引く（ゲームが分からないので、検索だけの用途の保存場所を使う）
        let lookup = backend.store(GameId::new(0));
        let (game_id, invitation_id) = find_invitation(
            &lookup,
            backend.env(),
            backend.settings(),
            &Secret::new(code.to_owned()),
        )
        .await
        .map_err(|failure| {
            if matches!(failure, AppFailure::Unauthorized) {
                Box::new(invitation_invalid_problem())
            } else {
                Box::new(problem_of(&failure))
            }
        })?;
        let outcome = join_observer(
            &backend.store(game_id),
            backend.env(),
            backend.settings(),
            game_id,
            invitation_id,
            name,
        )
        .await
        .map_err(|failure| {
            if matches!(
                failure,
                AppFailure::Domain(beergame_application::DomainError::Game(
                    beergame_domain::GameError::InvitationInvalid
                ))
            ) {
                Box::new(invitation_invalid_problem())
            } else {
                Box::new(problem_of(&failure))
            }
        })?;
        // 招待が有効だったので、窓の失敗には数えない
        attempt.forgive(&*backend).await;
        let view = json!({
            "versions": {"game": outcome.game_version, "session": Value::Null},
            "gameId": Uuid::from_u128(game_id.get()).to_string(),
            "kind": "OBSERVER",
        });
        let cookie = session_cookie(&*backend, &headers, outcome.session.expose());
        Ok(json_response(StatusCode::OK, &view, Some(&cookie), None))
    }
    .await;
    result
        .map(|response: Response| with_correlation(response, &correlation))
        .unwrap_or_else(|problem: Box<Problem>| problem_response(&problem, &correlation))
}

/// 終了後の結果の出力（進行役だけ。CSV または JSON。ダウンロードとして返す）。
async fn export<B: Backend>(
    State(backend): State<Arc<B>>,
    Path(game): Path<String>,
    axum::extract::RawQuery(query): axum::extract::RawQuery,
    headers: HeaderMap,
) -> Response {
    let correlation = correlation_id(&*backend, &headers);
    let result = async {
        let game_id = parse_game_id(&game)?;
        let actor = authenticate_for(&*backend, &headers, game_id).await?;
        if !actor.is_facilitator_of(game_id) {
            return Err(Box::new(problem_of(&AppFailure::Unauthorized)));
        }
        let format = query
            .as_deref()
            .and_then(|q| q.split('&').find_map(|pair| pair.strip_prefix("format=")))
            .filter(|f| matches!(*f, "csv" | "json"))
            .ok_or_else(|| {
                Box::new(validation_problem(vec![field(
                    "format",
                    "形式は csv か json にしてください。",
                )]))
            })?;
        let session = backend
            .session_snapshot(game_id)
            .await
            .map_err(|f| Box::new(problem_of(&f)))?
            .filter(|s| s.status == "ENDED")
            .ok_or_else(|| Box::new(game_not_ended_problem()))?;
        let snapshot = backend
            .game_snapshot(game_id)
            .await
            .map_err(|f| Box::new(problem_of(&f)))?
            .ok_or_else(|| Box::new(problem_of(&AppFailure::Unauthorized)))?;
        let id_text = Uuid::from_u128(game_id.get()).to_string();
        let input = ExportInput {
            game_id: &id_text,
            final_week: session.final_week,
            settings_kind: &snapshot.settings_kind,
            changes: &snapshot.changed_settings,
            commit_mode: &snapshot.commit_mode,
            results: &session.results,
        };
        let (content_type, extension, body) = if format == "csv" {
            ("text/csv; charset=utf-8", "csv", build_csv(&input))
        } else {
            ("application/json", "json", build_json(&input))
        };
        let mut response = (
            StatusCode::OK,
            [(header::CONTENT_TYPE, content_type)],
            body.clone(),
        )
            .into_response();
        for (name, value) in [
            (
                header::CONTENT_DISPOSITION,
                format!("attachment; filename=\"beer-game-{id_text}.{extension}\""),
            ),
            (
                HeaderName::from_static("x-export-checksum"),
                checksum(&body),
            ),
            (
                HeaderName::from_static("x-export-schema-version"),
                EXPORT_SCHEMA_VERSION.to_owned(),
            ),
        ] {
            if let Ok(value) = HeaderValue::from_str(&value) {
                response.headers_mut().insert(name, value);
            }
        }
        Ok(response)
    }
    .await;
    result
        .map(|response: Response| with_correlation(response, &correlation))
        .unwrap_or_else(|problem: Box<Problem>| problem_response(&problem, &correlation))
}

/// 保持状態（進行役だけ）。
async fn retention<B: Backend>(
    State(backend): State<Arc<B>>,
    Path(game): Path<String>,
    headers: HeaderMap,
) -> Response {
    let correlation = correlation_id(&*backend, &headers);
    let result = async {
        let game_id = parse_game_id(&game)?;
        let actor = authenticate_for(&*backend, &headers, game_id).await?;
        if !actor.is_facilitator_of(game_id) {
            return Err(Box::new(problem_of(&AppFailure::Unauthorized)));
        }
        let state = backend
            .retention_state(game_id)
            .await
            .map_err(|f| Box::new(problem_of(&f)))?
            .ok_or_else(|| Box::new(problem_of(&AppFailure::Unauthorized)))?;
        Ok(json_response(
            StatusCode::OK,
            &crate::views::retention_view(&state),
            None,
            None,
        ))
    }
    .await;
    result
        .map(|response: Response| with_correlation(response, &correlation))
        .unwrap_or_else(|problem: Box<Problem>| problem_response(&problem, &correlation))
}

#[cfg(test)]
mod tests {
    use super::expires_at_text;
    use beergame_domain::Instant;

    #[test]
    #[allow(non_snake_case)] // 理由: RT1 の命名（承認済み）の `__` を使うため。
    fn tech__期限は_RFC3339_UTC_のミリ秒つきで書く() {
        // 2026-11-22T01:02:03.004Z、うるう年の 2024-02-29、紀元（1970-01-01）
        for (millis, text) in [
            (1_795_309_323_004, "2026-11-22T01:02:03.004Z"),
            (1_709_164_800_000, "2024-02-29T00:00:00.000Z"),
            (0, "1970-01-01T00:00:00.000Z"),
        ] {
            assert_eq!(expires_at_text(Instant::from_epoch_millis(millis)), text);
        }
    }
}
