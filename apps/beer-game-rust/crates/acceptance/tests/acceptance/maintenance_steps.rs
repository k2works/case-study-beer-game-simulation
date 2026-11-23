//! 投影の再構築・整合検査（NF-R15）のステップ。投影の破壊（行を空にする・書き換える）は、試験が保存先を直接書いて再現する
//! （本番のコードではない）。再構築と検査は、本番の起動モードと同じ `PgProjectionMaintenance` を、同じ DB に対して呼ぶ。

use beergame_adapter_persistence::{PROJECTION_TABLES, PgProjectionMaintenance};
use beergame_application::{
    Inconsistency, ProjectionMaintenance, verify_metrics, verify_projections,
};
use beergame_domain::GameId;
use cucumber::{given, then, when};
use serde_json::json;
use sqlx::AssertSqlSafe;

use crate::steps::{R, expect};
use crate::world::ApiWorld;

fn current_game(world: &ApiWorld) -> Result<(String, GameId), String> {
    let id = world.game()?.id.clone();
    let game = u128::from_str_radix(&id.replace('-', ""), 16)
        .map(GameId::new)
        .map_err(|e| e.to_string())?;
    Ok((id, game))
}

/// 投影の内容（表ごとの行。進んだ版の記録は版だけ。時刻の記録は含めない）。
async fn snapshot(world: &ApiWorld) -> Result<String, String> {
    let (id, _) = current_game(world)?;
    let mut out = String::new();
    for table in PROJECTION_TABLES {
        let sql = format!(
            "SELECT row_to_json(t)::text FROM {table} t WHERE game_id = $1::uuid ORDER BY 1"
        );
        let rows: Vec<String> = sqlx::query_scalar(AssertSqlSafe(sql))
            .bind(&id)
            .fetch_all(world.pool()?)
            .await
            .map_err(|e| e.to_string())?;
        out.push_str(&format!("{table}: {rows:?}\n"));
    }
    let versions: Vec<(String, i64)> = sqlx::query_as(
        "SELECT stream_type, projected_version FROM projection_checkpoints \
         WHERE game_id = $1::uuid ORDER BY 1",
    )
    .bind(&id)
    .fetch_all(world.pool()?)
    .await
    .map_err(|e| e.to_string())?;
    out.push_str(&format!("checkpoints: {versions:?}\n"));
    Ok(out)
}

async fn execute(world: &ApiWorld, sql: &'static str) -> Result<u64, String> {
    let (id, _) = current_game(world)?;
    sqlx::query(sql)
        .bind(&id)
        .execute(world.pool()?)
        .await
        .map(|r| r.rows_affected())
        .map_err(|e| e.to_string())
}

#[given("そのゲームの投影の内容を控えている")]
async fn remember(world: &mut ApiWorld) -> R {
    let dump = snapshot(world).await?;
    world.projection_snapshot = Some(dump);
    Ok(())
}

#[when("そのゲームの投影をすべて空にする")]
async fn empty_all(world: &mut ApiWorld) -> R {
    let (id, _) = current_game(world)?;
    for table in PROJECTION_TABLES {
        let sql = format!("DELETE FROM {table} WHERE game_id = $1::uuid");
        sqlx::query(AssertSqlSafe(sql))
            .bind(&id)
            .execute(world.pool()?)
            .await
            .map_err(|e| e.to_string())?;
    }
    execute(
        world,
        "DELETE FROM projection_checkpoints WHERE game_id = $1::uuid",
    )
    .await
    .map(|_| ())
}

#[when("そのゲームの投影を再構築する")]
async fn rebuild(world: &mut ApiWorld) -> R {
    let (_, game) = current_game(world)?;
    let port = PgProjectionMaintenance::new(world.pool()?.clone());
    port.rebuild(game)
        .await
        .map(|_| ())
        .map_err(|e| format!("再構築できない: {e:?}"))
}

#[then("そのゲームの投影は、控えていた内容と一致する")]
async fn matches_snapshot(world: &mut ApiWorld) -> R {
    let expected = world
        .projection_snapshot
        .clone()
        .ok_or("内容を控えていない")?;
    let actual = snapshot(world).await?;
    expect(
        actual == expected,
        &format!("投影が元の内容と違う\n--- 控え\n{expected}\n--- 再構築後\n{actual}"),
    )
}

#[then("進行役が状況を取得すると、ゲームは終了している")]
async fn ended(world: &mut ApiWorld) -> R {
    let (id, cookie) = (world.game()?.id.clone(), world.game()?.facilitator.clone());
    let reply = world
        .call(
            "GET",
            &format!("/api/v1/sessions/{id}/state"),
            Some(&cookie),
            None,
            "",
        )
        .await?;
    expect(
        reply.body.get("status") == Some(&json!("ENDED")),
        "ゲームが終了していない",
    )
}

#[given("そのゲームの保持方針の行を消している")]
async fn delete_policy(world: &mut ApiWorld) -> R {
    let removed = execute(
        world,
        "DELETE FROM retention_policies WHERE game_id = $1::uuid",
    )
    .await?;
    expect(removed == 1, "保持方針の行が 1 つではなかった")
}

#[then(regex = r"^進行役が保持状態を取得すると、保持期間は (\d+) 日である$")]
async fn retention_days(world: &mut ApiWorld, days: i64) -> R {
    let (id, cookie) = (world.game()?.id.clone(), world.game()?.facilitator.clone());
    let reply = world
        .call(
            "GET",
            &format!("/api/v1/games/{id}/retention"),
            Some(&cookie),
            None,
            "",
        )
        .await?;
    expect(reply.status == 200, "保持状態を取得できない")?;
    expect(
        reply.body.get("retentionDays") == Some(&json!(days)),
        "保持期間が違う",
    )
}

#[given("そのゲームの投影の行を 1 つ書き換えている")]
async fn tamper_row(world: &mut ApiWorld) -> R {
    let changed = execute(
        world,
        "UPDATE game_overview SET status = 'PREPARING' WHERE game_id = $1::uuid",
    )
    .await?;
    expect(changed == 1, "書き換えた行が 1 つではなかった")
}

#[given("そのゲームの投影の進んだ版の記録を 1 つ戻している")]
async fn rewind_checkpoint(world: &mut ApiWorld) -> R {
    let changed = execute(
        world,
        "UPDATE projection_checkpoints SET projected_version = projected_version - 1 \
         WHERE game_id = $1::uuid AND stream_type = 'SESSION'",
    )
    .await?;
    expect(changed == 1, "戻した記録が 1 つではなかった")
}

#[when("投影の整合を検査する")]
async fn verify(world: &mut ApiWorld) -> R {
    let (_, game) = current_game(world)?;
    let port = PgProjectionMaintenance::new(world.pool()?.clone());
    // 本番の `verify-projections` と同じサービス。結果は、メトリクスにもなる（AC6.1.6）
    let report = verify_projections(&port, &[game])
        .await
        .map_err(|e| format!("検査できない: {e:?}"))?;
    expect(
        report.failed.is_empty() && report.skipped.is_empty(),
        &format!("検査できなかった: {report:?}"),
    )?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(0));
    world.emitted = verify_metrics(&report, now);
    world.findings = Some(
        report
            .inconsistent
            .into_iter()
            .flat_map(|(_, findings)| findings)
            .collect(),
    );
    Ok(())
}

fn findings(world: &ApiWorld) -> Result<&Vec<Inconsistency>, String> {
    world
        .findings
        .as_ref()
        .ok_or_else(|| "検査していない".to_owned())
}

#[then("不一致は 0 件である")]
async fn no_findings(world: &mut ApiWorld) -> R {
    let found = findings(world)?;
    expect(found.is_empty(), &format!("不一致がある: {found:?}"))
}

#[then(regex = r"^不一致が報告され、その中に表「(.+)」が含まれる$")]
async fn has_row_drift(world: &mut ApiWorld, table: String) -> R {
    let found = findings(world)?;
    expect(
        found
            .iter()
            .any(|f| matches!(f, Inconsistency::RowDrift { table: t, .. } if *t == table)),
        &format!("表 {table} の不一致が無い: {found:?}"),
    )
}

#[then(regex = r"^不一致が報告され、その中にストリーム「(.+)」の版の食い違いが含まれる$")]
async fn has_checkpoint_drift(world: &mut ApiWorld, stream: String) -> R {
    let found = findings(world)?;
    expect(
        found
            .iter()
            .any(|f| matches!(f, Inconsistency::CheckpointDrift { stream: s, .. } if *s == stream)),
        &format!("ストリーム {stream} の版の食い違いが無い: {found:?}"),
    )
}
