// 理由: RT1 の命名（承認済み）の `__` を使うため。
#![allow(non_snake_case)]

//! `execute` の振る舞い（メモリ実装のポートで）。成功は commit だけ、競合ごとに rollback、上限で枯渇、
//! 業務の失敗と Ignored は rollback（設計: architecture-backend の RB2）。

use std::sync::Mutex;
use std::sync::atomic::{AtomicU32, Ordering};

use beergame_application::{
    AppFailure, DomainError, EventStore, PersistenceFailure, StreamRead, execute,
};
use beergame_domain::{Evolution, GameError};

/// 数え上げるメモリのイベントストア。`conflicts` 回、追記が競合する。
struct MemoryStore {
    events: Mutex<Vec<i32>>,
    conflicts: AtomicU32,
    begun: AtomicU32,
    committed: AtomicU32,
    rolled_back: AtomicU32,
}

impl MemoryStore {
    fn new(events: Vec<i32>, conflicts: u32) -> Self {
        MemoryStore {
            events: Mutex::new(events),
            conflicts: AtomicU32::new(conflicts),
            begun: AtomicU32::new(0),
            committed: AtomicU32::new(0),
            rolled_back: AtomicU32::new(0),
        }
    }

    fn counts(&self) -> (u32, u32, u32) {
        (
            self.begun.load(Ordering::SeqCst),
            self.committed.load(Ordering::SeqCst),
            self.rolled_back.load(Ordering::SeqCst),
        )
    }
}

impl EventStore<i32> for MemoryStore {
    type Tx = ();

    async fn begin(&self) -> Result<(), AppFailure> {
        self.begun.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }

    async fn read(&self, _tx: &mut ()) -> Result<StreamRead<i32>, AppFailure> {
        let events = self
            .events
            .lock()
            .map_err(|_| AppFailure::RetryExhausted)?
            .clone();
        let version = u64::try_from(events.len()).unwrap_or(0);
        Ok(StreamRead { events, version })
    }

    async fn append(&self, _tx: &mut (), expected: u64, new: Vec<i32>) -> Result<u64, AppFailure> {
        if self.conflicts.load(Ordering::SeqCst) > 0 {
            self.conflicts.fetch_sub(1, Ordering::SeqCst);
            return Err(AppFailure::ConcurrencyConflict);
        }
        let mut events = self.events.lock().map_err(|_| AppFailure::RetryExhausted)?;
        if u64::try_from(events.len()).unwrap_or(0) != expected {
            return Err(AppFailure::ConcurrencyConflict);
        }
        events.extend(new);
        Ok(u64::try_from(events.len()).unwrap_or(0))
    }

    async fn commit(&self, _tx: ()) -> Result<(), AppFailure> {
        self.committed.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }

    async fn rollback(&self, _tx: ()) -> Result<(), AppFailure> {
        self.rolled_back.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
}

/// 状態は合計。決定: 0 以下は業務の失敗、それ以外はそのイベントを 1 件。再生: 負のイベントは Ignored。
fn evolve(state: i32, event: &i32) -> Evolution<i32> {
    if *event < 0 {
        Evolution::Ignored(state)
    } else {
        Evolution::Applied(state + event)
    }
}

fn decide(_state: &i32, command: &i32) -> Result<Vec<i32>, DomainError> {
    match command {
        0 => Ok(Vec::new()),
        n if *n < 0 => Err(DomainError::Game(GameError::AlreadyCreated)),
        n => Ok(vec![*n]),
    }
}

#[tokio::test]
async fn execute__成功は_commit_だけで_rollback_しない() {
    let store = MemoryStore::new(vec![], 0);
    assert_eq!(execute(&store, &0, &evolve, &decide, &5, 3).await, Ok(1));
    assert_eq!(store.counts(), (1, 1, 0));
}

#[tokio::test]
async fn execute__競合ごとに_rollback_して再試行し_最後に_commit_する() {
    let store = MemoryStore::new(vec![], 2);
    assert_eq!(execute(&store, &0, &evolve, &decide, &5, 3).await, Ok(1));
    assert_eq!(store.counts(), (3, 1, 2));
}

#[tokio::test]
async fn execute__競合が上限まで続くと_すべて_rollback_して_RetryExhausted() {
    let store = MemoryStore::new(vec![], 9);
    assert_eq!(
        execute(&store, &0, &evolve, &decide, &5, 3).await,
        Err(AppFailure::RetryExhausted)
    );
    assert_eq!(store.counts(), (3, 0, 3));
}

#[tokio::test]
async fn execute__業務の失敗は_rollback_して_保存しない() {
    let store = MemoryStore::new(vec![], 0);
    assert_eq!(
        execute(&store, &0, &evolve, &decide, &-1, 3).await,
        Err(AppFailure::Domain(DomainError::Game(
            GameError::AlreadyCreated
        )))
    );
    assert_eq!(store.counts(), (1, 0, 1));
    assert_eq!(store.read(&mut ()).await.map(|r| r.events.len()), Ok(0));
}

#[tokio::test]
async fn execute__変化なし_空のイベント列_は追記せず_commit_する() {
    let store = MemoryStore::new(vec![3], 0);
    assert_eq!(execute(&store, &0, &evolve, &decide, &0, 3).await, Ok(1));
    assert_eq!(store.counts(), (1, 1, 0));
}

#[tokio::test]
async fn execute__保存済みの列に_Ignored_があれば_状態を信用せず失敗にして_rollback_する() {
    // 再生で decide が作らない列（負のイベント）を見つけたら、fail closed（RD2）
    let store = MemoryStore::new(vec![1, -1], 0);
    assert_eq!(
        execute(&store, &0, &evolve, &decide, &5, 3).await,
        Err(AppFailure::Persistence(PersistenceFailure::Replay {
            index: 1
        }))
    );
    assert_eq!(store.counts(), (1, 0, 1));
}
