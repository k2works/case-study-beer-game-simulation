// 理由: RT1 の命名（承認済み）の `__` を使うため。
#![allow(non_snake_case)]

//! 保持と削除（AC5.1.2・AC5.1.3）。削除の手続きの判断（期限・再試行・打ち切り）は、偽の `RetentionStore` と固定の時計で確かめる。

use std::sync::Mutex;

use beergame_application::{
    AppFailure, AppSettings, DueGame, Env, MAX_ATTEMPTS, PersistenceFailure, RetentionStore,
    Secret, next_attempt_after_failure, run_retention,
};
use beergame_domain::{GameId, Instant};

const MINUTE: i64 = 60_000;
const DAY: i64 = 24 * 60 * MINUTE;

struct FixedEnv(i64);

impl Env for FixedEnv {
    fn now(&self) -> Instant {
        Instant::from_epoch_millis(self.0)
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

fn settings() -> AppSettings {
    AppSettings {
        credential_key: Secret::new(vec![5; 32]),
        key_version: 1,
        credential_ttl_millis: DAY,
        retention_days: 90,
        max_attempts: 3,
        retired_keys: Vec::new(),
        session_ttl_millis: DAY,
        max_failed_attempts: 10,
        attempt_window_millis: 10 * MINUTE,
    }
}

struct Entry {
    id: GameId,
    delete_after: i64,
    attempt: i32,
    next_attempt_at: Option<i64>,
    abandoned: bool,
}

/// 記憶上の保持と削除。`failures` の回数だけ、削除の完了が失敗する。
struct Fake {
    games: Mutex<Vec<Entry>>,
    failures: Mutex<usize>,
    erased: Mutex<Vec<GameId>>,
}

impl Fake {
    fn with(games: &[(u128, i64)], failures: usize) -> Self {
        Fake {
            games: Mutex::new(
                games
                    .iter()
                    .map(|(id, delete_after)| Entry {
                        id: GameId::new(*id),
                        delete_after: *delete_after,
                        attempt: 0,
                        next_attempt_at: None,
                        abandoned: false,
                    })
                    .collect(),
            ),
            failures: Mutex::new(failures),
            erased: Mutex::new(Vec::new()),
        }
    }

    fn erased(&self) -> Vec<GameId> {
        self.erased.lock().map(|g| g.clone()).unwrap_or_default()
    }

    fn entry<T>(&self, id: GameId, f: impl FnOnce(&Entry) -> T) -> Option<T> {
        let games = self.games.lock().ok()?;
        games.iter().find(|g| g.id == id).map(f)
    }
}

fn poisoned() -> AppFailure {
    AppFailure::Persistence(PersistenceFailure::Storage("lock".to_owned()))
}

impl RetentionStore for Fake {
    async fn due_games(
        &self,
        now: Instant,
        only: Option<&[GameId]>,
    ) -> Result<Vec<DueGame>, AppFailure> {
        let games = self.games.lock().map_err(|_| poisoned())?;
        Ok(games
            .iter()
            .filter(|g| g.delete_after <= now.epoch_millis() && !g.abandoned)
            .filter(|g| g.next_attempt_at.is_none_or(|n| n <= now.epoch_millis()))
            .filter(|g| only.is_none_or(|ids| ids.contains(&g.id)))
            .map(|g| DueGame {
                game_id: g.id,
                attempt: g.attempt,
            })
            .collect())
    }

    async fn begin_attempt(
        &self,
        game_id: GameId,
        _now: Instant,
        _lease_until: Instant,
    ) -> Result<(), AppFailure> {
        let mut games = self.games.lock().map_err(|_| poisoned())?;
        if let Some(g) = games.iter_mut().find(|g| g.id == game_id) {
            g.attempt += 1;
        }
        Ok(())
    }

    async fn erase_and_record(
        &self,
        game_id: GameId,
        receipt_digest: &str,
        _now: Instant,
        _receipt_expires_at: Instant,
    ) -> Result<(), AppFailure> {
        assert_eq!(receipt_digest.len(), 64, "受領記録はダイジェストだけ");
        assert!(
            !receipt_digest.contains(&format!("{:032x}", game_id.get())),
            "受領記録はゲームの ID を含まない"
        );
        let mut failures = self.failures.lock().map_err(|_| poisoned())?;
        if *failures > 0 {
            *failures -= 1;
            return Err(poisoned());
        }
        self.games
            .lock()
            .map_err(|_| poisoned())?
            .retain(|g| g.id != game_id);
        self.erased.lock().map_err(|_| poisoned())?.push(game_id);
        Ok(())
    }

    async fn record_failure(
        &self,
        game_id: GameId,
        _failure_code: &str,
        next_attempt_at: Option<Instant>,
    ) -> Result<(), AppFailure> {
        let mut games = self.games.lock().map_err(|_| poisoned())?;
        if let Some(g) = games.iter_mut().find(|g| g.id == game_id) {
            g.next_attempt_at = next_attempt_at.map(Instant::epoch_millis);
            g.abandoned = next_attempt_at.is_none();
        }
        Ok(())
    }

    async fn purge_receipts(&self, _now: Instant) -> Result<(), AppFailure> {
        Ok(())
    }
}

#[tokio::test]
async fn ac5_1_2__期限に達したゲームだけを削除し_期限の前や別のゲームは巻き込まない() {
    let store = Fake::with(&[(1, DAY), (2, 30 * DAY)], 0);
    let before = run_retention(&store, &FixedEnv(DAY - 1), &settings(), None).await;
    assert_eq!(before.map(|r| r.completed), Ok(0), "期限の前は何も消さない");
    let after = run_retention(&store, &FixedEnv(2 * DAY), &settings(), None).await;
    assert_eq!(after.map(|r| r.completed), Ok(1));
    assert_eq!(
        store.erased(),
        vec![GameId::new(1)],
        "期限の来ていない別のゲームは残る"
    );
    assert!(store.entry(GameId::new(2), |_| ()).is_some());
}

#[tokio::test]
async fn ac5_1_2__対象を絞ると_期限に達していても_対象の外のゲームは消さない() {
    let store = Fake::with(&[(1, DAY), (2, DAY)], 0);
    let only = [GameId::new(2)];
    let report = run_retention(&store, &FixedEnv(2 * DAY), &settings(), Some(&only)).await;
    assert_eq!(report.map(|r| r.completed), Ok(1));
    assert_eq!(store.erased(), vec![GameId::new(2)]);
}

#[tokio::test]
async fn ac5_1_3__失敗した試行は何も消さず_次の試行の時刻より前には再試行せず_時刻が来れば一度だけ削除する()
 {
    let store = Fake::with(&[(1, DAY)], 1);
    let start = 2 * DAY;
    let first = run_retention(&store, &FixedEnv(start), &settings(), None).await;
    assert_eq!(first.map(|r| r.completed), Ok(0));
    assert!(store.erased().is_empty(), "失敗した試行は消さない");
    assert_eq!(
        store.entry(GameId::new(1), |g| g.next_attempt_at),
        Some(Some(start + 10 * MINUTE)),
        "1 回目の失敗の次は 10 分後"
    );
    let early = run_retention(&store, &FixedEnv(start + MINUTE), &settings(), None).await;
    assert_eq!(early.map(|r| r.completed), Ok(0), "時刻の前は再試行しない");
    let retry = run_retention(&store, &FixedEnv(start + 10 * MINUTE), &settings(), None).await;
    assert_eq!(retry.map(|r| r.completed), Ok(1));
    let again = run_retention(&store, &FixedEnv(start + DAY), &settings(), None).await;
    assert_eq!(again.map(|r| r.completed), Ok(0), "二度目は何もしない");
    assert_eq!(store.erased().len(), 1, "最終的に一度だけ削除される");
}

#[tokio::test]
async fn ac5_1_3__上限の回数だけ失敗したら_再試行をやめ_通知する() {
    let store = Fake::with(&[(1, DAY)], 100);
    let mut now = 2 * DAY;
    let mut abandoned = 0;
    for _ in 0..(MAX_ATTEMPTS + 1) {
        let report = run_retention(&store, &FixedEnv(now), &settings(), None).await;
        abandoned += report.map_or(0, |r| r.abandoned.len());
        now += DAY;
    }
    assert_eq!(abandoned, 1, "再試行をやめたことは、一度だけ通知される");
    assert_eq!(
        store.entry(GameId::new(1), |g| (g.attempt, g.abandoned)),
        Some((MAX_ATTEMPTS, true)),
        "5 回目で打ち切り、以降は試行しない"
    );
    assert!(store.erased().is_empty());
}

#[test]
fn ac5_1_3__待ちは_10_20_40_80_分で_上限の回数なら無い() {
    let now = Instant::from_epoch_millis(0);
    let waits: Vec<Option<i64>> = (1..=MAX_ATTEMPTS)
        .map(|attempt| next_attempt_after_failure(attempt, now).map(Instant::epoch_millis))
        .collect();
    assert_eq!(
        waits,
        vec![
            Some(10 * MINUTE),
            Some(20 * MINUTE),
            Some(40 * MINUTE),
            Some(80 * MINUTE),
            None
        ]
    );
}
