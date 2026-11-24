//! メトリクス（B14。NF-O3・NF-O12）。アプリケーションは、メトリクスの値を `MetricSink` へ渡すだけで、出力の形（EMF）は知らない。
//! **ゲーム ID・表示名・資格・参加コードは、型に持たない**（NF-S14。ログの方針と同じ）。
//! ディメンションは、操作の名前（OpenAPI の operationId。固定の集合）だけ。環境の名前は、出力側が足す。

use crate::{Inconsistency, RetentionReport, VerifyReport};

/// メトリクスの単位（CloudWatch の単位）。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MetricUnit {
    Count,
    Milliseconds,
    Percent,
    Bytes,
}

impl MetricUnit {
    /// CloudWatch の単位の名前。
    #[must_use]
    pub const fn cloud_watch(self) -> &'static str {
        match self {
            MetricUnit::Count => "Count",
            MetricUnit::Milliseconds => "Milliseconds",
            MetricUnit::Percent => "Percent",
            MetricUnit::Bytes => "Bytes",
        }
    }
}

/// 1 回の観測。`operation` があるときは、操作ごとの系列にもなる。
#[derive(Clone, Debug, PartialEq)]
pub struct MetricSample {
    pub name: &'static str,
    pub unit: MetricUnit,
    pub value: f64,
    /// 観測の時刻（エポックからのミリ秒）。
    pub at_millis: i64,
    pub operation: Option<String>,
}

/// メトリクスの出力先。呼び出しを遅くしない・失敗させないこと（出力の失敗は、処理に影響させない）。
pub trait MetricSink: Send + Sync {
    fn record(&self, samples: &[MetricSample]);
}

/// 何も出さない（試験と、計測が要らない呼び出し）。
pub struct NoMetrics;

impl MetricSink for NoMetrics {
    fn record(&self, _samples: &[MetricSample]) {}
}

/// メトリクスの名前。アラームの表（`alarms`）、Terraform、ダッシュボードが、同じ名前を使う。
pub mod names {
    pub const REQUEST_COUNT: &str = "RequestCount";
    pub const REQUEST_DURATION_MILLIS: &str = "RequestDurationMillis";
    /// 5xx なら 1、そうでなければ 0（平均が、5xx の割合になる）。
    pub const SERVER_ERROR: &str = "ServerError";
    /// 主要な操作が成功したとき 1（研修中の停止の検知）。
    pub const MAIN_OPERATION_SUCCESS: &str = "MainOperationSuccess";
    /// コマンドの試行ごとに、追記の競合なら 1、そうでなければ 0（平均が、自動再試行の前の競合率になる）。
    pub const CONCURRENCY_CONFLICT: &str = "ConcurrencyConflict";
    /// 自動再試行を使い切って、利用者へ失敗を返したとき 1。
    pub const RETRY_EXHAUSTED: &str = "RetryExhausted";
    pub const PROJECTION_MISMATCH_GAMES: &str = "ProjectionMismatchGames";
    pub const PROJECTION_LAG_GAMES: &str = "ProjectionLagGames";
    pub const PROJECTION_UNCHECKED_GAMES: &str = "ProjectionUncheckedGames";
    pub const PROJECTION_REBUILD_MILLIS: &str = "ProjectionRebuildMillis";
    pub const RETENTION_ABANDONED_GAMES: &str = "RetentionAbandonedGames";
    pub const RETENTION_DELETED_GAMES: &str = "RetentionDeletedGames";
    pub const DB_POOL_UTILIZATION_PERCENT: &str = "DbPoolUtilizationPercent";
    /// 常駐メモリ（RSS）。Linux だけ。
    pub const RSS_BYTES: &str = "RssBytes";
    pub const TOKIO_ALIVE_TASKS: &str = "TokioAliveTasks";
    pub const PANIC_COUNT: &str = "PanicCount";
}

/// 主要な操作（研修中に 1 分間成功しないと通知する対象。AC6.1.5）。OpenAPI の operationId。
pub const MAIN_OPERATIONS: [&str; 4] = ["createGame", "joinGame", "saveDecision", "commitWeek"];

#[must_use]
pub fn is_main_operation(operation: &str) -> bool {
    MAIN_OPERATIONS.contains(&operation)
}

/// 1 回の HTTP 要求の結果。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RequestOutcome {
    pub operation: String,
    pub status: u16,
    pub duration_millis: u64,
}

/// HTTP 要求のメトリクス（応答時間、要求数、5xx の 0/1、主要な操作の成功）。
#[must_use]
pub fn request_metrics(outcome: &RequestOutcome, at_millis: i64) -> Vec<MetricSample> {
    let sample = |name: &'static str, unit: MetricUnit, value: f64| MetricSample {
        name,
        unit,
        value,
        at_millis,
        operation: Some(outcome.operation.clone()),
    };
    // 応答時間はミリ秒の整数（f64 に収まる範囲）
    #[allow(clippy::cast_precision_loss)]
    let duration = outcome.duration_millis as f64;
    let mut samples = vec![
        sample(names::REQUEST_COUNT, MetricUnit::Count, 1.0),
        sample(
            names::REQUEST_DURATION_MILLIS,
            MetricUnit::Milliseconds,
            duration,
        ),
        sample(
            names::SERVER_ERROR,
            MetricUnit::Count,
            if outcome.status >= 500 { 1.0 } else { 0.0 },
        ),
    ];
    if outcome.status < 400 && is_main_operation(&outcome.operation) {
        samples.push(sample(
            names::MAIN_OPERATION_SUCCESS,
            MetricUnit::Count,
            1.0,
        ));
    }
    samples
}

/// 追記の試行の結果（競合の件数と、再試行の上限超過）。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AttemptOutcome {
    Proceeded,
    Conflict,
    Exhausted,
}

/// コマンドの試行ごとのメトリクス。競合は試行ごとに 0/1、上限超過は起きたときだけ 1。
#[must_use]
pub fn attempt_metrics(outcome: AttemptOutcome, at_millis: i64) -> Vec<MetricSample> {
    let count = |name: &'static str, value: f64| MetricSample {
        name,
        unit: MetricUnit::Count,
        value,
        at_millis,
        operation: None,
    };
    let conflict = if outcome == AttemptOutcome::Proceeded {
        0.0
    } else {
        1.0
    };
    let mut samples = vec![count(names::CONCURRENCY_CONFLICT, conflict)];
    if outcome == AttemptOutcome::Exhausted {
        samples.push(count(names::RETRY_EXHAUSTED, 1.0));
    }
    samples
}

fn count_sample(name: &'static str, value: usize, at_millis: i64) -> MetricSample {
    // ゲーム数（f64 に収まる範囲）
    #[allow(clippy::cast_precision_loss)]
    let value = value as f64;
    MetricSample {
        name,
        unit: MetricUnit::Count,
        value,
        at_millis,
        operation: None,
    }
}

/// 投影の整合の検査のメトリクス（不一致のゲーム数、進んだ版が遅れているゲーム数、検査できなかったゲーム数）。
#[must_use]
pub fn verify_metrics(report: &VerifyReport, at_millis: i64) -> Vec<MetricSample> {
    let is_lag = |f: &Inconsistency| matches!(f, Inconsistency::CheckpointDrift { .. });
    let lagging = report
        .inconsistent
        .iter()
        .filter(|(_, findings)| findings.iter().any(is_lag))
        .count();
    let mismatching = report
        .inconsistent
        .iter()
        .filter(|(_, findings)| findings.iter().any(|f| !is_lag(f)))
        .count();
    vec![
        count_sample(names::PROJECTION_MISMATCH_GAMES, mismatching, at_millis),
        count_sample(names::PROJECTION_LAG_GAMES, lagging, at_millis),
        count_sample(
            names::PROJECTION_UNCHECKED_GAMES,
            report.skipped.len() + report.failed.len(),
            at_millis,
        ),
    ]
}

/// 保持削除の掃引のメトリクス（再試行をやめたゲーム数、削除したゲーム数）。
#[must_use]
pub fn sweep_metrics(report: &RetentionReport, at_millis: i64) -> Vec<MetricSample> {
    vec![
        count_sample(
            names::RETENTION_ABANDONED_GAMES,
            report.abandoned.len(),
            at_millis,
        ),
        count_sample(names::RETENTION_DELETED_GAMES, report.completed, at_millis),
    ]
}

#[cfg(test)]
#[allow(non_snake_case)] // 理由: RT1 の命名（承認済み）の `__` を使うため。
mod tests {
    use super::*;
    use crate::AppFailure;
    use beergame_domain::GameId;

    fn find<'a>(samples: &'a [MetricSample], name: &str) -> Option<&'a MetricSample> {
        samples.iter().find(|s| s.name == name)
    }

    fn outcome(operation: &str, status: u16, millis: u64) -> RequestOutcome {
        RequestOutcome {
            operation: operation.to_owned(),
            status,
            duration_millis: millis,
        }
    }

    #[test]
    fn nf_o3__要求は応答時間_要求数_5xx_の_0_か_1_を操作ごとの系列で出す() {
        let samples = request_metrics(&outcome("getGameState", 200, 42), 1_000);
        let duration = find(&samples, names::REQUEST_DURATION_MILLIS);
        assert_eq!(duration.map(|s| s.value), Some(42.0));
        assert_eq!(
            duration.map(|s| s.operation.as_deref()),
            Some(Some("getGameState"))
        );
        assert_eq!(
            find(&samples, names::REQUEST_COUNT).map(|s| s.value),
            Some(1.0)
        );
        assert_eq!(
            find(&samples, names::SERVER_ERROR).map(|s| s.value),
            Some(0.0)
        );
        assert!(samples.iter().all(|s| s.at_millis == 1_000));
    }

    #[test]
    fn nf_o3__5xx_は_ServerError_が_1_で_4xx_は_0() {
        let server = request_metrics(&outcome("getReady", 503, 5), 0);
        assert_eq!(
            find(&server, names::SERVER_ERROR).map(|s| s.value),
            Some(1.0)
        );
        let client = request_metrics(&outcome("getReady", 404, 5), 0);
        assert_eq!(
            find(&client, names::SERVER_ERROR).map(|s| s.value),
            Some(0.0)
        );
    }

    #[test]
    fn nf_o3__主要な操作が成功したときだけ_MainOperationSuccess_を出す() {
        let ok = request_metrics(&outcome("commitWeek", 200, 5), 0);
        assert_eq!(
            find(&ok, names::MAIN_OPERATION_SUCCESS).map(|s| s.value),
            Some(1.0)
        );
        let failed = request_metrics(&outcome("commitWeek", 500, 5), 0);
        assert!(find(&failed, names::MAIN_OPERATION_SUCCESS).is_none());
        let client_error = request_metrics(&outcome("commitWeek", 409, 5), 0);
        assert!(find(&client_error, names::MAIN_OPERATION_SUCCESS).is_none());
        let other = request_metrics(&outcome("getGameState", 200, 5), 0);
        assert!(find(&other, names::MAIN_OPERATION_SUCCESS).is_none());
    }

    #[test]
    fn nf_o3__競合率は試行ごとの_0_か_1_で_上限超過は起きたときだけ_1() {
        let proceeded = attempt_metrics(AttemptOutcome::Proceeded, 0);
        assert_eq!(
            find(&proceeded, names::CONCURRENCY_CONFLICT).map(|s| s.value),
            Some(0.0)
        );
        assert!(find(&proceeded, names::RETRY_EXHAUSTED).is_none());
        let conflict = attempt_metrics(AttemptOutcome::Conflict, 0);
        assert_eq!(
            find(&conflict, names::CONCURRENCY_CONFLICT).map(|s| s.value),
            Some(1.0)
        );
        assert!(find(&conflict, names::RETRY_EXHAUSTED).is_none());
        let exhausted = attempt_metrics(AttemptOutcome::Exhausted, 0);
        assert_eq!(
            find(&exhausted, names::RETRY_EXHAUSTED).map(|s| s.value),
            Some(1.0)
        );
    }

    fn drift(table: &str) -> Inconsistency {
        Inconsistency::RowDrift {
            table: table.to_owned(),
            missing: 1,
            unexpected: 0,
        }
    }

    fn lag() -> Inconsistency {
        Inconsistency::CheckpointDrift {
            stream: "SESSION".to_owned(),
            projected: Some(1),
            head: 2,
        }
    }

    #[test]
    fn ac6_1_6__検査の結果は_不一致_遅れ_検査できなかったゲームの数になる() {
        let report = VerifyReport {
            checked: 4,
            inconsistent: vec![
                (GameId::new(1), vec![drift("game_overview")]),
                (GameId::new(2), vec![lag()]),
                (GameId::new(3), vec![lag(), drift("week_commits")]),
            ],
            skipped: vec![GameId::new(4)],
            failed: vec![(GameId::new(5), AppFailure::RetryExhausted)],
        };
        let samples = verify_metrics(&report, 7);
        // 行の食い違いのあるゲームが不一致（1・3）。進んだ版の食い違いのあるゲームが遅れ（2・3）
        assert_eq!(
            find(&samples, names::PROJECTION_MISMATCH_GAMES).map(|s| s.value),
            Some(2.0)
        );
        assert_eq!(
            find(&samples, names::PROJECTION_LAG_GAMES).map(|s| s.value),
            Some(2.0)
        );
        assert_eq!(
            find(&samples, names::PROJECTION_UNCHECKED_GAMES).map(|s| s.value),
            Some(2.0)
        );
    }

    #[test]
    fn ac6_1_6__整合した投影では_不一致と遅れは_0_件のメトリクスになる() {
        let samples = verify_metrics(&VerifyReport::default(), 0);
        assert_eq!(
            find(&samples, names::PROJECTION_MISMATCH_GAMES).map(|s| s.value),
            Some(0.0)
        );
        assert_eq!(
            find(&samples, names::PROJECTION_LAG_GAMES).map(|s| s.value),
            Some(0.0)
        );
    }

    #[test]
    fn ac5_1_3__削除の掃引は_再試行をやめたゲーム数と削除したゲーム数を出す() {
        let report = RetentionReport {
            completed: 3,
            abandoned: vec![GameId::new(1)],
        };
        let samples = sweep_metrics(&report, 0);
        assert_eq!(
            find(&samples, names::RETENTION_ABANDONED_GAMES).map(|s| s.value),
            Some(1.0)
        );
        assert_eq!(
            find(&samples, names::RETENTION_DELETED_GAMES).map(|s| s.value),
            Some(3.0)
        );
    }

    #[test]
    fn nf_s14__メトリクスの観測は操作の名前以外の識別子を持たない() {
        // 型に、ゲーム ID・表示名・資格の置き場所が無い（構造体のフィールドで保証）。
        let sample = MetricSample {
            name: names::REQUEST_COUNT,
            unit: MetricUnit::Count,
            value: 1.0,
            at_millis: 0,
            operation: Some("getGameState".to_owned()),
        };
        assert_eq!(sample.unit.cloud_watch(), "Count");
        assert!(is_main_operation("createGame") && !is_main_operation("getGameState"));
    }
}
