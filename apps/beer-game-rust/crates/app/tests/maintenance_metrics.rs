// 理由: RT1 の命名（承認済み）の `__` を使うため。
#![allow(non_snake_case)]

//! 起動モード（`rebuild-projections`・`verify-projections`）が、結果をメトリクスとして出す（AC6.1.6）。実 PostgreSQL 18.6。

use std::sync::Mutex;

use beergame_app::maintenance_mode::run;
use beergame_application::{MetricSample, MetricSink, metric_names};

mod support;
use support::api::{app, e, prepared};
use support::start;

#[derive(Default)]
struct Capture(Mutex<Vec<MetricSample>>);

impl MetricSink for Capture {
    fn record(&self, samples: &[MetricSample]) {
        if let Ok(mut all) = self.0.lock() {
            all.extend_from_slice(samples);
        }
    }
}

impl Capture {
    fn latest(&self, name: &str) -> Option<f64> {
        self.0
            .lock()
            .ok()?
            .iter()
            .rev()
            .find(|s| s.name == name)
            .map(|s| s.value)
    }
}

fn uuid_of(id: &str) -> Vec<String> {
    vec![id.to_owned()]
}

#[tokio::test]
async fn ac6_1_6__検査のモードは_整合したゲームなら不一致と遅れが_0_件のメトリクスを出し_終了コード_0()
-> Result<(), String> {
    let Some(env) = start().await? else {
        return Ok(());
    };
    let router = app(env.pool.clone());
    let game = prepared(&router, &env.pool).await?;
    let sink = Capture::default();
    let code = run(
        "verify-projections",
        env.pool.clone(),
        &uuid_of(&game.id),
        &sink,
    )
    .await;
    assert_eq!(code, 0);
    assert_eq!(
        sink.latest(metric_names::PROJECTION_MISMATCH_GAMES),
        Some(0.0)
    );
    assert_eq!(sink.latest(metric_names::PROJECTION_LAG_GAMES), Some(0.0));
    assert_eq!(
        sink.latest(metric_names::PROJECTION_UNCHECKED_GAMES),
        Some(0.0)
    );
    Ok(())
}

#[tokio::test]
async fn ac6_1_6__検査のモードは_行が壊れていれば不一致_1_件のメトリクスを出し_終了コード_1()
-> Result<(), String> {
    let Some(env) = start().await? else {
        return Ok(());
    };
    let router = app(env.pool.clone());
    let game = prepared(&router, &env.pool).await?;
    sqlx::query("UPDATE game_overview SET status = 'ENDED' WHERE game_id = $1::uuid")
        .bind(&game.id)
        .execute(&env.pool)
        .await
        .map_err(e)?;
    let sink = Capture::default();
    let code = run(
        "verify-projections",
        env.pool.clone(),
        &uuid_of(&game.id),
        &sink,
    )
    .await;
    assert_eq!(code, 1);
    assert_eq!(
        sink.latest(metric_names::PROJECTION_MISMATCH_GAMES),
        Some(1.0)
    );
    Ok(())
}

#[tokio::test]
async fn ac6_1_6__再構築のモードは_所要時間のメトリクスを出し_壊れた行を直す() -> Result<(), String>
{
    let Some(env) = start().await? else {
        return Ok(());
    };
    let router = app(env.pool.clone());
    let game = prepared(&router, &env.pool).await?;
    sqlx::query("UPDATE game_overview SET status = 'ENDED' WHERE game_id = $1::uuid")
        .bind(&game.id)
        .execute(&env.pool)
        .await
        .map_err(e)?;
    let sink = Capture::default();
    assert_eq!(
        run(
            "rebuild-projections",
            env.pool.clone(),
            &uuid_of(&game.id),
            &sink
        )
        .await,
        0
    );
    assert!(
        sink.latest(metric_names::PROJECTION_REBUILD_MILLIS)
            .is_some()
    );
    // 直った（検査が不一致 0 件）
    let after = Capture::default();
    assert_eq!(
        run(
            "verify-projections",
            env.pool.clone(),
            &uuid_of(&game.id),
            &after
        )
        .await,
        0
    );
    Ok(())
}

#[tokio::test]
async fn ac6_1_6__形が不正なゲーム_ID_は終了コード_64_で_メトリクスは出さない() -> Result<(), String>
{
    let Some(env) = start().await? else {
        return Ok(());
    };
    let sink = Capture::default();
    let code = run(
        "verify-projections",
        env.pool.clone(),
        &["not-a-uuid".to_owned()],
        &sink,
    )
    .await;
    assert_eq!(code, 64);
    assert!(
        sink.latest(metric_names::PROJECTION_MISMATCH_GAMES)
            .is_none()
    );
    Ok(())
}
