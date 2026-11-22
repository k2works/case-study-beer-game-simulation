//! アプリケーション層。ポート（トレイト）とコマンド処理 `execute`。**業務ルールは持たない**（ドメインに任せる）。
//! sqlx・axum には依存しない（アダプターが実装する）。設計: architecture-backend の RB1・RB2。

use std::future::Future;

use beergame_domain::{
    Evolution, GameError, GameId, Instant, ParticipantId, SessionError, StartError, ValidationError,
};

mod commands;
mod idempotency;
mod seal;
mod sealed_replay;
mod secret;
mod snapshot;
mod start;

pub use commands::{
    AppSettings, CreateGameInput, CreateOutcome, CredentialLookup, CredentialRecord, Env,
    JoinOutcome, RecoverOutcome, ReissueOutcome, SessionWriter, assign_or_replace_role,
    assign_role, authenticate, commit_week, create_game, join_game, pause_session, recover,
    reissue_credential, resume_session, revoke_credential, save_decision, start_game,
    submit_proxy_decision,
};
pub use idempotency::{Executed, Idempotency, ResponseShape, StoredResponse};
pub use seal::{open, seal};
pub use sealed_replay::{SealedFields, SealedIdempotency, open_sealed, sealed_write};
pub use secret::{Secret, digest, encode_token};
pub use snapshot::{
    CoHolderRow, EditorSnapshot, GameSnapshot, LobbyParticipantRow, ResultRow, RoleSnapshot,
    SessionSnapshot,
};
pub use start::{BothDecision, StartExecuted, execute_both, execute_start};

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

/// 資格の種類。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CredentialKind {
    Facilitator,
    Participant,
}

/// 周辺ストアへの書き込み（イベントには入れない値。D7）。内容は純粋に導出し、追記と同じトランザクションで書く。
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PeripheralWrite {
    /// 資格のダイジェスト（生の値は含めない）。
    Credential {
        digest: String,
        game_id: GameId,
        kind: CredentialKind,
        subject_id: u128,
        key_version: i32,
        issued_at: Instant,
        expires_at: Instant,
    },
    /// 冪等記録（成功した応答。秘密を含まないものに限る）。
    Idempotency {
        game_id: GameId,
        scope: String,
        key_digest: String,
        request_digest: String,
        status_code: u16,
        response: Vec<u8>,
        expires_at: Instant,
    },
    /// ブラウザセッションのダイジェスト（生の値は含めない）。復帰資格とは別のダイジェストで持つ。
    BrowserSession {
        digest: String,
        game_id: GameId,
        kind: CredentialKind,
        subject_id: u128,
        key_version: i32,
        expires_at: Instant,
    },
    /// 対象の資格（復帰資格）を失効させ、発行済みのブラウザセッションを使えなくする。
    RevokeCredentials { game_id: GameId, subject_id: u128 },
    /// 表示名（参加者のみ）。
    DisplayName {
        game_id: GameId,
        participant_id: ParticipantId,
        name: String,
        at: Instant,
    },
}

/// `decide` の結果。追記するイベントと、同じトランザクションで書く周辺ストアの内容。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Decision<E> {
    pub events: Vec<E>,
    pub writes: Vec<PeripheralWrite>,
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

    /// 冪等記録を引く（同じトランザクション）。既定は記録なし。
    fn find_idempotency(
        &self,
        _tx: &mut Self::Tx,
        _game_id: GameId,
        _scope: &str,
        _key_digest: &str,
    ) -> impl Future<Output = Result<Option<StoredResponse>, AppFailure>> + Send {
        async { Ok(None) }
    }

    /// 周辺ストアへ書く（追記と同じトランザクション）。既定は何もしない。
    fn write_peripheral(
        &self,
        _tx: &mut Self::Tx,
        _writes: &[PeripheralWrite],
    ) -> impl Future<Output = Result<(), AppFailure>> + Send {
        async { Ok(()) }
    }
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
    decide: &(impl Fn(&S, &C) -> Result<Decision<E>, DomainError> + Sync),
    command: &C,
    idem: Option<&Idempotency>,
) -> Result<Executed, AppFailure>
where
    E: Send,
    S: Clone + Send + Sync,
    C: Sync,
    St: EventStore<E>,
{
    // 冪等記録の照合は、読み込みの前（認証・認可は、この関数の前に済んでいる）
    if let Some(idem) = idem
        && let Some(stored) = store
            .find_idempotency(tx, idem.game_id, &idem.scope, &idem.key_digest)
            .await?
    {
        return if stored.request_digest == idem.request_digest {
            Ok(Executed::Replayed(stored))
        } else {
            Err(AppFailure::IdempotencyKeyReused)
        };
    }
    let read = store.read(tx).await?;
    let state = replay(initial, &read.events, evolve)?;
    let decided = decide(&state, command).map_err(AppFailure::Domain)?;
    let version = if decided.events.is_empty() {
        // 空の列は追記しない（変化なし）
        read.version
    } else {
        let version = store.append(tx, read.version, decided.events).await?;
        store.write_peripheral(tx, &decided.writes).await?;
        version
    };
    if let Some(idem) = idem {
        let record = PeripheralWrite::Idempotency {
            game_id: idem.game_id,
            scope: idem.scope.clone(),
            key_digest: idem.key_digest.clone(),
            request_digest: idem.request_digest.clone(),
            status_code: 200,
            response: idem.shape.body(version),
            expires_at: idem.expires_at,
        };
        store.write_peripheral(tx, &[record]).await?;
    }
    Ok(Executed::Fresh(version))
}

async fn run_once<E, S, C, St>(
    store: &St,
    initial: &S,
    evolve: &(impl Fn(S, &E) -> Evolution<S> + Sync),
    decide: &(impl Fn(&S, &C) -> Result<Decision<E>, DomainError> + Sync),
    command: &C,
    idem: Option<&Idempotency>,
) -> Result<Executed, AppFailure>
where
    E: Send,
    S: Clone + Send + Sync,
    C: Sync,
    St: EventStore<E>,
{
    let mut tx = store.begin().await?;
    match step(store, &mut tx, initial, evolve, decide, command, idem).await {
        Ok(Executed::Fresh(version)) => {
            store.commit(tx).await?;
            Ok(Executed::Fresh(version))
        }
        Ok(replayed @ Executed::Replayed(_)) => {
            // 何も書いていない（読み取りだけ）
            drop(store.rollback(tx).await);
            Ok(replayed)
        }
        Err(failure) => {
            // 失敗の経路は明示の ROLLBACK。ROLLBACK 自体の失敗は、元の失敗を隠さない
            drop(store.rollback(tx).await);
            Err(failure)
        }
    }
}

/// コマンドを実行する（周辺ストアへの書き込みを伴う）。追記の競合は、上限まで再試行する（試行のたびに rollback し、新しい `Tx` で読み直す）。
///
/// # Errors
/// 業務上の失敗、永続化の失敗、再試行の上限（`RetryExhausted`）。
pub async fn execute_decision<E, S, C, St>(
    store: &St,
    initial: &S,
    evolve: &(impl Fn(S, &E) -> Evolution<S> + Sync),
    decide: &(impl Fn(&S, &C) -> Result<Decision<E>, DomainError> + Sync),
    command: &C,
    max_attempts: u32,
) -> Result<u64, AppFailure>
where
    E: Send,
    S: Clone + Send + Sync,
    C: Sync,
    St: EventStore<E>,
{
    match execute_idempotent(store, initial, evolve, decide, command, max_attempts, None).await? {
        Executed::Fresh(version) => Ok(version),
        // 冪等性を指定していないので、再送の応答は返らない
        Executed::Replayed(_) => Err(AppFailure::Persistence(PersistenceFailure::Storage(
            "想定外の冪等記録".to_owned(),
        ))),
    }
}

/// 冪等性つきでコマンドを実行する。同じキー・同じ内容の再送は、保存した応答を返す（`Replayed`）。
///
/// # Errors
/// `execute_decision` と同じ。同じキーで内容が違えば `IdempotencyKeyReused`。
pub async fn execute_idempotent<E, S, C, St>(
    store: &St,
    initial: &S,
    evolve: &(impl Fn(S, &E) -> Evolution<S> + Sync),
    decide: &(impl Fn(&S, &C) -> Result<Decision<E>, DomainError> + Sync),
    command: &C,
    max_attempts: u32,
    idem: Option<&Idempotency>,
) -> Result<Executed, AppFailure>
where
    E: Send,
    S: Clone + Send + Sync,
    C: Sync,
    St: EventStore<E>,
{
    let mut attempt = 0;
    loop {
        attempt += 1;
        match run_once(store, initial, evolve, decide, command, idem).await {
            Err(AppFailure::ConcurrencyConflict) if attempt < max_attempts => {}
            Err(AppFailure::ConcurrencyConflict) => return Err(AppFailure::RetryExhausted),
            other => return other,
        }
    }
}

/// 周辺ストアへの書き込みを伴わないコマンドを実行する。
///
/// # Errors
/// `execute_decision` と同じ。
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
    execute_decision(
        store,
        initial,
        evolve,
        &|state, cmd| {
            decide(state, cmd).map(|events| Decision {
                events,
                writes: Vec::new(),
            })
        },
        command,
        max_attempts,
    )
    .await
}
