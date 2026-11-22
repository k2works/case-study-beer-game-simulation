//! 保持と削除（US5.1）。期限に達したゲームを、`game_roots` の連鎖削除で消す。失敗したら何も消さず、最大 5 回、指数バックオフで再試行する
//! （AC5.1.3）。削除の完了と同じトランザクションで、削除の進行の記録を消し、ゲームを特定しない受領記録を書く（AC5.1.4）。
//! 時計は `Env`、実際の読み書きは [`RetentionStore`]（ポート）。

use std::future::Future;

use beergame_domain::{GameId, Instant};

use crate::{AppFailure, AppSettings, Env, Secret, digest};

/// 再試行の上限（試行の回数）。
pub const MAX_ATTEMPTS: i32 = 5;
/// 1 回目の失敗のあとの待ち（ミリ秒）。以降、倍にする（10 分、20 分、40 分、80 分）。
const BACKOFF_BASE_MILLIS: i64 = 10 * 60 * 1000;
/// 試行の貸出の期限（これを過ぎても完了が記録されなければ、停止とみなして再開する）。
const LEASE_MILLIS: i64 = 10 * 60 * 1000;
/// 受領記録の保持（1 年）。
const RECEIPT_TTL_MILLIS: i64 = 365 * 24 * 60 * 60 * 1000;
/// バックアップに削除前のデータが残る最大の日数（AC5.1.5）。
pub const BACKUP_RETENTION_DAYS: i64 = 7;

/// 削除の対象（期限に達して、いま試行してよいゲーム）。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DueGame {
    pub game_id: GameId,
    /// これまでの試行の回数（まだ試行していなければ 0）。
    pub attempt: i32,
}

/// 保持状態（`Retention` の元）。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RetentionState {
    pub retention_days: i64,
    pub starts_at_millis: i64,
    pub delete_after_millis: i64,
    /// `SCHEDULED`・`IN_PROGRESS`・`RETRY_PENDING`・`ABANDONED`。
    pub status: String,
    pub attempt: i64,
    pub next_attempt_at_millis: Option<i64>,
    pub last_failure_code: Option<String>,
}

/// 削除の結果。
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct RetentionReport {
    /// 削除を完了したゲームの数。
    pub completed: usize,
    /// 再試行の上限に達して、再試行をやめたゲーム（通知する）。
    pub abandoned: Vec<GameId>,
}

/// 保持と削除の永続化のポート。
pub trait RetentionStore: Sync {
    /// 期限（`delete_after <= now`）に達し、いま試行してよいゲーム。`only` があれば、その中だけ。
    fn due_games(
        &self,
        now: Instant,
        only: Option<&[GameId]>,
    ) -> impl Future<Output = Result<Vec<DueGame>, AppFailure>> + Send;

    /// 試行を始める（`deletion_runs` を作る・更新する。`attempt + 1`。貸出の期限を `lease_until` にする）。
    fn begin_attempt(
        &self,
        game_id: GameId,
        now: Instant,
        lease_until: Instant,
    ) -> impl Future<Output = Result<(), AppFailure>> + Send;

    /// 削除を完了する（1 つのトランザクション: `game_roots` の連鎖削除、削除の進行の記録の削除、受領記録の挿入）。
    fn erase_and_record(
        &self,
        game_id: GameId,
        receipt_digest: &str,
        now: Instant,
        receipt_expires_at: Instant,
    ) -> impl Future<Output = Result<(), AppFailure>> + Send;

    /// 失敗を記録する。`next_attempt_at` が `None` なら、再試行をやめた状態。
    fn record_failure(
        &self,
        game_id: GameId,
        failure_code: &str,
        next_attempt_at: Option<Instant>,
    ) -> impl Future<Output = Result<(), AppFailure>> + Send;

    /// 期限切れの受領記録を掃除する。
    fn purge_receipts(&self, now: Instant) -> impl Future<Output = Result<(), AppFailure>> + Send;
}

/// 失敗した試行（`attempt` 回目）の次の試行の時刻。上限に達していれば `None`（再試行をやめる）。
#[must_use]
pub fn next_attempt_after_failure(attempt: i32, now: Instant) -> Option<Instant> {
    if attempt >= MAX_ATTEMPTS {
        return None;
    }
    let exponent = u32::try_from(attempt.saturating_sub(1)).unwrap_or(0);
    let wait = BACKOFF_BASE_MILLIS.saturating_mul(2_i64.saturating_pow(exponent));
    Some(Instant::from_epoch_millis(
        now.epoch_millis().saturating_add(wait),
    ))
}

fn after(now: Instant, millis: i64) -> Instant {
    Instant::from_epoch_millis(now.epoch_millis().saturating_add(millis))
}

/// 期限に達したゲームを削除する（1 回の実行）。失敗は、そのゲームだけに記録し、他のゲームの削除は続ける。
///
/// # Errors
/// 期限の検出・受領記録の掃除の失敗（個々の削除の失敗は、記録して続ける）。
pub async fn run_retention(
    store: &impl RetentionStore,
    env: &impl Env,
    settings: &AppSettings,
    only: Option<&[GameId]>,
) -> Result<RetentionReport, AppFailure> {
    let now = env.now();
    let mut report = RetentionReport::default();
    for due in store.due_games(now, only).await? {
        let attempt = due.attempt.saturating_add(1);
        store
            .begin_attempt(due.game_id, now, after(now, LEASE_MILLIS))
            .await?;
        let reference = game_reference(settings, due.game_id);
        let outcome = match reference {
            Some(digest) => {
                store
                    .erase_and_record(due.game_id, &digest, now, after(now, RECEIPT_TTL_MILLIS))
                    .await
            }
            None => Err(AppFailure::Unauthorized),
        };
        match outcome {
            Ok(()) => report.completed += 1,
            Err(failure) => {
                let next = next_attempt_after_failure(attempt, now);
                store
                    .record_failure(due.game_id, failure_code(&failure), next)
                    .await?;
                if next.is_none() {
                    report.abandoned.push(due.game_id);
                }
            }
        }
    }
    store.purge_receipts(now).await?;
    Ok(report)
}

/// 失敗の分類（値は含まない）。
fn failure_code(failure: &AppFailure) -> &'static str {
    match failure {
        AppFailure::Persistence(_) => "persistence",
        AppFailure::ConcurrencyConflict | AppFailure::RetryExhausted => "contention",
        AppFailure::Invalid(_)
        | AppFailure::Domain(_)
        | AppFailure::IdempotencyKeyReused
        | AppFailure::Unauthorized => "internal",
    }
}

/// 受領記録に書く、ゲームの ID の鍵付きダイジェスト（ゲームを特定しない形）。
fn game_reference(settings: &AppSettings, game_id: GameId) -> Option<String> {
    digest(
        &settings.credential_key,
        &Secret::new(format!("deletion:{}", game_id.get())),
    )
}
