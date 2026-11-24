//! メトリクスとアラーム（AC6.1.3・6.1.5・6.1.6）のステップ。メトリクスは、アプリが実際に出した観測（EMF の元）を確かめる。
//! アラームの訓練は、**模擬の時計**（基準からの秒数）と故障を模擬したメトリクスの系列を、本番と同じ閾値の表（`alarm_catalog`）の
//! 評価に与える。実際の待機はしない。AWS 上の評価は確認していない。

use beergame_adapter_http::emf_lines;
use beergame_application::{
    AlarmState, MetricSample, MetricUnit, alarm_catalog, detection_delay, evaluate, metric_names,
};
use cucumber::{given, then, when};

use crate::steps::{R, expect, join_named, kit_demand};
use crate::world::ApiWorld;

const SUCCESS_INTERVAL: usize = 5;
const CANARY_INTERVAL: usize = 60;
const CANARY_HORIZON: i64 = 1_200;
const RATE_SAMPLES: usize = 100;
const RATE_HORIZON: usize = 900;
const CONFLICT_EVALUATED_AT: i64 = 600;
const DAY_SECONDS: i64 = 86_400;

// ---- メトリクスの出力（AC6.1.3） ----

#[given(regex = r"^参加者が表示名「(.+)」でゲームに参加している$")]
async fn participant_joined(world: &mut ApiWorld, name: String) -> R {
    if world.games.is_empty() {
        let reply = world.create_game(12, &kit_demand(12)).await?;
        expect(reply.status == 201, "ゲームを作成できない")?;
    }
    join_named(world, &name).await
}

#[when("状況を取得する要求を処理する")]
async fn handle_state_request(world: &mut ApiWorld) -> R {
    let game = world.game()?;
    let (id, cookie) = (
        game.id.clone(),
        game.named
            .values()
            .next()
            .map(|(_, cookie)| cookie.clone())
            .ok_or("参加者が無い")?,
    );
    let reply = world
        .call(
            "GET",
            &format!("/api/v1/games/{id}/state"),
            Some(&cookie),
            None,
            "",
        )
        .await?;
    expect(reply.status == 200, "状況を取得できない")
}

fn named(world: &ApiWorld, name: &str, operation: &str) -> Vec<MetricSample> {
    world
        .metrics
        .all()
        .into_iter()
        .filter(|s| s.name == name && s.operation.as_deref() == Some(operation))
        .collect()
}

#[then(regex = r"^操作「(.+)」の応答時間と要求数のメトリクスが EMF の行として出力される$")]
async fn request_metrics_emitted(world: &mut ApiWorld, operation: String) -> R {
    expect(
        !named(world, metric_names::REQUEST_DURATION_MILLIS, &operation).is_empty(),
        &format!("操作 {operation} の応答時間のメトリクスが出力されていない"),
    )?;
    expect(
        !named(world, metric_names::REQUEST_COUNT, &operation).is_empty(),
        &format!("操作 {operation} の要求数が無い"),
    )?;
    let text = emf_lines("test", &world.metrics.all()).join("\n");
    for needle in [
        "_aws",
        "CloudWatchMetrics",
        "RequestDurationMillis",
        &format!("\"Operation\":\"{operation}\""),
    ] {
        expect(
            text.contains(needle),
            &format!("出力された EMF の行に {needle} が無い"),
        )?;
    }
    Ok(())
}

#[then(regex = r"^メトリクスの出力に、資格、表示名「(.+)」、非公開の値は含まれない$")]
async fn no_secrets(world: &mut ApiWorld, name: String) -> R {
    let text = emf_lines("test", &world.metrics.all()).join("\n");
    let game = world.game()?;
    let mut secrets = vec![
        name,
        game.facilitator.clone(),
        game.join_code.clone(),
        game.id.clone(),
        "bg_session".to_owned(),
    ];
    secrets.extend(game.named.values().map(|(_, cookie)| cookie.clone()));
    for secret in secrets {
        expect(
            !text.contains(&secret),
            &format!("メトリクスに、資格・表示名・非公開の値が含まれている: {secret}"),
        )?;
    }
    Ok(())
}

#[given("アプリケーションが準備できている")]
async fn app_ready(world: &mut ApiWorld) -> R {
    world.ready().await?;
    let reply = world.call("GET", "/api/v1/ready", None, None, "").await?;
    expect(reply.status == 200, "準備できていない")
}

#[when("データベースに接続できなくなる")]
async fn lose_database(world: &mut ApiWorld) -> R {
    world.lose_database().await
}

#[then("準備のヘルスチェックは準備できていないことを示す")]
async fn not_ready(world: &mut ApiWorld) -> R {
    let reply = world.call("GET", "/api/v1/ready", None, None, "").await?;
    expect(
        reply.status == 503 && reply.body.get("code") == Some(&serde_json::json!("app.not_ready")),
        "準備できていないことを示していない",
    )
}

#[then(regex = r"^操作「(.+)」の 5xx のエラー率のメトリクスが (\d+) として出力される$")]
async fn server_error_metric(world: &mut ApiWorld, operation: String, value: u8) -> R {
    let found = named(world, metric_names::SERVER_ERROR, &operation)
        .iter()
        .any(|s| s.value == f64::from(value));
    expect(
        found,
        &format!("操作 {operation} の 5xx が {value} のメトリクスが無い"),
    )
}

// ---- 投影の整合のメトリクス（AC6.1.6） ----

fn latest(world: &ApiWorld, name: &str) -> Option<f64> {
    world
        .emitted
        .iter()
        .rev()
        .find(|s| s.name == name)
        .map(|s| s.value)
}

#[then(regex = r"^投影の不一致のメトリクスが (\d+) 件として出力される$")]
async fn mismatch_metric(world: &mut ApiWorld, count: u8) -> R {
    expect(
        latest(world, metric_names::PROJECTION_MISMATCH_GAMES) == Some(f64::from(count)),
        "不一致のメトリクスが違う",
    )
}

#[then(regex = r"^投影の遅れのメトリクスが (\d+) 件として出力される$")]
async fn lag_metric(world: &mut ApiWorld, count: u8) -> R {
    expect(
        latest(world, metric_names::PROJECTION_LAG_GAMES) == Some(f64::from(count)),
        "遅れのメトリクスが違う",
    )
}

// ---- アラームの訓練（AC6.1.3・6.1.5） ----

fn counts(name: &'static str, value: f64, seconds: i64) -> MetricSample {
    MetricSample {
        name,
        unit: MetricUnit::Count,
        value,
        at_millis: seconds * 1000,
        operation: None,
    }
}

fn main_successes(until: i64, gap: std::ops::Range<i64>) -> Vec<MetricSample> {
    (0..until)
        .step_by(SUCCESS_INTERVAL)
        .filter(|t| !gap.contains(t))
        .map(|t| counts(metric_names::MAIN_OPERATION_SUCCESS, 1.0, t))
        .collect()
}

/// 5 秒ごとに `RATE_SAMPLES` 試行。`from` 以降は割合 `after`、前は `before` の試行が競合する。
fn conflict_series(before: f64, from: i64, after: f64) -> Vec<MetricSample> {
    let horizon = i64::try_from(RATE_HORIZON).unwrap_or(900);
    (0..horizon)
        .step_by(SUCCESS_INTERVAL)
        .flat_map(|t| {
            let rate = if t >= from { after } else { before };
            (1..=RATE_SAMPLES).map(move |i| {
                // 試行の数（f64 に収まる範囲）
                #[allow(clippy::cast_precision_loss)]
                let hit = (i as f64) <= rate * RATE_SAMPLES as f64;
                counts(
                    metric_names::CONCURRENCY_CONFLICT,
                    if hit { 1.0 } else { 0.0 },
                    t,
                )
            })
        })
        .collect()
}

fn rule(name: &str) -> Result<beergame_application::AlarmRule, String> {
    alarm_catalog::named(name).ok_or_else(|| format!("アラームの規則が無い: {name}"))
}

fn state_at(world: &ApiWorld, name: &str, seconds: i64) -> Result<AlarmState, String> {
    Ok(evaluate(
        &rule(name)?,
        &world.drill.samples,
        seconds,
        world.drill.training,
    ))
}

#[given("研修中で、主要な操作が 5 秒ごとに成功している")]
async fn training_with_successes(world: &mut ApiWorld) -> R {
    world.drill.training = true;
    Ok(())
}

#[given("研修中ではなく、主要な操作が 5 秒ごとに成功している")]
async fn not_training_with_successes(world: &mut ApiWorld) -> R {
    world.drill.training = false;
    Ok(())
}

#[given("合成監視が 60 秒ごとに成功している")]
async fn canary_healthy(world: &mut ApiWorld) -> R {
    world.drill.training = true;
    Ok(())
}

#[given(regex = r"^コマンドの追記の競合率が平常（(\d+)%）である$")]
async fn conflict_rate_normal(world: &mut ApiWorld, percent: u8) -> R {
    world.drill.samples = conflict_series(f64::from(percent) / 100.0, i64::MAX, 0.0);
    Ok(())
}

#[when(regex = r"^時刻 (\d+) 秒にアプリケーションが停止する$")]
async fn app_stops(world: &mut ApiWorld, seconds: i64) -> R {
    world.drill.fault_at = seconds;
    let mut samples = main_successes(seconds, 0..0);
    let canary = (0..CANARY_HORIZON)
        .step_by(CANARY_INTERVAL)
        .map(|t| MetricSample {
            name: "SuccessPercent",
            unit: MetricUnit::Percent,
            value: if t < seconds { 100.0 } else { 0.0 },
            at_millis: t * 1000,
            operation: None,
        });
    samples.extend(canary);
    world.drill.samples = samples;
    Ok(())
}

#[when(regex = r"^時刻 (\d+) 秒から (\d+) 秒だけ、主要な操作が成功しなくなる$")]
async fn gap(world: &mut ApiWorld, from: i64, length: i64) -> R {
    world.drill.fault_at = from;
    world.drill.samples = main_successes(CANARY_HORIZON, from..from + length);
    Ok(())
}

#[when(regex = r"^時刻 (\d+) 秒から、追記の競合率が (\d+)% に急増する$")]
async fn conflict_spike(world: &mut ApiWorld, from: i64, percent: u8) -> R {
    world.drill.samples = conflict_series(0.01, from, f64::from(percent) / 100.0);
    Ok(())
}

#[then(regex = r"^停止から (\d+) 秒以内に、重大のアラーム「(.+)」が発報する$")]
async fn fires_within(world: &mut ApiWorld, seconds: i64, name: String) -> R {
    let fault = world.drill.fault_at;
    let delay = detection_delay(
        &rule(&name)?,
        &world.drill.samples,
        fault,
        fault + CANARY_HORIZON,
        world.drill.training,
    );
    expect(
        delay.is_some_and(|d| d <= seconds),
        &format!(
            "アラーム {name} は停止から {seconds} 秒以内に発報しない（検知までの時間: {delay:?}）"
        ),
    )
}

/// アプリが実際に出したメトリクス（投影の整合の検査）を、最後の観測から 1 日後に評価する。
fn fired_on_app_metrics(world: &ApiWorld, name: &str) -> Result<bool, String> {
    let latest = world
        .emitted
        .iter()
        .map(|s| s.at_millis.div_euclid(1000))
        .max()
        .ok_or("メトリクスが出力されていない")?;
    Ok(evaluate(&rule(name)?, &world.emitted, latest + DAY_SECONDS, true) == AlarmState::Alarm)
}

#[then(regex = r"^アラーム「(.+)」は発報しない$")]
async fn does_not_fire(world: &mut ApiWorld, name: String) -> R {
    let fired = if world.drill.samples.is_empty() {
        fired_on_app_metrics(world, &name)?
    } else {
        let fault = world.drill.fault_at;
        let mut at = fault;
        let mut any = false;
        while at <= CANARY_HORIZON {
            any |= state_at(world, &name, at)? == AlarmState::Alarm;
            at += 10;
        }
        any
    };
    expect(!fired, &format!("アラーム {name} が発報した"))
}

#[then(regex = r"^停止から (\d+) 秒が過ぎても、アラーム「(.+)」は発報しない$")]
async fn does_not_fire_after(world: &mut ApiWorld, seconds: i64, name: String) -> R {
    let fault = world.drill.fault_at;
    let delay = detection_delay(
        &rule(&name)?,
        &world.drill.samples,
        fault,
        fault + seconds,
        world.drill.training,
    );
    expect(
        delay.is_none(),
        &format!("アラーム {name} が発報した（検知までの時間: {delay:?}）"),
    )
}

#[then(regex = r"^警告のアラーム「(.+)」と重大のアラーム「(.+)」が発報する$")]
async fn warning_and_critical(world: &mut ApiWorld, warning: String, critical: String) -> R {
    expect(
        state_at(world, &warning, CONFLICT_EVALUATED_AT)? == AlarmState::Alarm,
        &format!("警告 {warning} が発報しない"),
    )?;
    expect(
        state_at(world, &critical, CONFLICT_EVALUATED_AT)? == AlarmState::Alarm,
        &format!("重大 {critical} が発報しない"),
    )
}

#[then(regex = r"^重大のアラーム「(.+)」が発報する$")]
async fn critical_fires(world: &mut ApiWorld, name: String) -> R {
    let fired = if world.drill.samples.is_empty() {
        fired_on_app_metrics(world, &name)?
    } else {
        state_at(world, &name, world.drill.fault_at)? == AlarmState::Alarm
    };
    expect(fired, &format!("重大 {name} が発報しない"))
}
