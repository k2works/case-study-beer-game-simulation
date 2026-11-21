//! PostgreSQL のイベントストア。追記専用。楽観的並行制御は `uq_events_stream_version` の違反で検出する。

use std::marker::PhantomData;

use beergame_application::{
    AppFailure, EventStore, PeripheralWrite, PersistenceFailure, StreamRead,
};
use beergame_domain::{GameEvent, SessionEvent};

use crate::codec::{GameCodec, SessionCodec};
use crate::projection::{Bind, Statement, peripheral_statements};
use sqlx::postgres::PgPool;
use sqlx::{Postgres, Row, Transaction};
use uuid::Uuid;

/// ストリームの種類。1 ゲームにつき `GAME` と `SESSION` の 2 本。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StreamType {
    Game,
    Session,
}

impl StreamType {
    const fn as_str(self) -> &'static str {
        match self {
            StreamType::Game => "GAME",
            StreamType::Session => "SESSION",
        }
    }
}

/// イベントと JSON の変換（`event_type`・`schema_version`・`payload`）。
pub trait EventCodec<E>: Sync {
    /// # Errors
    /// 変換できないとき。
    fn encode(&self, event: &E) -> Result<(String, i32, serde_json::Value), String>;

    /// # Errors
    /// 不明な `event_type`・不正な `payload` のとき。
    fn decode(
        &self,
        event_type: &str,
        schema_version: i32,
        payload: serde_json::Value,
    ) -> Result<E, String>;

    /// イベントが書く投影（追記と同じトランザクションで実行する）。既定は投影なし。
    fn projection(&self, _game_id: Uuid, _event: &E) -> Vec<Statement> {
        Vec::new()
    }
}

async fn run_statement(tx: &mut PgTx, statement: &Statement) -> Result<(), AppFailure> {
    let mut query = sqlx::query(statement.sql);
    for bind in &statement.binds {
        query = match bind {
            Bind::Uuid(v) => query.bind(*v),
            Bind::Text(v) => query.bind(v.clone()),
            Bind::Int(v) => query.bind(*v),
            Bind::Json(v) => query.bind(v.clone()),
            Bind::NullText => query.bind(None::<String>),
        };
    }
    query
        .execute(&mut *tx.0)
        .await
        .map(|_| ())
        .map_err(|e| storage(&e))
}

/// 実行中のトランザクション。明示の `commit` / `rollback` で終える。drop は保険（RB2）。
pub struct PgTx(Transaction<'static, Postgres>);

/// 1 本のストリーム `(game_id, stream_type)` のイベントストア。
pub struct PgEventStore<E, C> {
    pool: PgPool,
    game_id: Uuid,
    stream: StreamType,
    codec: C,
    _event: PhantomData<fn() -> E>,
}

impl<E, C> PgEventStore<E, C> {
    #[must_use]
    pub fn new(pool: PgPool, game_id: Uuid, stream: StreamType, codec: C) -> Self {
        PgEventStore {
            pool,
            game_id,
            stream,
            codec,
            _event: PhantomData,
        }
    }
}

/// マイグレーションを適用する。
///
/// # Errors
/// 適用に失敗したとき。
pub async fn migrate(pool: &PgPool) -> Result<(), sqlx::migrate::MigrateError> {
    sqlx::migrate!("./migrations").run(pool).await
}

fn storage(e: &sqlx::Error) -> AppFailure {
    AppFailure::Persistence(PersistenceFailure::Storage(e.to_string()))
}

/// 追記の失敗を写す。`uq_events_stream_version` の違反は競合（再試行する）、それ以外は永続化の失敗。
fn append_failure(e: &sqlx::Error) -> AppFailure {
    if let sqlx::Error::Database(db) = e
        && db.code().as_deref() == Some("23505")
        && db.constraint() == Some("uq_events_stream_version")
    {
        AppFailure::ConcurrencyConflict
    } else {
        storage(e)
    }
}

impl<E, C> EventStore<E> for PgEventStore<E, C>
where
    E: Send + Sync,
    C: EventCodec<E>,
{
    type Tx = PgTx;

    async fn begin(&self) -> Result<PgTx, AppFailure> {
        match self.pool.begin().await {
            Ok(tx) => Ok(PgTx(tx)),
            // 接続を取れなかった（コマンドは未実行）。再送してよい失敗に写す
            Err(sqlx::Error::PoolTimedOut | sqlx::Error::PoolClosed) => {
                Err(AppFailure::RetryExhausted)
            }
            Err(e) => Err(storage(&e)),
        }
    }

    async fn read(&self, tx: &mut PgTx) -> Result<StreamRead<E>, AppFailure> {
        let rows = sqlx::query(
            "SELECT stream_version, event_type, schema_version, payload FROM events \
             WHERE game_id = $1 AND stream_type = $2 ORDER BY stream_version",
        )
        .bind(self.game_id)
        .bind(self.stream.as_str())
        .fetch_all(&mut *tx.0)
        .await
        .map_err(|e| storage(&e))?;
        let mut events = Vec::with_capacity(rows.len());
        let mut version = 0_i64;
        for row in rows {
            let event_type: String = row.try_get("event_type").map_err(|e| storage(&e))?;
            let schema_version: i32 = row.try_get("schema_version").map_err(|e| storage(&e))?;
            let payload: serde_json::Value = row.try_get("payload").map_err(|e| storage(&e))?;
            version = row.try_get("stream_version").map_err(|e| storage(&e))?;
            events.push(
                self.codec
                    .decode(&event_type, schema_version, payload)
                    .map_err(|m| AppFailure::Persistence(PersistenceFailure::Storage(m)))?,
            );
        }
        Ok(StreamRead {
            events,
            version: u64::try_from(version).unwrap_or(0),
        })
    }

    async fn append(
        &self,
        tx: &mut PgTx,
        expected: u64,
        events: Vec<E>,
    ) -> Result<u64, AppFailure> {
        let mut version = i64::try_from(expected).map_err(|_| AppFailure::RetryExhausted)?;
        if expected == 0 && self.stream == StreamType::Game {
            // 連鎖削除の根。ゲームの最初の追記（作成）で作る（同じ ID の再作成は decide が拒否する）
            sqlx::query("INSERT INTO game_roots (game_id, created_at) VALUES ($1, now()) ON CONFLICT DO NOTHING")
                .bind(self.game_id)
                .execute(&mut *tx.0)
                .await
                .map_err(|e| storage(&e))?;
        }
        for event in &events {
            let (event_type, schema_version, payload) = self
                .codec
                .encode(event)
                .map_err(|m| AppFailure::Persistence(PersistenceFailure::Storage(m)))?;
            version = version.saturating_add(1);
            sqlx::query(
                "INSERT INTO events (event_id, game_id, stream_type, stream_version, event_type, \
                 schema_version, payload, actor_kind, actor_id, correlation_id, command_id, occurred_at) \
                 VALUES ($1, $2, $3, $4, $5, $6, $7, 'ANONYMOUS', NULL, $1, $1, now())",
            )
            .bind(Uuid::new_v4())
            .bind(self.game_id)
            .bind(self.stream.as_str())
            .bind(version)
            .bind(event_type)
            .bind(schema_version)
            .bind(payload)
            .execute(&mut *tx.0)
            .await
            .map_err(|e| append_failure(&e))?;
            for statement in self.codec.projection(self.game_id, event) {
                run_statement(tx, &statement).await?;
            }
        }
        Ok(u64::try_from(version).unwrap_or(0))
    }

    async fn write_peripheral(
        &self,
        tx: &mut PgTx,
        writes: &[PeripheralWrite],
    ) -> Result<(), AppFailure> {
        for write in writes {
            run_statement(tx, &peripheral_statements(write)).await?;
        }
        Ok(())
    }

    async fn commit(&self, tx: PgTx) -> Result<(), AppFailure> {
        tx.0.commit().await.map_err(|e| storage(&e))
    }

    async fn rollback(&self, tx: PgTx) -> Result<(), AppFailure> {
        tx.0.rollback().await.map_err(|e| storage(&e))
    }
}

/// 1 ゲームの `game` と `session` の 2 本のストリーム。`Tx` を共有するので、`start_game` が 1 つのトランザクションで両方へ追記できる。
pub struct PgGameStore {
    game: PgEventStore<GameEvent, GameCodec>,
    session: PgEventStore<SessionEvent, SessionCodec>,
}

impl PgGameStore {
    #[must_use]
    pub fn new(pool: PgPool, game_id: Uuid) -> Self {
        PgGameStore {
            game: PgEventStore::new(pool.clone(), game_id, StreamType::Game, GameCodec),
            session: PgEventStore::new(pool, game_id, StreamType::Session, SessionCodec),
        }
    }
}

impl EventStore<GameEvent> for PgGameStore {
    type Tx = PgTx;

    async fn begin(&self) -> Result<PgTx, AppFailure> {
        EventStore::<GameEvent>::begin(&self.game).await
    }

    async fn read(&self, tx: &mut PgTx) -> Result<StreamRead<GameEvent>, AppFailure> {
        self.game.read(tx).await
    }

    async fn append(
        &self,
        tx: &mut PgTx,
        expected: u64,
        events: Vec<GameEvent>,
    ) -> Result<u64, AppFailure> {
        self.game.append(tx, expected, events).await
    }

    async fn commit(&self, tx: PgTx) -> Result<(), AppFailure> {
        EventStore::<GameEvent>::commit(&self.game, tx).await
    }

    async fn rollback(&self, tx: PgTx) -> Result<(), AppFailure> {
        EventStore::<GameEvent>::rollback(&self.game, tx).await
    }

    async fn write_peripheral(
        &self,
        tx: &mut PgTx,
        writes: &[PeripheralWrite],
    ) -> Result<(), AppFailure> {
        EventStore::<GameEvent>::write_peripheral(&self.game, tx, writes).await
    }
}

impl EventStore<SessionEvent> for PgGameStore {
    type Tx = PgTx;

    async fn begin(&self) -> Result<PgTx, AppFailure> {
        EventStore::<SessionEvent>::begin(&self.session).await
    }

    async fn read(&self, tx: &mut PgTx) -> Result<StreamRead<SessionEvent>, AppFailure> {
        self.session.read(tx).await
    }

    async fn append(
        &self,
        tx: &mut PgTx,
        expected: u64,
        events: Vec<SessionEvent>,
    ) -> Result<u64, AppFailure> {
        self.session.append(tx, expected, events).await
    }

    async fn commit(&self, tx: PgTx) -> Result<(), AppFailure> {
        EventStore::<SessionEvent>::commit(&self.session, tx).await
    }

    async fn rollback(&self, tx: PgTx) -> Result<(), AppFailure> {
        EventStore::<SessionEvent>::rollback(&self.session, tx).await
    }

    async fn write_peripheral(
        &self,
        tx: &mut PgTx,
        writes: &[PeripheralWrite],
    ) -> Result<(), AppFailure> {
        EventStore::<SessionEvent>::write_peripheral(&self.session, tx, writes).await
    }
}
