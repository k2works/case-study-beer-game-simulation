//! 保持と削除（US5.1）のステップ。時間の経過は、削除の処理（掃引）に渡す時計をずらして表す（実際には待たない）。
//! 削除の失敗は、`RetentionStore` を包んで再現する（失敗した試行は何も消さない）。掃引は、このシナリオで作ったゲームだけを対象にする
//! （共有の DB にある他のシナリオのゲームを巻き込まない）。

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use beergame_adapter_persistence::PgRetentionStore;
use beergame_application::{
    AppFailure, DueGame, Env, PersistenceFailure, RetentionReport, RetentionStore, run_retention,
};
use beergame_domain::{GameId, Instant};
use cucumber::{given, then, when};
use serde_json::{Value, json};

use crate::steps::{R, expect, join_named, kit_demand};
use crate::world::ApiWorld;

const DAY_MILLIS: i64 = 86_400_000;
const MINUTE_MILLIS: i64 = 60_000;

/// 実時間からずらした時計の環境（ID や乱数は削除の処理では使わない）。
struct ShiftedEnv(i64);

impl Env for ShiftedEnv {
    fn now(&self) -> Instant {
        Instant::from_epoch_millis(real_now_millis().saturating_add(self.0))
    }

    fn new_id(&self) -> u128 {
        0
    }

    fn token_bytes(&self) -> [u8; 32] {
        [0; 32]
    }

    fn join_code(&self) -> String {
        String::new()
    }
}

fn real_now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
}

/// 削除の完了だけを、残りの回数ぶん失敗させる `RetentionStore`。
struct FlakyStore {
    inner: PgRetentionStore,
    failures: Arc<AtomicUsize>,
}

impl RetentionStore for FlakyStore {
    async fn due_games(
        &self,
        now: Instant,
        only: Option<&[GameId]>,
    ) -> Result<Vec<DueGame>, AppFailure> {
        self.inner.due_games(now, only).await
    }

    async fn begin_attempt(
        &self,
        game_id: GameId,
        now: Instant,
        lease_until: Instant,
    ) -> Result<(), AppFailure> {
        self.inner.begin_attempt(game_id, now, lease_until).await
    }

    async fn erase_and_record(
        &self,
        game_id: GameId,
        receipt_digest: &str,
        now: Instant,
        receipt_expires_at: Instant,
    ) -> Result<(), AppFailure> {
        let injected = self
            .failures
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |n| n.checked_sub(1))
            .is_ok();
        if injected {
            return Err(AppFailure::Persistence(PersistenceFailure::Storage(
                "注入した失敗".to_owned(),
            )));
        }
        self.inner
            .erase_and_record(game_id, receipt_digest, now, receipt_expires_at)
            .await
    }

    async fn record_failure(
        &self,
        game_id: GameId,
        failure_code: &str,
        next_attempt_at: Option<Instant>,
    ) -> Result<(), AppFailure> {
        self.inner
            .record_failure(game_id, failure_code, next_attempt_at)
            .await
    }

    async fn purge_receipts(&self, now: Instant) -> Result<(), AppFailure> {
        self.inner.purge_receipts(now).await
    }
}

fn game_id_of(uuid: &str) -> Result<GameId, String> {
    u128::from_str_radix(&uuid.replace('-', ""), 16)
        .map(GameId::new)
        .map_err(|e| e.to_string())
}

async fn receipts(world: &ApiWorld) -> Result<i64, String> {
    sqlx::query_scalar("SELECT count(*) FROM deletion_receipts")
        .fetch_one(world.pool()?)
        .await
        .map_err(|e| e.to_string())
}

/// 時計を `millis` 進めて、削除処理を 1 回行う。
async fn advance_and_sweep(world: &mut ApiWorld, millis: i64) -> Result<RetentionReport, String> {
    world.ready().await?;
    world.clock_offset_millis = world.clock_offset_millis.saturating_add(millis);
    sweep(world).await
}

async fn sweep(world: &mut ApiWorld) -> Result<RetentionReport, String> {
    world.receipts_before = receipts(world).await?;
    let store = FlakyStore {
        inner: PgRetentionStore::new(world.pool()?.clone()),
        failures: Arc::clone(&world.deletion_failures),
    };
    let only: Vec<GameId> = world
        .games
        .iter()
        .map(|g| game_id_of(&g.id))
        .collect::<Result<_, _>>()?;
    let report = run_retention(
        &store,
        &ShiftedEnv(world.clock_offset_millis),
        &ApiWorld::settings(1, 5, Vec::new()),
        Some(&only),
    )
    .await
    .map_err(|e| format!("削除処理が失敗した: {e:?}"))?;
    world.completed = report.completed;
    world.abandoned = report.abandoned.len();
    Ok(report)
}

// ---- 作成 ----

async fn create_with_retention(world: &mut ApiWorld, final_week: usize, days: Option<i64>) -> R {
    let mut body = json!({
        "kind": "KIT",
        "finalWeek": final_week,
        "demand": kit_demand(final_week),
    });
    if let (Some(days), Some(map)) = (days, body.as_object_mut()) {
        map.insert("retentionDays".to_owned(), json!(days));
    }
    let reply = world.create_with(&body).await?;
    expect(reply.status == 201, "作成できなかった")
}

#[given("進行役が、保持期間を指定せずにキット準拠のゲームを作成している")]
async fn created_default(world: &mut ApiWorld) -> R {
    create_with_retention(world, 12, None).await
}

#[given(regex = r"^進行役が、保持期間 (\d+) 日でキット準拠のゲームを作成している$")]
async fn created_with_days(world: &mut ApiWorld, days: i64) -> R {
    create_with_retention(world, 12, Some(days)).await
}

#[given(regex = r"^進行役が、最終週 (\d+) のキット準拠のゲームを保持期間 (\d+) 日で作成している$")]
async fn created_with_week_and_days(world: &mut ApiWorld, final_week: usize, days: i64) -> R {
    create_with_retention(world, final_week, Some(days)).await
}

#[given(regex = r"^もう 1 つ、保持期間 (\d+) 日のキット準拠のゲームが作成されている$")]
async fn another_game(world: &mut ApiWorld, days: i64) -> R {
    create_with_retention(world, 12, Some(days)).await
}

#[given("参加者が参加している")]
async fn participant_joined(world: &mut ApiWorld) -> R {
    join_named(world, "参加者").await
}

// ---- 失敗の差し込み ----

#[given(regex = r"^削除の処理が、最初の (\d+) 回だけ失敗する$")]
async fn fail_first(world: &mut ApiWorld, times: usize) -> R {
    world.deletion_failures.store(times, Ordering::SeqCst);
    Ok(())
}

#[given(regex = r"^削除の処理が、(\d+) 回続けて失敗する$")]
async fn fail_repeatedly(world: &mut ApiWorld, times: usize) -> R {
    world.deletion_failures.store(times, Ordering::SeqCst);
    Ok(())
}

// ---- 保持状態の取得 ----

async fn fetch_retention(world: &mut ApiWorld, cookie: Option<String>) -> R {
    let id = first_game(world)?.id.clone();
    world
        .call(
            "GET",
            &format!("/api/v1/games/{id}/retention"),
            cookie.as_deref(),
            None,
            "",
        )
        .await
        .map(|_| ())
}

fn first_game(world: &ApiWorld) -> Result<&crate::world::GameCtx, String> {
    world.games.first().ok_or_else(|| "ゲームが無い".to_owned())
}

#[when("進行役が保持状態を取得する")]
async fn facilitator_fetches(world: &mut ApiWorld) -> R {
    let cookie = first_game(world)?.facilitator.clone();
    fetch_retention(world, Some(cookie)).await?;
    expect(world.reply()?.status == 200, "保持状態を取得できない")
}

#[when("参加者が保持状態を取得しようとする")]
async fn participant_fetches(world: &mut ApiWorld) -> R {
    let (_, cookie) = first_game(world)?
        .named
        .values()
        .next()
        .cloned()
        .ok_or("参加者が無い")?;
    fetch_retention(world, Some(cookie)).await
}

#[when("資格の無い人が保持状態を取得しようとする")]
async fn anonymous_fetches(world: &mut ApiWorld) -> R {
    fetch_retention(world, None).await
}

/// 進行役の資格で、いまの保持状態を取り直す。
async fn current_retention(world: &mut ApiWorld) -> Result<Value, String> {
    let cookie = first_game(world)?.facilitator.clone();
    fetch_retention(world, Some(cookie)).await?;
    let reply = world.reply()?;
    expect(reply.status == 200, "保持状態を取得できない")?;
    Ok(reply.body.clone())
}

#[then(regex = r"^保持期間は (\d+) 日で、削除予定日は作成の (\d+) 日後である$")]
async fn period_is(world: &mut ApiWorld, days: i64, after_days: i64) -> R {
    let body = world.reply()?.body.clone();
    expect(
        body.get("retentionDays") == Some(&json!(days)),
        "保持期間が違う",
    )?;
    let id = first_game(world)?.id.clone();
    let matches: bool = sqlx::query_scalar(
        "SELECT (delete_after - retention_starts_at) = make_interval(days => $2::integer) \
         FROM retention_policies WHERE game_id = $1::uuid",
    )
    .bind(&id)
    .bind(i32::try_from(after_days).map_err(|e| e.to_string())?)
    .fetch_one(world.pool()?)
    .await
    .map_err(|e| e.to_string())?;
    expect(matches, "削除予定日が、作成の日数後ではない")
}

#[then("バックアップに削除後も 7 日残ることが示される")]
async fn backup_days(world: &mut ApiWorld) -> R {
    expect(
        world.reply()?.body.get("backupRetentionDays") == Some(&json!(7)),
        "バックアップの期間が 7 日ではない",
    )
}

fn status_name(ja: &str) -> Result<&'static str, String> {
    match ja {
        "予定" => Ok("SCHEDULED"),
        "削除中" => Ok("IN_PROGRESS"),
        "再試行待ち" => Ok("RETRY_PENDING"),
        "再試行の上限に達した" => Ok("ABANDONED"),
        other => Err(format!("未知の保持状態: {other}")),
    }
}

#[then(regex = r"^保持状態は「(.+)」である$")]
async fn status_is(world: &mut ApiWorld, status: String) -> R {
    let body = current_retention(world).await?;
    expect(
        body.get("status") == Some(&json!(status_name(&status)?)),
        &format!("保持状態が違う: {body}"),
    )
}

#[then(regex = r"^保持状態は「(.+)」で、試行は (\d+) 回目である$")]
async fn status_and_attempt_are(world: &mut ApiWorld, status: String, attempt: i64) -> R {
    let body = current_retention(world).await?;
    expect(
        body.get("status") == Some(&json!(status_name(&status)?)),
        &format!("保持状態が違う: {body}"),
    )?;
    expect(
        body.get("attempt") == Some(&json!(attempt)),
        &format!("試行の回数が違う: {body}"),
    )
}

// ---- 削除処理 ----

#[when(regex = r"^時計が (\d+) 日進み、削除処理が行われる$")]
async fn days_pass_and_sweep(world: &mut ApiWorld, days: i64) -> R {
    advance_and_sweep(world, days * DAY_MILLIS)
        .await
        .map(|_| ())
}

#[when(regex = r"^時計が (\d+) 分進み、削除処理が行われる$")]
async fn minutes_pass_and_sweep(world: &mut ApiWorld, minutes: i64) -> R {
    advance_and_sweep(world, minutes * MINUTE_MILLIS)
        .await
        .map(|_| ())
}

#[when(regex = r"^時計が (\d+) 日進み、削除処理を、再試行の時刻ごとに (\d+) 回行う$")]
async fn sweep_at_each_retry(world: &mut ApiWorld, days: i64, times: usize) -> R {
    let (mut completed, mut abandoned) = (0, 0);
    let mut report = advance_and_sweep(world, days * DAY_MILLIS).await?;
    completed += report.completed;
    abandoned += report.abandoned.len();
    for _ in 1..times {
        // 次の再試行の時刻（再試行をやめた後は無い）まで、時計を進める
        let id = first_game(world)?.id.clone();
        let next: Option<i64> = sqlx::query_scalar(
            "SELECT (extract(epoch FROM max(next_attempt_at)) * 1000)::bigint \
             FROM deletion_runs WHERE game_id = $1::uuid AND next_attempt_at IS NOT NULL",
        )
        .bind(&id)
        .fetch_one(world.pool()?)
        .await
        .map_err(|e| e.to_string())?;
        if let Some(next) = next {
            // 再試行の時刻を 1 秒だけ過ぎるところまで進める
            let target = next.saturating_add(1_000);
            world.clock_offset_millis = target.saturating_sub(real_now_millis());
        }
        report = sweep(world).await?;
        completed += report.completed;
        abandoned += report.abandoned.len();
    }
    world.completed = completed;
    world.abandoned = abandoned;
    Ok(())
}

#[then(regex = r"^削除は (\d+) 件完了している$")]
async fn completed_is(world: &mut ApiWorld, count: usize) -> R {
    expect(
        world.completed == count,
        &format!("完了した削除の数が違う: {} 件", world.completed),
    )
}

#[then("削除をやめたゲームが 1 件通知される")]
async fn abandoned_notified(world: &mut ApiWorld) -> R {
    expect(
        world.abandoned == 1,
        &format!("通知されたゲームの数が違う: {} 件", world.abandoned),
    )
}

#[then("削除の受領記録が 1 件増え、ゲームの ID を含まない")]
async fn receipt_added(world: &mut ApiWorld) -> R {
    let now = receipts(world).await?;
    expect(
        now == world.receipts_before + 1,
        &format!(
            "受領記録が 1 件増えていない（前 {}、後 {now}）",
            world.receipts_before
        ),
    )?;
    let id = first_game(world)?.id.clone();
    let leaked: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM deletion_receipts \
         WHERE game_reference_digest LIKE '%' || $1 || '%' OR game_reference_digest LIKE '%' || replace($1, '-', '') || '%'",
    )
    .bind(&id)
    .fetch_one(world.pool()?)
    .await
    .map_err(|e| e.to_string())?;
    expect(leaked == 0, "受領記録がゲームの ID を含む")
}

#[then("削除の受領記録は増えない")]
async fn receipt_not_added(world: &mut ApiWorld) -> R {
    let now = receipts(world).await?;
    expect(
        now == world.receipts_before,
        &format!("受領記録が増えた（前 {}、後 {now}）", world.receipts_before),
    )
}

// ---- 削除の結果 ----

async fn state_status(world: &mut ApiWorld, cookie: String, game: usize) -> Result<u16, String> {
    let id = world.games.get(game).ok_or("ゲームが無い")?.id.clone();
    world
        .call(
            "GET",
            &format!("/api/v1/games/{id}/state"),
            Some(&cookie),
            None,
            "",
        )
        .await
        .map(|r| r.status)
}

#[then("進行役の資格で、このゲームの状態を取得できる")]
async fn facilitator_can_read(world: &mut ApiWorld) -> R {
    let cookie = first_game(world)?.facilitator.clone();
    expect(
        state_status(world, cookie, 0).await? == 200,
        "状態を取得できない",
    )
}

#[then("進行役の資格では、このゲームの状態を取得できない")]
async fn facilitator_cannot_read(world: &mut ApiWorld) -> R {
    let cookie = first_game(world)?.facilitator.clone();
    expect(state_status(world, cookie, 0).await? == 403, "403 ではない")
}

#[then("参加者の資格では、このゲームの状態を取得できない")]
async fn participant_cannot_read(world: &mut ApiWorld) -> R {
    let (_, cookie) = first_game(world)?
        .named
        .values()
        .next()
        .cloned()
        .ok_or("参加者が無い")?;
    expect(state_status(world, cookie, 0).await? == 403, "403 ではない")
}

#[then("2 つ目のゲームの進行役の資格で、そのゲームの状態を取得できる")]
async fn second_facilitator_can_read(world: &mut ApiWorld) -> R {
    let cookie = world
        .games
        .get(1)
        .ok_or("2 つ目のゲームが無い")?
        .facilitator
        .clone();
    expect(
        state_status(world, cookie, 1).await? == 200,
        "状態を取得できない",
    )
}

#[then("参加コードで、このゲームに参加できない")]
async fn cannot_join(world: &mut ApiWorld) -> R {
    let join_code = first_game(world)?.join_code.clone();
    let key = world.next_key();
    let reply = world
        .call(
            "POST",
            "/api/v1/participations/join",
            None,
            Some(&key),
            &json!({"joinCode": join_code, "displayName": "後から来た人"}).to_string(),
        )
        .await?;
    expect(
        reply.status >= 400,
        &format!("削除したゲームに参加できた: {}", reply.status),
    )
}

// ---- 表に行が残らない（AC5.1.4） ----

/// `game_id` 列を持つ表（`game_roots` を含む）の名前。
async fn tables_with_game_id(world: &ApiWorld) -> Result<Vec<String>, String> {
    sqlx::query_scalar(
        "SELECT table_name::text FROM information_schema.columns \
         WHERE table_schema = 'public' AND column_name = 'game_id' ORDER BY table_name",
    )
    .fetch_all(world.pool()?)
    .await
    .map_err(|e| e.to_string())
}

async fn rows_of(world: &ApiWorld, table: &str, id: &str) -> Result<i64, String> {
    // 表の名前は information_schema から得た値（利用者の入力ではない）
    sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "SELECT count(*) FROM \"{table}\" WHERE game_id = $1::uuid"
    )))
    .bind(id)
    .fetch_one(world.pool()?)
    .await
    .map_err(|e| e.to_string())
}

#[given("ゲームの記録・履歴・資格の表に、このゲームの行がある")]
async fn rows_exist(world: &mut ApiWorld) -> R {
    let id = first_game(world)?.id.clone();
    for table in ["game_roots", "events", "credentials"] {
        expect(
            rows_of(world, table, &id).await? > 0,
            &format!("{table} にこのゲームの行が無い"),
        )?;
    }
    Ok(())
}

#[then("ゲームの ID を持つ表のどれにも、このゲームの行が残らない")]
async fn no_rows_remain(world: &mut ApiWorld) -> R {
    let id = first_game(world)?.id.clone();
    let tables = tables_with_game_id(world).await?;
    expect(tables.len() >= 10, "game_id を持つ表を拾えていない")?;
    for table in tables {
        let rows = rows_of(world, &table, &id).await?;
        expect(rows == 0, &format!("{table} に {rows} 行が残っている"))?;
    }
    Ok(())
}
