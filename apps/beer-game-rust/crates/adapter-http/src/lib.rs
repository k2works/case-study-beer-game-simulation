//! HTTP のアダプター（axum）。エラーの写像（problem+json）、DTO の検証、認証、Cookie など。業務ルールは持たない。

mod problem;

pub use problem::{FieldError, Problem, field_error, problem_of};
