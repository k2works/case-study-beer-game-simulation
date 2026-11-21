//! HTTP のアダプター（axum）。エラーの写像（problem+json）、DTO の検証、認証、Cookie など。業務ルールは持たない。

mod api;
mod problem;

pub use api::{Backend, router};
pub use problem::{
    FieldError, Problem, bad_request_problem, field_error, invitation_invalid_problem,
    not_ready_problem, problem_of, validation_problem,
};
