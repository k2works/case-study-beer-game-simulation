//! ゲームの開始（`start_game`）。`game` と `session` の 2 本のストリームを読み、**1 つのトランザクション**で両方へ追記する。
//! どちらかの追記が競合・失敗すれば、両方を rollback する（原子性）。

use beergame_domain::{
    GameEvent, GameState, SessionEvent, SessionState, StartGame, evolve_game, evolve_session,
    start_game,
};

use crate::{AppFailure, DomainError, EventStore, replay};

/// 開始を実行し、両ストリームの新しい版 `(game, session)` を返す。追記の競合は上限まで再試行する。
///
/// # Errors
/// 業務上の失敗（`DomainError::Start`）、永続化の失敗、再試行の上限（`RetryExhausted`）。
pub async fn execute_start<St>(
    store: &St,
    command: &StartGame,
    max_attempts: u32,
) -> Result<(u64, u64), AppFailure>
where
    St: EventStore<GameEvent> + EventStore<SessionEvent, Tx = <St as EventStore<GameEvent>>::Tx>,
{
    let mut attempt = 0;
    loop {
        attempt += 1;
        match run_once(store, command).await {
            Err(AppFailure::ConcurrencyConflict) if attempt < max_attempts => {}
            Err(AppFailure::ConcurrencyConflict) => return Err(AppFailure::RetryExhausted),
            other => return other,
        }
    }
}

async fn run_once<St>(store: &St, command: &StartGame) -> Result<(u64, u64), AppFailure>
where
    St: EventStore<GameEvent> + EventStore<SessionEvent, Tx = <St as EventStore<GameEvent>>::Tx>,
{
    let mut tx = <St as EventStore<GameEvent>>::begin(store).await?;
    match step(store, &mut tx, command).await {
        Ok(versions) => {
            <St as EventStore<GameEvent>>::commit(store, tx).await?;
            Ok(versions)
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
    command: &StartGame,
) -> Result<(u64, u64), AppFailure>
where
    St: EventStore<GameEvent> + EventStore<SessionEvent, Tx = <St as EventStore<GameEvent>>::Tx>,
{
    let game_read = <St as EventStore<GameEvent>>::read(store, tx).await?;
    let session_read = <St as EventStore<SessionEvent>>::read(store, tx).await?;
    let game = replay(&GameState::NotCreated, &game_read.events, &evolve_game)?;
    let session = replay(
        &SessionState::NotStarted,
        &session_read.events,
        &evolve_session,
    )?;
    let decision = start_game(&game, &session, command)
        .map_err(|e| AppFailure::Domain(DomainError::Start(e)))?;
    let game_version =
        <St as EventStore<GameEvent>>::append(store, tx, game_read.version, decision.game).await?;
    let session_version =
        <St as EventStore<SessionEvent>>::append(store, tx, session_read.version, decision.session)
            .await?;
    Ok((game_version, session_version))
}
