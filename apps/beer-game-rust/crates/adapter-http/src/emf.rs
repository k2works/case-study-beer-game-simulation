//! メトリクスの出力（BD9）。CloudWatch の Embedded Metric Format の JSON 行を、自前の小さな関数で標準出力へ出す
//! （追加のサーバーも依存も持たない）。コンテナのログドライバが CloudWatch Logs へ送り、CloudWatch がメトリクスに取り出す。
//! ディメンションは、`Environment` と、操作のあるものは `Environment` + `Operation` の 2 組。ゲーム ID・表示名・資格は、
//! `MetricSample` に持ち場所が無いので、出力にも入らない（NF-S14）。

use std::io::Write;
use std::sync::Mutex;

use beergame_application::{MetricSample, MetricSink, metric_names};
use serde_json::{Map, Value, json};

/// アプリのメトリクスの名前空間。Terraform の `variable "namespace"` の既定値と同じ。
pub const METRIC_NAMESPACE: &str = "BeerGame/Rust";

const ENVIRONMENT: &str = "Environment";
const OPERATION: &str = "Operation";

/// 1 秒の解像度で保存するメトリクス。10 秒の期間のアラーム（研修中の停止の検知。AC6.1.5）だけが使う（費用が高いので限る）。
const HIGH_RESOLUTION: [&str; 1] = [metric_names::MAIN_OPERATION_SUCCESS];

/// 行にまとめる単位（操作と時刻）。
type GroupKey<'a> = (Option<&'a str>, i64);

/// 観測を EMF の行にする。操作と時刻（ミリ秒）が同じものを 1 行にまとめる（EMF は 1 行に同じ名前を 2 回持てないので、
/// 同じ名前の観測は別の行にする）。純粋な関数。
#[must_use]
pub fn emf_lines(environment: &str, samples: &[MetricSample]) -> Vec<String> {
    // （操作, 時刻）が同じものを、初めて現れた順にまとめる
    let mut groups: Vec<(GroupKey, Vec<&MetricSample>)> = Vec::new();
    for sample in samples {
        let key = (sample.operation.as_deref(), sample.at_millis);
        match groups.iter_mut().find(|(k, _)| *k == key) {
            Some((_, group)) => group.push(sample),
            None => groups.push((key, vec![sample])),
        }
    }
    groups
        .iter()
        .flat_map(|(_, group)| chunks(group))
        .map(|line| render(environment, &line))
        .collect()
}

/// 同じ名前が重ならないように、行に分ける。
fn chunks<'a>(group: &[&'a MetricSample]) -> Vec<Vec<&'a MetricSample>> {
    let mut lines: Vec<Vec<&MetricSample>> = Vec::new();
    for sample in group {
        match lines
            .iter_mut()
            .find(|line| line.iter().all(|s| s.name != sample.name))
        {
            Some(line) => line.push(sample),
            None => lines.push(vec![sample]),
        }
    }
    lines
}

fn dimensions(operation: Option<&str>) -> Value {
    if operation.is_some() {
        json!([[ENVIRONMENT], [ENVIRONMENT, OPERATION]])
    } else {
        json!([[ENVIRONMENT]])
    }
}

fn render(environment: &str, line: &[&MetricSample]) -> String {
    let Some(first) = line.first() else {
        return String::new();
    };
    let definitions: Vec<Value> = line
        .iter()
        .map(|sample| {
            let mut definition = Map::new();
            definition.insert("Name".to_owned(), json!(sample.name));
            definition.insert("Unit".to_owned(), json!(sample.unit.cloud_watch()));
            if HIGH_RESOLUTION.contains(&sample.name) {
                definition.insert("StorageResolution".to_owned(), json!(1));
            }
            Value::Object(definition)
        })
        .collect();
    let mut body = Map::new();
    body.insert(
        "_aws".to_owned(),
        json!({
            "Timestamp": first.at_millis,
            "CloudWatchMetrics": [{
                "Namespace": METRIC_NAMESPACE,
                "Dimensions": dimensions(first.operation.as_deref()),
                "Metrics": definitions,
            }],
        }),
    );
    body.insert(ENVIRONMENT.to_owned(), json!(environment));
    if let Some(operation) = &first.operation {
        body.insert(OPERATION.to_owned(), json!(operation));
    }
    for sample in line {
        body.insert(sample.name.to_owned(), json!(sample.value));
    }
    Value::Object(body).to_string()
}

/// EMF の行を標準出力へ 1 行ずつ出す。出力の失敗は、処理に影響させない。
pub struct EmfMetricSink<W: Write + Send> {
    environment: String,
    out: Mutex<W>,
}

impl<W: Write + Send> EmfMetricSink<W> {
    #[must_use]
    pub fn new(environment: &str, out: W) -> Self {
        EmfMetricSink {
            environment: environment.to_owned(),
            out: Mutex::new(out),
        }
    }
}

impl<W: Write + Send> MetricSink for EmfMetricSink<W> {
    fn record(&self, samples: &[MetricSample]) {
        let lines = emf_lines(&self.environment, samples);
        if let Ok(mut out) = self.out.lock() {
            for line in lines {
                drop(writeln!(out, "{line}"));
            }
            drop(out.flush());
        }
    }
}

#[cfg(test)]
#[allow(non_snake_case)] // 理由: RT1 の命名（承認済み）の `__` を使うため。
mod tests {
    use super::*;
    use beergame_application::MetricUnit;

    fn sample(name: &'static str, value: f64, at: i64, operation: Option<&str>) -> MetricSample {
        MetricSample {
            name,
            unit: MetricUnit::Count,
            value,
            at_millis: at,
            operation: operation.map(str::to_owned),
        }
    }

    fn parse(lines: &[String]) -> Vec<Value> {
        lines
            .iter()
            .map(|l| serde_json::from_str(l).unwrap_or(Value::Null))
            .collect()
    }

    #[test]
    fn ac6_1_3__操作のある観測は_Environment_と_Operation_の_2_組のディメンションを持つ() {
        let lines = emf_lines(
            "staging",
            &[
                sample(metric_names::REQUEST_COUNT, 1.0, 1000, Some("getGameState")),
                sample(metric_names::SERVER_ERROR, 0.0, 1000, Some("getGameState")),
            ],
        );
        assert_eq!(lines.len(), 1, "同じ操作と時刻は 1 行: {lines:?}");
        let json = parse(&lines);
        let line = &json[0];
        assert_eq!(line["Environment"], "staging");
        assert_eq!(line["Operation"], "getGameState");
        assert_eq!(line["RequestCount"], 1.0);
        let declaration = &line["_aws"]["CloudWatchMetrics"][0];
        assert_eq!(declaration["Namespace"], METRIC_NAMESPACE);
        assert_eq!(
            declaration["Dimensions"],
            json!([["Environment"], ["Environment", "Operation"]])
        );
        assert_eq!(line["_aws"]["Timestamp"], 1000);
    }

    #[test]
    fn ac6_1_3__操作の無い観測は_Environment_だけのディメンションで_操作の項目を持たない() {
        let lines = emf_lines(
            "prod",
            &[sample(metric_names::CONCURRENCY_CONFLICT, 1.0, 5, None)],
        );
        let json = parse(&lines);
        assert_eq!(
            json[0]["_aws"]["CloudWatchMetrics"][0]["Dimensions"],
            json!([["Environment"]])
        );
        assert!(json[0].get("Operation").is_none());
    }

    #[test]
    fn ac6_1_3__同じ名前の観測は_1_行に_2_回入れず_別の行にする() {
        let lines = emf_lines(
            "e",
            &[
                sample(metric_names::RETRY_EXHAUSTED, 1.0, 1, None),
                sample(metric_names::RETRY_EXHAUSTED, 1.0, 1, None),
            ],
        );
        assert_eq!(lines.len(), 2);
    }

    #[test]
    fn ac6_1_5__主要な操作の成功だけが_1_秒の解像度で保存される() {
        let lines = emf_lines(
            "e",
            &[
                sample(
                    metric_names::MAIN_OPERATION_SUCCESS,
                    1.0,
                    1,
                    Some("commitWeek"),
                ),
                sample(metric_names::REQUEST_COUNT, 1.0, 1, Some("commitWeek")),
            ],
        );
        let metrics = &parse(&lines)[0]["_aws"]["CloudWatchMetrics"][0]["Metrics"];
        let find = |name: &str| {
            metrics
                .as_array()
                .and_then(|a| a.iter().find(|m| m["Name"] == name))
                .cloned()
        };
        assert_eq!(
            find("MainOperationSuccess").map(|m| m["StorageResolution"].clone()),
            Some(json!(1))
        );
        assert_eq!(
            find("RequestCount").map(|m| m["StorageResolution"].clone()),
            Some(Value::Null)
        );
    }

    #[test]
    fn nf_s14__出力には識別子や資格の置き場所が無い() {
        // 観測の型にゲーム ID・表示名・資格の項目が無いので、出力の項目は決まった名前だけ
        let lines = emf_lines(
            "e",
            &[sample(
                metric_names::REQUEST_COUNT,
                1.0,
                1,
                Some("joinGame"),
            )],
        );
        let object = parse(&lines)
            .into_iter()
            .next()
            .and_then(|v| v.as_object().cloned())
            .unwrap_or_default();
        let mut keys: Vec<&str> = object.keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            vec!["Environment", "Operation", "RequestCount", "_aws"]
        );
    }

    #[test]
    fn ac6_1_3__sink_は_行ごとに_JSON_として読める出力を書く() {
        let sink = EmfMetricSink::new("e", Vec::<u8>::new());
        sink.record(&[sample(
            metric_names::REQUEST_COUNT,
            1.0,
            1,
            Some("getHealth"),
        )]);
        let written = sink.out.lock().map(|b| b.clone()).unwrap_or_default();
        let text = String::from_utf8(written).unwrap_or_default();
        assert_eq!(text.lines().count(), 1);
        assert!(
            text.lines()
                .all(|l| serde_json::from_str::<Value>(l).is_ok())
        );
    }
}
