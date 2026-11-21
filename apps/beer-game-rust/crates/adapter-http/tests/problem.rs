// 理由: RT1 の命名（承認済み）の `__` を使うため。
#![allow(non_snake_case)]

//! エラーの写像（problem+json）。`code` と状態は API の契約。AC1.1.2・AC1.2.2・AC1.2.3・AC2.3.2、NF-S（内部情報を出さない）。

use std::collections::BTreeMap;

use beergame_adapter_http::problem_of;
use beergame_application::{AppFailure, DomainError, PersistenceFailure};
use beergame_domain::{
    GameError, ParticipantId, Role, SessionError, StartError, ValidationError, Week,
};
use serde_json::json;

fn week(n: i64) -> Week {
    Week::of(n).unwrap_or(Week::FIRST)
}

#[test]
fn ac1_1_2__入力の誤りは_422_で_項目ごとに対象の週と修正内容を返す() {
    let failure = AppFailure::Invalid(vec![ValidationError::DemandSeriesInvalid {
        week_index: 5,
        reason: "需要は 0〜1000 の整数",
    }]);
    let problem = problem_of(&failure);
    assert_eq!(problem.status, 422);
    assert_eq!(problem.code, "validation.invalid_input");
    assert_eq!(
        problem.body()["errors"],
        json!([{"field": "demand", "week": 5, "message": "需要は 0〜1000 の整数"}])
    );
}

#[test]
fn nf_s__type_は_problems_code_で_code_と同じ値を持つ() {
    let body = problem_of(&AppFailure::Domain(DomainError::Game(
        GameError::NotPreparing,
    )))
    .body();
    assert_eq!(body["type"], json!("/problems/game.not_preparing"));
    assert_eq!(body["code"], json!("game.not_preparing"));
    assert_eq!(body["status"], json!(409));
}

#[test]
fn ac1_2_2__受付終了は_409_で_理由を示す() {
    let problem = problem_of(&AppFailure::Domain(DomainError::Game(
        GameError::NotPreparing,
    )));
    assert_eq!(
        (problem.status, problem.title.as_str()),
        (409, "このゲームは、参加の受付を終了しています。")
    );
    assert!(problem.detail.is_some());
}

#[test]
fn ac1_2_3__開始条件を満たさなければ_422_で_不足の役割を上流から下流の順に示す() {
    let failure = AppFailure::Domain(DomainError::Start(StartError::Game(
        GameError::StartConditionNotMet(vec![Role::Distributor, Role::Wholesaler]),
    )));
    let problem = problem_of(&failure);
    assert_eq!(problem.status, 422);
    assert_eq!(
        problem.body()["missingRoles"],
        json!(["DISTRIBUTOR", "WHOLESALER"])
    );
}

#[test]
fn ac2_3_2__入力が足りなければ_422_で_不足の役割を示す() {
    let failure = AppFailure::Domain(DomainError::Session(SessionError::IncompleteDecisions {
        missing: vec![Role::Factory],
    }));
    let problem = problem_of(&failure);
    assert_eq!(
        (problem.status, problem.code.as_str()),
        (422, "session.incomplete_decisions")
    );
    assert_eq!(problem.body()["missingRoles"], json!(["FACTORY"]));
}

#[test]
fn ac2_3_3__週が進んでいれば_409_で_要求した週と現在の週を示す() {
    let failure = AppFailure::Domain(DomainError::Session(SessionError::WeekAdvanced {
        requested: week(1),
        current: week(2),
    }));
    let body = problem_of(&failure).body();
    assert_eq!(
        (
            body["status"].clone(),
            body["requestedWeek"].clone(),
            body["currentWeek"].clone()
        ),
        (json!(409), json!(1), json!(2))
    );
}

#[test]
fn ac2_3_3__根拠の版が変わっていれば_409_で_現在の入力を示す() {
    let failure = AppFailure::Domain(DomainError::Session(SessionError::DecisionsChanged {
        week: week(1),
        current: BTreeMap::new(),
    }));
    let body = problem_of(&failure).body();
    assert_eq!(
        (
            body["status"].clone(),
            body["week"].clone(),
            body["current"].clone()
        ),
        (json!(409), json!(1), json!({}))
    );
}

#[test]
fn nf_s__権限の失敗と資格の失敗は区別しない同じ本文() {
    let forbidden = problem_of(&AppFailure::Domain(DomainError::Game(
        GameError::Forbidden("進行役だけ"),
    )));
    let session = problem_of(&AppFailure::Domain(DomainError::Session(
        SessionError::Forbidden("その役割だけ"),
    )));
    let unauthorized = problem_of(&AppFailure::Unauthorized);
    assert_eq!(forbidden.body(), unauthorized.body());
    assert_eq!(session.body(), unauthorized.body());
    assert_eq!(unauthorized.status, 403);
    // 理由（`進行役だけ` など）を本文に出さない
    assert!(!unauthorized.body().to_string().contains("進行役"));
}

#[test]
fn ac1_2_3__存在しない参加者は_404() {
    let problem = problem_of(&AppFailure::Domain(DomainError::Game(
        GameError::ParticipantNotFound(ParticipantId::new(1)),
    )));
    assert_eq!(
        (problem.status, problem.code.as_str()),
        (404, "game.participant_not_found")
    );
}

#[test]
fn nf_s__内部の失敗は_500_で_内部の情報を出さない() {
    let problem = problem_of(&AppFailure::Persistence(PersistenceFailure::Storage(
        "connection to server at 10.0.0.5 failed".to_owned(),
    )));
    assert_eq!(
        (problem.status, problem.code.as_str()),
        (500, "app.internal")
    );
    assert!(!problem.body().to_string().contains("10.0.0.5"));
}

#[test]
fn nf_r__再試行の上限は_503_で_Retry_After_を付ける() {
    let problem = problem_of(&AppFailure::RetryExhausted);
    assert_eq!(
        (
            problem.status,
            problem.code.as_str(),
            problem.retry_after_seconds
        ),
        (503, "app.retry_exhausted", Some(1))
    );
}

#[test]
fn ac2_2_2__冪等キーの再利用は_409() {
    let problem = problem_of(&AppFailure::IdempotencyKeyReused);
    assert_eq!(
        (problem.status, problem.code.as_str()),
        (409, "app.idempotency_key_reused")
    );
}
