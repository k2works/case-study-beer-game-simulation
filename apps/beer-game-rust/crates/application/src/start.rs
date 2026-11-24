//! ゲームの開始（`start_game`）。`game` と `session` の 2 本のストリームを読み、**1 つのトランザクション**で両方へ追記する。
//! どちらかの追記が競合・失敗すれば、両方を rollback する（原子性）。

use beergame_domain::{
    GameEvent, GameState, SessionEvent, SessionState, StartGame, evolve_game, evolve_session,
    start_game,
};

use crate::{
    AppFailure, DomainError, EventStore, Idempotency, PeripheralWrite, ResponseShape,
    StoredResponse, replay,
};

/// 開始の結果。
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum StartExecuted {
    /// 実行した。両ストリームの追記後の版。
    Fresh(u64, u64),
    /// 実行した。`game` ストリームだけへ追記した（`session` は変わらない）。追記後の版。
    FreshGame(u64),
    /// 同じキー・同じ内容の再送。保存した応答を返す。
    Replayed(StoredResponse),
}

/// 開始を実行し、両ストリームの新しい版 `(game, session)` を返す。追記の競合は上限まで再試行する。
///
/// # Errors
/// 業務上の失敗（`DomainError::Start`）、永続化の失敗、再試行の上限（`RetryExhausted`）。
pub async fn execute_start<St>(
    store: &St,
    command: &StartGame,
    max_attempts: u32,
    idem: Option<&Idempotency>,
) -> Result<StartExecuted, AppFailure>
where
    St: EventStore<GameEvent> + EventStore<SessionEvent, Tx = <St as EventStore<GameEvent>>::Tx>,
{
    execute_both(
        store,
        &|game, session| {
            start_game(game, session, command)
                .map(|decision| BothDecision {
                    game: decision.game,
                    session: decision.session,
                    writes: Vec::new(),
                })
                .map_err(|e| AppFailure::Domain(DomainError::Start(e)))
        },
        max_attempts,
        idem,
    )
    .await
}

/// 2 本のストリームを読んで決め、1 つのトランザクションで両方へ追記する判断の結果。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BothDecision {
    pub game: Vec<GameEvent>,
    pub session: Vec<SessionEvent>,
    /// 同じトランザクションで書く周辺ストアの内容。
    pub writes: Vec<PeripheralWrite>,
}

/// 2 本のストリームにまたがる判断（開始・開始後の役割の入れ替え）を実行する。`session` へ追記するイベントが空なら、
/// 応答の版は `game` だけ（`FreshGame`）。追記の競合は上限まで再試行する。
///
/// # Errors
/// 業務上の失敗、永続化の失敗、再試行の上限（`RetryExhausted`）。
pub async fn execute_both<St>(
    store: &St,
    decide: &(dyn Fn(&GameState, &SessionState) -> Result<BothDecision, AppFailure> + Sync),
    max_attempts: u32,
    idem: Option<&Idempotency>,
) -> Result<StartExecuted, AppFailure>
where
    St: EventStore<GameEvent> + EventStore<SessionEvent, Tx = <St as EventStore<GameEvent>>::Tx>,
{
    let mut attempt = 0;
    loop {
        attempt += 1;
        match run_once(store, decide, idem).await {
            Err(AppFailure::ConcurrencyConflict) if attempt < max_attempts => {}
            Err(AppFailure::ConcurrencyConflict) => return Err(AppFailure::RetryExhausted),
            other => return other,
        }
    }
}

async fn run_once<St>(
    store: &St,
    decide: &(dyn Fn(&GameState, &SessionState) -> Result<BothDecision, AppFailure> + Sync),
    idem: Option<&Idempotency>,
) -> Result<StartExecuted, AppFailure>
where
    St: EventStore<GameEvent> + EventStore<SessionEvent, Tx = <St as EventStore<GameEvent>>::Tx>,
{
    let mut tx = <St as EventStore<GameEvent>>::begin(store).await?;
    match step(store, &mut tx, decide, idem).await {
        Ok(fresh @ (StartExecuted::Fresh(..) | StartExecuted::FreshGame(_))) => {
            <St as EventStore<GameEvent>>::commit(store, tx).await?;
            Ok(fresh)
        }
        Ok(replayed @ StartExecuted::Replayed(_)) => {
            drop(<St as EventStore<GameEvent>>::rollback(store, tx).await);
            Ok(replayed)
        }
        Err(failure) => {
            drop(<St as EventStore<GameEvent>>::rollback(store, tx).await);
            Err(failure)
        }
    }
}

async fn step<St>(
    store: &St,
    tx: &mut <St as EventStore<GameEvent>>::Tx,
    decide: &(dyn Fn(&GameState, &SessionState) -> Result<BothDecision, AppFailure> + Sync),
    idem: Option<&Idempotency>,
) -> Result<StartExecuted, AppFailure>
where
    St: EventStore<GameEvent> + EventStore<SessionEvent, Tx = <St as EventStore<GameEvent>>::Tx>,
{
    if let Some(idem) = idem
        && let Some(stored) = <St as EventStore<GameEvent>>::find_idempotency(
            store,
            tx,
            idem.game_id,
            &idem.scope,
            &idem.key_digest,
        )
        .await?
    {
        return if stored.request_digest == idem.request_digest {
            Ok(StartExecuted::Replayed(stored))
        } else {
            Err(AppFailure::IdempotencyKeyReused)
        };
    }
    let game_read = <St as EventStore<GameEvent>>::read(store, tx).await?;
    let session_read = <St as EventStore<SessionEvent>>::read(store, tx).await?;
    let game = replay(&GameState::NotCreated, &game_read.events, &evolve_game)?;
    let session = replay(
        &SessionState::NotStarted,
        &session_read.events,
        &evolve_session,
    )?;
    let decision = decide(&game, &session)?;
    let game_version =
        <St as EventStore<GameEvent>>::append(store, tx, game_read.version, decision.game).await?;
    let game_only = decision.session.is_empty();
    let session_version = if game_only {
        session_read.version
    } else {
        <St as EventStore<SessionEvent>>::append(store, tx, session_read.version, decision.session)
            .await?
    };
    let mut writes = decision.writes;
    if let Some(idem) = idem {
        writes.push(PeripheralWrite::Idempotency {
            game_id: idem.game_id,
            scope: idem.scope.clone(),
            key_digest: idem.key_digest.clone(),
            request_digest: idem.request_digest.clone(),
            status_code: 200,
            response: if game_only {
                ResponseShape::Game.body(game_version)
            } else {
                ResponseShape::body_both(game_version, session_version)
            },
            expires_at: idem.expires_at,
        });
    }
    if !writes.is_empty() {
        <St as EventStore<GameEvent>>::write_peripheral(store, tx, &writes).await?;
    }
    Ok(if game_only {
        StartExecuted::FreshGame(game_version)
    } else {
        StartExecuted::Fresh(game_version, session_version)
    })
}
