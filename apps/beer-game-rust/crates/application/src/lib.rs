//! アプリケーション層。ポート（トレイト）とコマンド処理 `execute`。**業務ルールは持たない**（ドメインに任せる）。
//! sqlx・axum には依存しない（アダプターが実装する）。設計: architecture-backend の RB1・RB2。

use std::future::Future;

use beergame_domain::{Evolution, GameError, SessionError, StartError, ValidationError};

mod start;

pub use start::execute_start;

/// `decide` が返した業務上の失敗。
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DomainError {
    Game(GameError),
    Session(SessionError),
    Start(StartError),
}

/// 永続化の失敗（例外・I/O・再生の不整合を、境界で値にしたもの）。
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PersistenceFailure {
    /// 保存先の失敗（接続、SQL など）。
    Storage(String),
    /// 保存済みの事実を再生できない（`evolve` が `Ignored` を返した）。状態を信用せず、失敗にする（fail closed）。
    Replay { index: usize },
}

/// コマンド処理の失敗。
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AppFailure {
    /// 境界で集めた入力の誤り。
    Invalid(Vec<ValidationError>),
    /// `decide` が返した業務上の失敗。
    Domain(DomainError),
    /// 追記の競合。`execute` が再試行する。
    ConcurrencyConflict,
    /// 再試行・ロックの待ち・接続の取得の上限。コマンドは未実行（503、再送してよい）。
    RetryExhausted,
    /// 同じ `Idempotency-Key` で、別の要求が届いた（409）。
    IdempotencyKeyReused,
    /// 認証・認可の失敗（403）。
    Unauthorized,
    Persistence(PersistenceFailure),
}

/// 1 本のストリームの読み出し結果。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StreamRead<E> {
    pub events: Vec<E>,
    /// 追記した最後のイベントの通し番号（空なら 0）。楽観的並行制御の期待値。
    pub version: u64,
}

/// イベントストアのポート。`Tx` は `begin` / `commit` / `rollback` で表す。
/// 失敗の経路では `rollback` を明示し、`Tx` の drop は panic・ランタイムの終了のときの保険にする（RB2）。
pub trait EventStore<E>: Sync {
    type Tx: Send;

    fn begin(&self) -> impl Future<Output = Result<Self::Tx, AppFailure>> + Send;

    fn read(
        &self,
        tx: &mut Self::Tx,
    ) -> impl Future<Output = Result<StreamRead<E>, AppFailure>> + Send;

    /// 期待する版 `expected` に、`events` を追記し、新しい版を返す。版が違えば `ConcurrencyConflict`。
    fn append(
        &self,
        tx: &mut Self::Tx,
        expected: u64,
        events: Vec<E>,
    ) -> impl Future<Output = Result<u64, AppFailure>> + Send;

    fn commit(&self, tx: Self::Tx) -> impl Future<Output = Result<(), AppFailure>> + Send;

    fn rollback(&self, tx: Self::Tx) -> impl Future<Output = Result<(), AppFailure>> + Send;
}

/// 保存済みのイベントを畳み込む。`Ignored`（decide が作らない列）があれば、状態を信用せず失敗にする（RD2）。
pub(crate) fn replay<E, S: Clone>(
    initial: &S,
    events: &[E],
    evolve: &impl Fn(S, &E) -> Evolution<S>,
) -> Result<S, AppFailure> {
    let mut state = initial.clone();
    for (index, event) in events.iter().enumerate() {
        match evolve(state, event) {
            Evolution::Applied(next) => state = next,
            Evolution::Ignored(_) => {
                return Err(AppFailure::Persistence(PersistenceFailure::Replay {
                    index,
                }));
            }
        }
    }
    Ok(state)
}

/// 読む → 再生 → decide → 追記。失敗は `run_once` が rollback する。
async fn step<E, S, C, St>(
    store: &St,
    tx: &mut St::Tx,
    initial: &S,
    evolve: &(impl Fn(S, &E) -> Evolution<S> + Sync),
    decide: &(impl Fn(&S, &C) -> Result<Vec<E>, DomainError> + Sync),
    command: &C,
) -> Result<u64, AppFailure>
where
    E: Send,
    S: Clone + Send + Sync,
    C: Sync,
    St: EventStore<E>,
{
    let read = store.read(tx).await?;
    let state = replay(initial, &read.events, evolve)?;
    let decided = decide(&state, command).map_err(AppFailure::Domain)?;
    if decided.is_empty() {
        // 空の列は追記しない（変化なし）
        Ok(read.version)
    } else {
        store.append(tx, read.version, decided).await
    }
}

async fn run_once<E, S, C, St>(
    store: &St,
    initial: &S,
    evolve: &(impl Fn(S, &E) -> Evolution<S> + Sync),
    decide: &(impl Fn(&S, &C) -> Result<Vec<E>, DomainError> + Sync),
    command: &C,
) -> Result<u64, AppFailure>
where
    E: Send,
    S: Clone + Send + Sync,
    C: Sync,
    St: EventStore<E>,
{
    let mut tx = store.begin().await?;
    match step(store, &mut tx, initial, evolve, decide, command).await {
        Ok(version) => {
            store.commit(tx).await?;
            Ok(version)
        }
        Err(failure) => {
            // 失敗の経路は明示の ROLLBACK。ROLLBACK 自体の失敗は、元の失敗を隠さない
            drop(store.rollback(tx).await);
            Err(failure)
        }
    }
}

/// コマンドを実行する。追記の競合は、上限まで再試行する（試行のたびに rollback し、新しい `Tx` で読み直す）。
///
/// # Errors
/// 業務上の失敗、永続化の失敗、再試行の上限（`RetryExhausted`）。
pub async fn execute<E, S, C, St>(
    store: &St,
    initial: &S,
    evolve: &(impl Fn(S, &E) -> Evolution<S> + Sync),
    decide: &(impl Fn(&S, &C) -> Result<Vec<E>, DomainError> + Sync),
    command: &C,
    max_attempts: u32,
) -> Result<u64, AppFailure>
where
    E: Send,
    S: Clone + Send + Sync,
    C: Sync,
    St: EventStore<E>,
{
    let mut attempt = 0;
    loop {
        attempt += 1;
        match run_once(store, initial, evolve, decide, command).await {
            Err(AppFailure::ConcurrencyConflict) if attempt < max_attempts => {}
            Err(AppFailure::ConcurrencyConflict) => return Err(AppFailure::RetryExhausted),
            other => return other,
        }
    }
}
