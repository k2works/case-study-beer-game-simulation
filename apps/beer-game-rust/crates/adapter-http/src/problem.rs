//! エラーの写像。`AppFailure` を、HTTP の状態・安定した `code`・problem+json の本文にする。
//! `code` と状態は API の契約（`contracts/openapi.yaml`。Kotlin 版と同じ値）。**利用者へは相関 ID だけを返し、内部の情報を出さない**（500）。

use beergame_application::{AppFailure, DomainError};
use beergame_domain::{ErrorCategory, GameError, Role, SessionError, StartError, ValidationError};
use serde_json::{Map, Value, json};

/// 項目ごとの入力の誤り。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FieldError {
    pub field: String,
    pub message: String,
    /// 需要系列の誤りの対象週（1 始まり）。
    pub week: Option<usize>,
}

/// problem+json（RFC 9457）。`type` は `/problems/{code}`、拡張メンバー `code` に同じ値を持つ。
#[derive(Clone, Debug, PartialEq)]
pub struct Problem {
    pub status: u16,
    pub code: String,
    pub title: String,
    pub detail: Option<String>,
    /// `Retry-After`（秒）。`app.retry_exhausted` と `app.rate_limited` のときだけ。
    pub retry_after_seconds: Option<u32>,
    pub errors: Vec<FieldError>,
    pub extras: Map<String, Value>,
}

impl Problem {
    fn new(status: u16, code: &str, title: &str) -> Self {
        Problem {
            status,
            code: code.to_owned(),
            title: title.to_owned(),
            detail: None,
            retry_after_seconds: None,
            errors: Vec::new(),
            extras: Map::new(),
        }
    }

    /// 応答の本文（`application/problem+json`）。
    #[must_use]
    pub fn body(&self) -> Value {
        let mut body = Map::new();
        // `code` が空の problem（504 のタイムアウト）は、`type` を持たない（LB の 504 と同じ形。画面は「結果が不明」として再送する）
        if !self.code.is_empty() {
            body.insert("type".to_owned(), json!(format!("/problems/{}", self.code)));
        }
        body.insert("title".to_owned(), json!(self.title));
        body.insert("status".to_owned(), json!(self.status));
        if !self.code.is_empty() {
            body.insert("code".to_owned(), json!(self.code));
        }
        if let Some(detail) = &self.detail {
            body.insert("detail".to_owned(), json!(detail));
        }
        if !self.errors.is_empty() {
            let errors: Vec<Value> = self
                .errors
                .iter()
                .map(|e| match e.week {
                    Some(week) => json!({"field": e.field, "week": week, "message": e.message}),
                    None => json!({"field": e.field, "message": e.message}),
                })
                .collect();
            body.insert("errors".to_owned(), Value::Array(errors));
        }
        for (key, value) in &self.extras {
            body.insert(key.clone(), value.clone());
        }
        Value::Object(body)
    }
}

/// 入力の誤りを、項目と修正内容にする（文言は修正内容の要点）。
#[must_use]
pub fn field_error(error: &ValidationError) -> FieldError {
    let plain = |field: &str, message: String| FieldError {
        field: field.to_owned(),
        message,
        week: None,
    };
    match error {
        ValidationError::QuantityOutOfRange { max, .. } => plain(
            "quantity",
            format!("数量は 0 以上 {max} 以下の整数にしてください。"),
        ),
        ValidationError::WeekOutOfRange { max, .. } => plain(
            "week",
            format!("週は 1 以上 {max} 以下の整数にしてください。"),
        ),
        ValidationError::UnitsNegative { .. } => {
            plain("units", "数量は 0 以上の整数にしてください。".to_owned())
        }
        ValidationError::MoneyNegative { .. } => {
            plain("money", "金額は 0 以上にしてください。".to_owned())
        }
        ValidationError::DisplayNameInvalid { .. } => plain(
            "displayName",
            "表示名は 1 文字以上 80 文字以下にしてください。".to_owned(),
        ),
        ValidationError::JoinCodeInvalid { .. } => plain(
            "joinCode",
            "参加コードの形式が正しくありません。".to_owned(),
        ),
        ValidationError::RetentionOutOfRange { .. } => plain(
            "retentionDays",
            "保持日数は 1 以上 3650 以下の整数にしてください。".to_owned(),
        ),
        ValidationError::DemandSeriesInvalid { week_index, reason } => FieldError {
            field: "demand".to_owned(),
            message: (*reason).to_owned(),
            week: Some(*week_index),
        },
    }
}

fn title_of(code: &str) -> &'static str {
    match code {
        "game.invitation_invalid" => "参加コードが無効です。",
        "game.not_preparing" => "このゲームは、参加の受付を終了しています。",
        "game.already_created" => "このゲームは、すでに作成されています。",
        "game.participant_not_found" => "参加者が見つかりません。",
        "game.start_condition_not_met" => {
            "4 つの役割に参加者がそろっていないため、開始できません。"
        }
        "session.not_active" => "進行中ではありません。",
        "session.already_ended" => "すでに終了しています。",
        "session.already_started" => "すでに開始しています。",
        "session.week_advanced" => "週はすでに進んでいます。",
        "session.decision_conflict" => "入力が、別の操作で更新されました。",
        "session.decisions_changed" => "確定の根拠にした入力が、変わりました。",
        "session.incomplete_decisions" => "入力がそろっていないため、確定できません。",
        "session.save_limit_reached" => "この週の保存回数の上限（9 回）に達しました。",
        _ => "リクエストを処理できません。",
    }
}

fn detail_of(code: &str) -> Option<&'static str> {
    match code {
        "game.not_preparing" => Some("ゲームは準備中ではありません（開始済みです）。"),
        "game.already_created" => Some("同じゲームを二重に作成することはできません。"),
        "session.not_active" => Some("セッションは進行中ではありません。"),
        "session.already_ended" => Some("セッションは終了しています。"),
        "session.already_started" => Some("セッションは開始済みです。"),
        _ => None,
    }
}

/// 資格の失敗。**不明・期限切れ・失効・権限なしを区別しない**同じ本文（列挙の防止）。
fn unauthorized() -> Problem {
    Problem::new(403, "app.unauthorized", "この操作を行う権限がありません。")
}

fn role_name(role: Role) -> &'static str {
    match role {
        Role::Factory => "FACTORY",
        Role::Distributor => "DISTRIBUTOR",
        Role::Wholesaler => "WHOLESALER",
        Role::Retailer => "RETAILER",
    }
}

fn domain_parts(error: &DomainError) -> (&'static str, ErrorCategory) {
    match error {
        DomainError::Game(e) => (e.code(), e.category()),
        DomainError::Session(e) => (e.code(), e.category()),
        DomainError::Start(e) => (e.code(), e.category()),
    }
}

fn extras_of(error: &DomainError) -> Map<String, Value> {
    let mut extras = Map::new();
    let session = match error {
        DomainError::Session(e) => Some(e),
        DomainError::Start(StartError::Session(e)) => Some(e),
        DomainError::Game(_) | DomainError::Start(StartError::Game(_)) => None,
    };
    let game = match error {
        DomainError::Game(e) => Some(e),
        DomainError::Start(StartError::Game(e)) => Some(e),
        DomainError::Session(_) | DomainError::Start(StartError::Session(_)) => None,
    };
    if let Some(GameError::StartConditionNotMet(missing)) = game {
        extras.insert(
            "missingRoles".to_owned(),
            json!(missing.iter().map(|r| role_name(*r)).collect::<Vec<_>>()),
        );
    }
    match session {
        Some(SessionError::WeekAdvanced { requested, current }) => {
            extras.insert("requestedWeek".to_owned(), json!(requested.get()));
            extras.insert("currentWeek".to_owned(), json!(current.get()));
        }
        Some(SessionError::IncompleteDecisions { missing }) => {
            extras.insert(
                "missingRoles".to_owned(),
                json!(missing.iter().map(|r| role_name(*r)).collect::<Vec<_>>()),
            );
        }
        Some(SessionError::DecisionConflict { role, latest }) => {
            extras.insert("role".to_owned(), json!(role_name(*role)));
            if let Some(entry) = latest {
                extras.insert(
                    "latest".to_owned(),
                    json!({"quantity": entry.quantity.get(), "version": entry.version.get()}),
                );
            }
        }
        Some(SessionError::DecisionsChanged { week, current }) => {
            extras.insert("week".to_owned(), json!(week.get()));
            let entries: Map<String, Value> = current
                .iter()
                .map(|(role, entry)| {
                    (
                        role_name(*role).to_owned(),
                        json!({"quantity": entry.quantity.get(), "version": entry.version.get()}),
                    )
                })
                .collect();
            extras.insert("current".to_owned(), Value::Object(entries));
        }
        Some(
            SessionError::NotActive
            | SessionError::AlreadyEnded
            | SessionError::AlreadyStarted
            | SessionError::SaveLimitReached
            | SessionError::Forbidden(_),
        )
        | None => {}
    }
    extras
}

/// 業務の失敗を、分類に従って写す（Forbidden は資格の失敗と同じ本文、NotFound 404、InvalidState・Conflict 409、RuleViolation 422）。
fn domain_problem(error: &DomainError) -> Problem {
    let (code, category) = domain_parts(error);
    let mut problem = match category {
        ErrorCategory::Forbidden => unauthorized(),
        ErrorCategory::NotFound => Problem::new(404, code, title_of(code)),
        ErrorCategory::InvalidState | ErrorCategory::Conflict => {
            Problem::new(409, code, title_of(code))
        }
        ErrorCategory::RuleViolation => Problem::new(422, code, title_of(code)),
    };
    problem.detail = detail_of(code).map(str::to_owned);
    problem.extras = extras_of(error);
    problem
}

/// アプリケーションの失敗を、problem+json にする。
#[must_use]
pub fn problem_of(failure: &AppFailure) -> Problem {
    match failure {
        AppFailure::Invalid(errors) => {
            let mut problem =
                Problem::new(422, "validation.invalid_input", "入力に誤りがあります。");
            problem.errors = errors.iter().map(field_error).collect();
            problem
        }
        AppFailure::Domain(error) => domain_problem(error),
        // 競合は execute が再試行する。ここに来るのは、上限に達していない想定外の経路
        AppFailure::ConcurrencyConflict | AppFailure::RetryExhausted => {
            let mut problem = Problem::new(
                503,
                "app.retry_exhausted",
                "混み合っています。もう一度お試しください。",
            );
            problem.retry_after_seconds = Some(1);
            problem
        }
        AppFailure::IdempotencyKeyReused => Problem::new(
            409,
            "app.idempotency_key_reused",
            "同じ冪等キーで、内容の違う要求が送られました。",
        ),
        AppFailure::Unauthorized => unauthorized(),
        // 利用者へは相関 ID だけを返す（内部の操作名・メッセージは、ログにだけ残す）
        AppFailure::Persistence(_) => {
            let mut problem = Problem::new(500, "app.internal", "予期しないエラーが発生しました。");
            problem.detail = Some("相関 ID を添えて、運営者へお知らせください。".to_owned());
            problem
        }
    }
}

/// 入力の誤り（422）。項目ごとの誤りを、すべて集めて返す。
#[must_use]
pub fn validation_problem(errors: Vec<FieldError>) -> Problem {
    let mut problem = Problem::new(422, "validation.invalid_input", "入力に誤りがあります。");
    problem.errors = errors;
    problem
}

/// JSON として不正な本文（400）。
#[must_use]
pub fn bad_request_problem(detail: &str) -> Problem {
    let mut problem = Problem::new(
        400,
        "validation.invalid_input",
        "リクエストを解釈できません。",
    );
    problem.detail = Some(detail.to_owned());
    problem
}

/// 参加コードが無効（不明・形式不正を区別しない。列挙の防止。AC1.2.2）。
#[must_use]
pub fn invitation_invalid_problem() -> Problem {
    Problem::new(
        403,
        "game.invitation_invalid",
        title_of("game.invitation_invalid"),
    )
}

/// 準備ができていない（503。`/ready`）。
#[must_use]
pub fn not_ready_problem() -> Problem {
    Problem::new(503, "app.not_ready", "まだ準備ができていません。")
}

/// タイムアウト（504。**`type` を付けない**）。コマンドは**実行中または実行済みの可能性がある**ため、画面は「結果が不明」として、
/// 同じ `Idempotency-Key` で再送する。
#[must_use]
pub fn timeout_problem() -> Problem {
    let mut problem = Problem::new(504, "", "処理に時間がかかっています。");
    problem.detail = Some(
        "結果が不明です。同じ操作をもう一度送ってください（二重には実行されません）。".to_owned(),
    );
    problem
}
