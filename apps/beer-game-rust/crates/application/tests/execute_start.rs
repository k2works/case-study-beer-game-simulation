// 理由: RT1 の命名（承認済み）の `__` を使うため。
#![allow(non_snake_case)]

//! `execute_start`: 2 本のストリームへ 1 つのトランザクションで追記する（原子性）。AC1.2.3。

use std::sync::Mutex;
use std::sync::atomic::{AtomicU32, Ordering};

use beergame_application::{AppFailure, DomainError, EventStore, StreamRead, execute_start};
use beergame_domain::{
    Actor, CommitMode, GameError, GameEvent, GameId, GameSettings, Instant, JoinCode,
    ParticipantId, RetentionDays, Role, SessionEvent, StartError, StartGame,
};

const GAME: GameId = GameId::new(1);

fn e<T: std::fmt::Debug>(x: T) -> String {
    format!("{x:?}")
}

/// 未コミットの追記を `Tx` に持つメモリのストア。commit で反映し、rollback で捨てる。
#[derive(Default)]
struct Pending {
    game: Vec<GameEvent>,
    session: Vec<SessionEvent>,
}

struct MemoryStore {
    game: Mutex<Vec<GameEvent>>,
    session: Mutex<Vec<SessionEvent>>,
    game_conflicts: AtomicU32,
    session_fails: bool,
    begun: AtomicU32,
    committed: AtomicU32,
    rolled_back: AtomicU32,
}

impl MemoryStore {
    fn new(game: Vec<GameEvent>) -> Self {
        MemoryStore {
            game: Mutex::new(game),
            session: Mutex::new(Vec::new()),
            game_conflicts: AtomicU32::new(0),
            session_fails: false,
            begun: AtomicU32::new(0),
            committed: AtomicU32::new(0),
            rolled_back: AtomicU32::new(0),
        }
    }

    fn lens(&self) -> (usize, usize) {
        (
            self.game.lock().map_or(0, |g| g.len()),
            self.session.lock().map_or(0, |s| s.len()),
        )
    }
}

fn len64(n: usize) -> u64 {
    u64::try_from(n).unwrap_or(0)
}

impl EventStore<GameEvent> for MemoryStore {
    type Tx = Pending;

    async fn begin(&self) -> Result<Pending, AppFailure> {
        self.begun.fetch_add(1, Ordering::SeqCst);
        Ok(Pending::default())
    }

    async fn read(&self, _tx: &mut Pending) -> Result<StreamRead<GameEvent>, AppFailure> {
        let events = self
            .game
            .lock()
            .map_err(|_| AppFailure::RetryExhausted)?
            .clone();
        Ok(StreamRead {
            version: len64(events.len()),
            events,
        })
    }

    async fn append(
        &self,
        tx: &mut Pending,
        expected: u64,
        events: Vec<GameEvent>,
    ) -> Result<u64, AppFailure> {
        if self.game_conflicts.load(Ordering::SeqCst) > 0 {
            self.game_conflicts.fetch_sub(1, Ordering::SeqCst);
            return Err(AppFailure::ConcurrencyConflict);
        }
        let n = len64(
            self.game
                .lock()
                .map_err(|_| AppFailure::RetryExhausted)?
                .len(),
        );
        if n != expected {
            return Err(AppFailure::ConcurrencyConflict);
        }
        tx.game.extend(events);
        Ok(n + len64(tx.game.len()))
    }

    async fn commit(&self, tx: Pending) -> Result<(), AppFailure> {
        self.committed.fetch_add(1, Ordering::SeqCst);
        self.game
            .lock()
            .map_err(|_| AppFailure::RetryExhausted)?
            .extend(tx.game);
        self.session
            .lock()
            .map_err(|_| AppFailure::RetryExhausted)?
            .extend(tx.session);
        Ok(())
    }

    async fn rollback(&self, _tx: Pending) -> Result<(), AppFailure> {
        self.rolled_back.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
}

impl EventStore<SessionEvent> for MemoryStore {
    type Tx = Pending;

    async fn begin(&self) -> Result<Pending, AppFailure> {
        Ok(Pending::default())
    }

    async fn read(&self, _tx: &mut Pending) -> Result<StreamRead<SessionEvent>, AppFailure> {
        let events = self
            .session
            .lock()
            .map_err(|_| AppFailure::RetryExhausted)?
            .clone();
        Ok(StreamRead {
            version: len64(events.len()),
            events,
        })
    }

    async fn append(
        &self,
        tx: &mut Pending,
        _expected: u64,
        events: Vec<SessionEvent>,
    ) -> Result<u64, AppFailure> {
        if self.session_fails {
            return Err(AppFailure::ConcurrencyConflict);
        }
        tx.session.extend(events);
        Ok(len64(tx.session.len()))
    }

    async fn commit(&self, _tx: Pending) -> Result<(), AppFailure> {
        Ok(())
    }

    async fn rollback(&self, _tx: Pending) -> Result<(), AppFailure> {
        Ok(())
    }
}

fn created() -> Result<GameEvent, String> {
    Ok(GameEvent::GameCreated {
        game_id: GAME,
        join_code: JoinCode::of("abcd1234").map_err(e)?,
        settings: GameSettings::kit(2, &[4, 4], CommitMode::Manual).map_err(e)?,
        retention_days: RetentionDays::of(30).map_err(e)?,
        facilitator_credential_expires_at: Instant::from_epoch_millis(9),
    })
}

/// 4 役割に 1 人ずつ割り当てたゲームのイベント。`roles` の分だけ割り当てる。
fn game_events(roles: &[Role]) -> Result<Vec<GameEvent>, String> {
    let mut events = vec![created()?];
    for (i, role) in roles.iter().enumerate() {
        let id = ParticipantId::new(u128::try_from(i + 1).map_err(e)?);
        events.push(GameEvent::ParticipantJoined {
            participant_id: id,
            credential_expires_at: Instant::from_epoch_millis(9),
        });
        events.push(GameEvent::RoleAssigned {
            participant_id: id,
            role: *role,
        });
    }
    Ok(events)
}

fn command() -> StartGame {
    StartGame {
        actor: Actor::Facilitator(GAME),
        at: Instant::from_epoch_millis(1),
    }
}

#[tokio::test]
async fn ac1_2_3__開始は_game_と_session_の両方へ_1_回のコミットで追記する() -> Result<(), String> {
    let store = MemoryStore::new(game_events(&Role::ALL)?);
    let before = store.lens().0;
    assert_eq!(
        execute_start(&store, &command(), 3).await,
        Ok((u64::try_from(before + 1).map_err(e)?, 1))
    );
    assert_eq!(store.lens(), (before + 1, 1));
    assert_eq!(store.committed.load(Ordering::SeqCst), 1);
    Ok(())
}

#[tokio::test]
async fn ac1_2_3__役割が足りなければ_どちらにも追記せず_rollback_する() -> Result<(), String> {
    let store = MemoryStore::new(game_events(&[Role::Factory, Role::Retailer])?);
    let before = store.lens();
    assert_eq!(
        execute_start(&store, &command(), 3).await,
        Err(AppFailure::Domain(DomainError::Start(StartError::Game(
            GameError::StartConditionNotMet(vec![Role::Distributor, Role::Wholesaler])
        ))))
    );
    assert_eq!(store.lens(), before);
    assert_eq!(store.rolled_back.load(Ordering::SeqCst), 1);
    Ok(())
}

#[tokio::test]
async fn ac1_2_3__game_の追記が競合したら_再試行して_最後に_commit_する() -> Result<(), String> {
    let store = MemoryStore::new(game_events(&Role::ALL)?);
    store.game_conflicts.store(2, Ordering::SeqCst);
    assert!(execute_start(&store, &command(), 3).await.is_ok());
    assert_eq!(store.begun.load(Ordering::SeqCst), 3);
    assert_eq!(store.rolled_back.load(Ordering::SeqCst), 2);
    assert_eq!(store.committed.load(Ordering::SeqCst), 1);
    Ok(())
}

#[tokio::test]
async fn ac1_2_3__session_の追記が失敗したら_game_への追記も残さない_原子性() -> Result<(), String>
{
    let mut store = MemoryStore::new(game_events(&Role::ALL)?);
    store.session_fails = true;
    let before = store.lens();
    assert_eq!(
        execute_start(&store, &command(), 2).await,
        Err(AppFailure::RetryExhausted)
    );
    assert_eq!(store.lens(), before);
    assert_eq!(store.committed.load(Ordering::SeqCst), 0);
    Ok(())
}

#[tokio::test]
async fn ac1_2_3__開始済みのゲームは_再開始できない() -> Result<(), String> {
    let store = MemoryStore::new(game_events(&Role::ALL)?);
    assert!(execute_start(&store, &command(), 3).await.is_ok());
    assert_eq!(
        execute_start(&store, &command(), 3).await,
        Err(AppFailure::Domain(DomainError::Start(StartError::Session(
            beergame_domain::SessionError::AlreadyStarted
        ))))
    );
    Ok(())
}
