//! アラームの評価（B14。NF-O4）。CloudWatch のアラームと同じ意味（期間、評価の回数、超過の回数、欠測の扱い、統計）を、
//! 純粋な関数で表す。時計は引数で受け取る（模擬の時計で、訓練を実際の待機なしに行う）。
//! 閾値の表（`catalog`）は設計書 operation.md の「監視項目と閾値」で、Terraform（`infra/modules/observability/alarms.tf`）と
//! 同じ値でなければならない（`app/tests/alarm_catalog.rs` が `.tf` を読んで突き合わせる）。
//! **AWS 上の評価（欠測の扱い、期間の切り方）との一致は未確認**。ここは、閾値の表と評価の意味の定義まで。

use crate::MetricSample;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Severity {
    Warning,
    Critical,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Statistic {
    Sum,
    Average,
    Maximum,
    P95,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Comparison {
    GreaterThan,
    LessThan,
}

/// 欠測（その期間に観測が無い）の扱い。停止の検知は、欠測を超過とみなす。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MissingData {
    Breaching,
    NotBreaching,
}

/// CloudWatch Synthetics の名前空間（合成監視の `SuccessPercent`）。
pub const SYNTHETICS_NAMESPACE: &str = "CloudWatchSynthetics";

/// 評価する系列。`namespace` が `None` なら、アプリのメトリクス。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MetricSpec {
    pub name: &'static str,
    pub statistic: Statistic,
    pub namespace: Option<&'static str>,
}

/// 1 つのアラームの規則。`datapoints_to_alarm` は、直近の `evaluation_periods` 期間のうち、超過が何期間で発報するか。
/// `training_only` は、研修中だけ通知する（研修のない時間は、操作が無くて当然）。
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct AlarmRule {
    pub name: &'static str,
    pub metric: MetricSpec,
    pub comparison: Comparison,
    pub threshold: f64,
    pub period_seconds: i64,
    pub evaluation_periods: i64,
    pub datapoints_to_alarm: i64,
    pub missing: MissingData,
    pub severity: Severity,
    pub training_only: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AlarmState {
    Ok,
    Alarm,
}

/// 時刻 `at_secs`（エポックからの秒）での、1 つの規則の状態。期間は、エポックの秒を期間の長さで割った境界に揃え、
/// `at_secs` の直前に終わった期間からさかのぼって `evaluation_periods` 個を見る。
/// `training` が false のとき、研修中だけの規則は常に `Ok`。
#[must_use]
pub fn evaluate(
    rule: &AlarmRule,
    samples: &[MetricSample],
    at_secs: i64,
    training: bool,
) -> AlarmState {
    let active = training || !rule.training_only;
    if active && breaching_periods(rule, samples, at_secs) >= rule.datapoints_to_alarm {
        AlarmState::Alarm
    } else {
        AlarmState::Ok
    }
}

/// 評価の対象の系列（名前が同じものだけ）を、直近の期間に区切って、超過の期間数を数える。
fn breaching_periods(rule: &AlarmRule, samples: &[MetricSample], at_secs: i64) -> i64 {
    let period = rule.period_seconds;
    let end = at_secs.div_euclid(period) * period;
    let named: Vec<&MetricSample> = samples
        .iter()
        .filter(|s| s.name == rule.metric.name)
        .collect();
    let mut breaching = 0;
    for index in 0..rule.evaluation_periods {
        let to = end - index * period;
        let from = to - period;
        let values: Vec<f64> = named
            .iter()
            .filter(|s| (from..to).contains(&s.at_millis.div_euclid(1000)))
            .map(|s| s.value)
            .collect();
        let breached = match statistic_of(rule.metric.statistic, &values) {
            None => rule.missing == MissingData::Breaching,
            Some(value) => match rule.comparison {
                Comparison::GreaterThan => value > rule.threshold,
                Comparison::LessThan => value < rule.threshold,
            },
        };
        if breached {
            breaching += 1;
        }
    }
    breaching
}

fn statistic_of(statistic: Statistic, values: &[f64]) -> Option<f64> {
    if values.is_empty() {
        return None;
    }
    // ゲームの試行数程度の件数（f64 に収まる範囲）
    #[allow(clippy::cast_precision_loss)]
    let len = values.len() as f64;
    Some(match statistic {
        Statistic::Sum => values.iter().sum(),
        Statistic::Average => values.iter().sum::<f64>() / len,
        Statistic::Maximum => values.iter().copied().fold(f64::NEG_INFINITY, f64::max),
        Statistic::P95 => {
            let mut sorted = values.to_vec();
            sorted.sort_by(f64::total_cmp);
            // 切り上げた順位（0.95 × 件数）。件数は小さく、添字は範囲内
            #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
            let rank = (0.95 * len).ceil() as usize;
            return sorted.get(rank.max(1) - 1).copied();
        }
    })
}

/// 評価の間隔（秒。高解像度のアラームの評価の間隔）。
pub const EVALUATION_STEP_SECONDS: i64 = 10;

/// 訓練。`fault_at` から `until` まで、10 秒ごとに評価し、`rule` が最初に発報した時刻と `fault_at` の差（秒）を返す。
/// 発報しなければ `None`。**実際の待機はしない**（時刻は引数）。
#[must_use]
pub fn detection_delay(
    rule: &AlarmRule,
    samples: &[MetricSample],
    fault_at: i64,
    until: i64,
    training: bool,
) -> Option<i64> {
    let mut at = fault_at;
    while at <= until {
        if evaluate(rule, samples, at, training) == AlarmState::Alarm {
            return Some(at - fault_at);
        }
        at += EVALUATION_STEP_SECONDS;
    }
    None
}

/// アラームの閾値の表。
pub mod catalog {
    use super::{
        AlarmRule, Comparison, MetricSpec, MissingData, SYNTHETICS_NAMESPACE, Severity, Statistic,
    };
    use crate::metric_names as n;

    const MINUTE: i64 = 60;
    const FIVE_MINUTES: i64 = 300;
    const TEN_MINUTES: i64 = 600;
    const HOUR: i64 = 3_600;
    const DAY: i64 = 86_400;

    fn app(name: &'static str, statistic: Statistic) -> MetricSpec {
        MetricSpec {
            name,
            statistic,
            namespace: None,
        }
    }

    /// 超過が 1 期間で発報する（期間の数 = 発報に要る数）の規則。
    #[allow(clippy::too_many_arguments)]
    fn rule(
        name: &'static str,
        metric: MetricSpec,
        comparison: Comparison,
        threshold: f64,
        period_seconds: i64,
        evaluation_periods: i64,
        missing: MissingData,
        severity: Severity,
    ) -> AlarmRule {
        AlarmRule {
            name,
            metric,
            comparison,
            threshold,
            period_seconds,
            evaluation_periods,
            datapoints_to_alarm: evaluation_periods,
            missing,
            severity,
            training_only: false,
        }
    }

    fn above(
        name: &'static str,
        metric: MetricSpec,
        threshold: f64,
        period_seconds: i64,
        evaluation_periods: i64,
        severity: Severity,
    ) -> AlarmRule {
        rule(
            name,
            metric,
            Comparison::GreaterThan,
            threshold,
            period_seconds,
            evaluation_periods,
            MissingData::NotBreaching,
            severity,
        )
    }

    /// 心拍: 結果のメトリクスが期間の中に 1 つも無い（欠測）なら発報する。値は 0 以上なので「0 未満」は成り立たず、
    /// 発報の理由は欠測だけ（欠測を超過とみなす）。
    fn heartbeat(name: &'static str, metric: MetricSpec, period_seconds: i64) -> AlarmRule {
        rule(
            name,
            metric,
            Comparison::LessThan,
            0.0,
            period_seconds,
            1,
            MissingData::Breaching,
            Severity::Warning,
        )
    }

    /// すべての規則（Terraform の `alarms.tf` と同じ値）。Kotlin 版の `jvm-*` は、Rust に JVM が無いので含まない。
    #[must_use]
    pub fn rules() -> Vec<AlarmRule> {
        use Severity::{Critical, Warning};
        let server_error = app(n::SERVER_ERROR, Statistic::Average);
        let duration = app(n::REQUEST_DURATION_MILLIS, Statistic::P95);
        let conflict = app(n::CONCURRENCY_CONFLICT, Statistic::Average);
        let exhausted = app(n::RETRY_EXHAUSTED, Statistic::Sum);
        let mismatch = app(n::PROJECTION_MISMATCH_GAMES, Statistic::Maximum);
        let abandoned = app(n::RETENTION_ABANDONED_GAMES, Statistic::Maximum);
        let pool = app(n::DB_POOL_UTILIZATION_PERCENT, Statistic::Maximum);
        vec![
            // 研修中に、主要な操作が 1 分間（10 秒 x 5 期間）成功しない。欠測も超過とみなす。研修中だけ通知する
            AlarmRule {
                training_only: true,
                ..rule(
                    "main-operation-stall",
                    app(n::MAIN_OPERATION_SUCCESS, Statistic::Sum),
                    Comparison::LessThan,
                    1.0,
                    10,
                    5,
                    MissingData::Breaching,
                    Critical,
                )
            },
            rule(
                "synthetic-failure",
                MetricSpec {
                    name: "SuccessPercent",
                    statistic: Statistic::Average,
                    namespace: Some(SYNTHETICS_NAMESPACE),
                },
                Comparison::LessThan,
                100.0,
                MINUTE,
                1,
                MissingData::Breaching,
                Critical,
            ),
            above(
                "http-5xx-rate-warning",
                server_error,
                0.01,
                FIVE_MINUTES,
                1,
                Warning,
            ),
            above(
                "http-5xx-rate-critical",
                server_error,
                0.05,
                MINUTE,
                1,
                Critical,
            ),
            above(
                "api-latency-p95-warning",
                duration,
                800.0,
                FIVE_MINUTES,
                1,
                Warning,
            ),
            above(
                "api-latency-p95-critical",
                duration,
                1000.0,
                FIVE_MINUTES,
                1,
                Critical,
            ),
            above(
                "append-conflict-rate-warning",
                conflict,
                0.05,
                FIVE_MINUTES,
                1,
                Warning,
            ),
            above(
                "append-conflict-rate-critical",
                conflict,
                0.20,
                FIVE_MINUTES,
                1,
                Critical,
            ),
            above(
                "retry-exhausted-warning",
                exhausted,
                0.0,
                FIVE_MINUTES,
                1,
                Warning,
            ),
            above(
                "retry-exhausted-critical",
                exhausted,
                4.0,
                FIVE_MINUTES,
                1,
                Critical,
            ),
            above("projection-mismatch", mismatch, 0.0, DAY, 1, Critical),
            above(
                "projection-lag",
                app(n::PROJECTION_LAG_GAMES, Statistic::Maximum),
                0.0,
                DAY,
                1,
                Critical,
            ),
            above(
                "retention-abandoned",
                abandoned,
                0.0,
                FIVE_MINUTES,
                1,
                Critical,
            ),
            heartbeat("projection-verify-heartbeat", mismatch, DAY),
            heartbeat("retention-heartbeat", abandoned, HOUR),
            above(
                "db-pool-utilization-warning",
                pool,
                70.0,
                MINUTE,
                TEN_MINUTES / MINUTE,
                Warning,
            ),
            above(
                "db-pool-utilization-critical",
                pool,
                80.0,
                MINUTE,
                TEN_MINUTES / MINUTE,
                Critical,
            ),
        ]
    }

    /// 名前で引く。
    #[must_use]
    pub fn named(name: &str) -> Option<AlarmRule> {
        rules().into_iter().find(|r| r.name == name)
    }
}

#[cfg(test)]
#[allow(non_snake_case)] // 理由: RT1 の命名（承認済み）の `__` を使うため。
mod tests {
    use super::*;
    use crate::MetricUnit;
    use crate::metric_names as n;

    fn count(name: &'static str, value: f64, secs: i64) -> MetricSample {
        MetricSample {
            name,
            unit: MetricUnit::Count,
            value,
            at_millis: secs * 1000,
            operation: None,
        }
    }

    fn rule(name: &str) -> AlarmRule {
        catalog::named(name).unwrap_or_else(|| panic!("規則が無い: {name}"))
    }

    /// 5 秒ごとに主要な操作が成功する系列（`gap` の間は途切れる）。
    fn successes(until: i64, gap: std::ops::Range<i64>) -> Vec<MetricSample> {
        (0..until)
            .step_by(5)
            .filter(|t| !gap.contains(t))
            .map(|t| count(n::MAIN_OPERATION_SUCCESS, 1.0, t))
            .collect()
    }

    #[test]
    fn ac6_1_5__研修中に停止すると_60_秒以内に_main_operation_stall_が発報する() {
        let samples = successes(120, 0..0);
        let delay = detection_delay(
            &rule("main-operation-stall"),
            &samples,
            120,
            120 + 1200,
            true,
        );
        assert!(delay.is_some_and(|d| d <= 60), "検知までの時間: {delay:?}");
    }

    #[test]
    fn ac6_1_5__成功の途切れが_40_秒までなら発報しない() {
        let samples = successes(1200, 120..160);
        let delay = detection_delay(&rule("main-operation-stall"), &samples, 120, 1200, true);
        assert_eq!(delay, None);
    }

    #[test]
    fn ac6_1_5__研修中でなければ_操作が無くても_main_operation_stall_は発報しない() {
        let samples = successes(120, 0..0);
        let delay = detection_delay(
            &rule("main-operation-stall"),
            &samples,
            120,
            120 + 600,
            false,
        );
        assert_eq!(delay, None);
    }

    #[test]
    fn ac6_1_5__合成監視の失敗は_最悪でも_120_秒以内に発報する() {
        let samples: Vec<MetricSample> = (0..1200)
            .step_by(60)
            .map(|t| MetricSample {
                name: "SuccessPercent",
                unit: MetricUnit::Percent,
                value: if t < 120 { 100.0 } else { 0.0 },
                at_millis: t * 1000,
                operation: None,
            })
            .collect();
        let delay = detection_delay(&rule("synthetic-failure"), &samples, 120, 120 + 1200, true);
        assert!(delay.is_some_and(|d| d <= 120), "検知までの時間: {delay:?}");
    }

    /// 100 試行ごとに、競合率 `rate` の割合だけ 1 を出す系列（5 秒ごと）。
    fn conflicts(before: f64, from: i64, after: f64) -> Vec<MetricSample> {
        (0..900)
            .step_by(5)
            .flat_map(|t| {
                let rate = if t >= from { after } else { before };
                (1..=100).map(move |i| {
                    let hit = f64::from(i) <= rate * 100.0;
                    count(n::CONCURRENCY_CONFLICT, if hit { 1.0 } else { 0.0 }, t)
                })
            })
            .collect()
    }

    #[test]
    fn ac6_1_3__追記の競合率が急増すると_警告に続いて重大が発報し_平常では発報しない() {
        let samples = conflicts(0.01, 300, 0.30);
        let warn = rule("append-conflict-rate-warning");
        let crit = rule("append-conflict-rate-critical");
        assert_eq!(evaluate(&warn, &samples, 600, true), AlarmState::Alarm);
        assert_eq!(evaluate(&crit, &samples, 600, true), AlarmState::Alarm);
        let calm = conflicts(0.01, i64::MAX, 0.0);
        assert_eq!(evaluate(&warn, &calm, 600, true), AlarmState::Ok);
    }

    #[test]
    fn ac6_1_6__不一致のメトリクスが_0_を超えると_projection_mismatch_が発報する() {
        let day = 86_400;
        let bad = [count(n::PROJECTION_MISMATCH_GAMES, 1.0, 10)];
        let good = [count(n::PROJECTION_MISMATCH_GAMES, 0.0, 10)];
        let r = rule("projection-mismatch");
        assert_eq!(evaluate(&r, &bad, day, true), AlarmState::Alarm);
        assert_eq!(evaluate(&r, &good, day, true), AlarmState::Ok);
    }

    #[test]
    fn ac6_1_6__検査が動かず結果のメトリクスが欠測なら_心拍のアラームが発報する() {
        let day = 86_400;
        let r = rule("projection-verify-heartbeat");
        assert_eq!(evaluate(&r, &[], day, true), AlarmState::Alarm);
        let ran = [count(n::PROJECTION_MISMATCH_GAMES, 0.0, 10)];
        assert_eq!(evaluate(&r, &ran, day, true), AlarmState::Ok);
    }

    #[test]
    fn nf_o4__閾値の表の名前は重複せず_Rust_に無い_JVM_の規則は含まない() {
        let rules = catalog::rules();
        let mut names: Vec<&str> = rules.iter().map(|r| r.name).collect();
        names.sort_unstable();
        let total = names.len();
        names.dedup();
        assert_eq!(names.len(), total, "名前が重複している");
        assert!(total > 0);
        assert!(rules.iter().all(|r| !r.name.starts_with("jvm-")));
    }
}
