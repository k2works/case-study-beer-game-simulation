// 理由: RT1 の命名（承認済み）の `__` を使うため。
#![allow(non_snake_case)]

//! アラームの閾値の表（`application` の `alarm_catalog`）と、Terraform の `infra/modules/observability/alarms.tf` の一致を検査する（NF-O4）。
//! `.tf` の `alarms = { "名前" = merge(local.app, { ... }) }` の書式を読む。書式を変えるときは、このテストも直す。
//! **AWS 上のアラームの評価は確認していない**。ここは、閾値の表と定義が同じ値であることの検査。

use std::collections::BTreeMap;

use beergame_application::{
    AlarmRule, Comparison, MissingData, SYNTHETICS_NAMESPACE, Severity, Statistic, alarm_catalog,
};

type Fields = BTreeMap<String, String>;

const ALARMS_TF: &str = "../../infra/modules/observability/alarms.tf";

/// `.tf` の、アラームの定義。名前 → （使うローカルの名前、項目）。
fn parse(text: &str) -> Result<BTreeMap<String, (String, Fields)>, String> {
    let mut alarms = BTreeMap::new();
    let mut current: Option<(String, String, Fields)> = None;
    let mut inside = false;
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed == "alarms = {" {
            inside = true;
            continue;
        }
        if !inside {
            continue;
        }
        if let Some((name, base, fields)) = current.as_mut() {
            if trimmed == "})" {
                alarms.insert(name.clone(), (base.clone(), std::mem::take(fields)));
                current = None;
            } else if let Some((key, value)) = trimmed.split_once('=') {
                fields.insert(
                    key.trim().to_owned(),
                    value.trim().trim_matches('"').to_owned(),
                );
            }
        } else if let Some(rest) = trimmed.strip_prefix('"')
            && let Some((name, after)) = rest.split_once('"')
            && let Some(base) = after.trim().strip_prefix("= merge(local.")
        {
            let base = base.split(',').next().unwrap_or_default().to_owned();
            current = Some((name.to_owned(), base, Fields::new()));
        } else if trimmed == "}" {
            break;
        }
    }
    Ok(alarms)
}

fn statistic_name(statistic: Statistic) -> (&'static str, &'static str) {
    // （statistic, extended_statistic）
    match statistic {
        Statistic::Sum => ("Sum", ""),
        Statistic::Average => ("Average", ""),
        Statistic::Maximum => ("Maximum", ""),
        Statistic::P95 => ("Maximum", "p95"),
    }
}

/// 規則と `.tf` の定義の食い違い。空なら一致。
fn mismatches(rule: &AlarmRule, base: &str, fields: &Fields) -> Vec<String> {
    let get = |key: &str, default: &str| {
        fields
            .get(key)
            .map_or_else(|| default.to_owned(), Clone::clone)
    };
    let mut found = Vec::new();
    let mut check = |what: &str, expected: String, actual: String| {
        if expected != actual {
            found.push(format!(
                "{}: {what} が違う（コード {expected} / tf {actual}）",
                rule.name
            ));
        }
    };
    check(
        "メトリクス名",
        rule.metric.name.to_owned(),
        get("metric_name", ""),
    );
    let (statistic, extended) = statistic_name(rule.metric.statistic);
    check("統計", extended.to_owned(), get("extended_statistic", ""));
    if extended.is_empty() {
        check("統計", statistic.to_owned(), get("statistic", "Maximum"));
    }
    check(
        "比較",
        match rule.comparison {
            Comparison::GreaterThan => "GreaterThanThreshold",
            Comparison::LessThan => "LessThanThreshold",
        }
        .to_owned(),
        get("comparison", ""),
    );
    check(
        "閾値",
        rule.threshold.to_string(),
        get("threshold", "")
            .parse::<f64>()
            .map_or_else(|_| "?".to_owned(), |v| v.to_string()),
    );
    check("期間", rule.period_seconds.to_string(), get("period", ""));
    check(
        "評価の回数",
        rule.evaluation_periods.to_string(),
        get("evaluation_periods", ""),
    );
    check(
        "超過の回数",
        rule.datapoints_to_alarm.to_string(),
        get("evaluation_periods", ""),
    );
    check(
        "欠測の扱い",
        match rule.missing {
            MissingData::Breaching => "breaching",
            MissingData::NotBreaching => "notBreaching",
        }
        .to_owned(),
        get("missing", "notBreaching"),
    );
    check(
        "重大度",
        match rule.severity {
            Severity::Critical => "critical",
            Severity::Warning => "warning",
        }
        .to_owned(),
        get("severity", ""),
    );
    check(
        "研修中のみ",
        rule.training_only.to_string(),
        get("training_only", "false"),
    );
    check(
        "名前空間",
        rule.metric.namespace.unwrap_or("app").to_owned(),
        if base == "synthetics" {
            SYNTHETICS_NAMESPACE.to_owned()
        } else {
            "app".to_owned()
        },
    );
    found
}

fn tf() -> Result<BTreeMap<String, (String, Fields)>, String> {
    let text = std::fs::read_to_string(ALARMS_TF).map_err(|e| format!("{ALARMS_TF}: {e}"))?;
    parse(&text)
}

#[test]
fn nf_o4__閾値の表のすべての規則が_Terraform_のアラームと同じ値である() -> Result<(), String> {
    let defined = tf()?;
    let mut problems = Vec::new();
    for rule in alarm_catalog::rules() {
        match defined.get(rule.name) {
            None => problems.push(format!("{}: tf に定義が無い", rule.name)),
            Some((base, fields)) => problems.extend(mismatches(&rule, base, fields)),
        }
    }
    assert!(problems.is_empty(), "食い違い:\n{}", problems.join("\n"));
    Ok(())
}

#[test]
fn nf_o4__Terraform_のアプリのアラームは_すべて閾値の表にある() -> Result<(), String> {
    let defined = tf()?;
    let known: Vec<&str> = alarm_catalog::rules().iter().map(|r| r.name).collect();
    let extra: Vec<&String> = defined
        .keys()
        .filter(|name| !known.contains(&name.as_str()))
        .collect();
    assert!(extra.is_empty(), "表に無い tf のアラーム: {extra:?}");
    assert!(!defined.is_empty(), "tf の書式を読めていない");
    Ok(())
}

#[test]
fn nf_o4__食い違いは検出される_閾値を変えた規則は失敗として報告する() -> Result<(), String> {
    let defined = tf()?;
    let mut rule = alarm_catalog::named("http-5xx-rate-critical").ok_or("規則が無い")?;
    rule.threshold = 0.5;
    let (base, fields) = defined.get(rule.name).ok_or("tf に無い")?;
    let found = mismatches(&rule, base, fields);
    assert!(
        found.iter().any(|m| m.contains("閾値 が違う")),
        "検出されない: {found:?}"
    );
    Ok(())
}

const DASHBOARD_TF: &str = "../../infra/modules/observability/main.tf";

/// アプリが出すメトリクスの名前（`application` の `metric_names`）。
const EMITTED: [&str; 16] = [
    beergame_application::metric_names::REQUEST_COUNT,
    beergame_application::metric_names::REQUEST_DURATION_MILLIS,
    beergame_application::metric_names::SERVER_ERROR,
    beergame_application::metric_names::MAIN_OPERATION_SUCCESS,
    beergame_application::metric_names::CONCURRENCY_CONFLICT,
    beergame_application::metric_names::RETRY_EXHAUSTED,
    beergame_application::metric_names::PROJECTION_MISMATCH_GAMES,
    beergame_application::metric_names::PROJECTION_LAG_GAMES,
    beergame_application::metric_names::PROJECTION_UNCHECKED_GAMES,
    beergame_application::metric_names::PROJECTION_REBUILD_MILLIS,
    beergame_application::metric_names::RETENTION_ABANDONED_GAMES,
    beergame_application::metric_names::RETENTION_DELETED_GAMES,
    beergame_application::metric_names::DB_POOL_UTILIZATION_PERCENT,
    beergame_application::metric_names::RSS_BYTES,
    beergame_application::metric_names::TOKIO_ALIVE_TASKS,
    beergame_application::metric_names::PANIC_COUNT,
];

/// ダッシュボードが参照するアプリのメトリクスの名前（`[var.namespace, "名前", ...]`）。
fn dashboard_metrics() -> Result<Vec<String>, String> {
    let text = std::fs::read_to_string(DASHBOARD_TF).map_err(|e| format!("{DASHBOARD_TF}: {e}"))?;
    Ok(text
        .lines()
        .filter_map(|line| {
            let rest = line.split_once("[var.namespace, \"")?.1;
            Some(rest.split('"').next()?.to_owned())
        })
        .collect())
}

#[test]
fn nf_o5__ダッシュボードが参照するメトリクスは_すべてアプリが出す名前である() -> Result<(), String> {
    let used = dashboard_metrics()?;
    assert!(!used.is_empty(), "tf の書式を読めていない");
    let unknown: Vec<&String> = used.iter().filter(|m| !EMITTED.contains(&m.as_str())).collect();
    assert!(unknown.is_empty(), "アプリが出さない名前を参照している: {unknown:?}");
    Ok(())
}

#[test]
fn nf_o5__ダッシュボードに_実行環境の項目_RSS_タスク数_panic_接続プールが含まれる() -> Result<(), String> {
    let used = dashboard_metrics()?;
    let missing: Vec<&str> = ["RssBytes", "TokioAliveTasks", "PanicCount", "DbPoolUtilizationPercent"]
        .into_iter()
        .filter(|name| !used.iter().any(|u| u == name))
        .collect();
    assert!(missing.is_empty(), "ダッシュボードに無い項目: {missing:?}");
    Ok(())
}
