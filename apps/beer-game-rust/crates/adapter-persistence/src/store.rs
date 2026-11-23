//! PostgreSQL のイベントストア。追記専用。楽観的並行制御は `uq_events_stream_version` の違反で検出する。

use std::marker::PhantomData;

use beergame_application::{
    AppFailure, CredentialKind, CredentialLookup, CredentialRecord, EventStore, PeripheralWrite,
    PersistenceFailure, SessionWriter, StoredResponse, StreamRead,
};
use beergame_domain::{GameEvent, GameId, Instant, SessionEvent};

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

    /// イベントの操作者（`actor_kind`・`actor_id`）。既定は匿名（B2 の簡略化）。入力者がイベントに残るものは、それを返す（監査）。
    fn actor(&self, _event: &E) -> (&'static str, Option<uuid::Uuid>) {
        ("ANONYMOUS", None)
    }

    /// イベントが書く投影（追記と同じトランザクションで実行する）。既定は投影なし。
    fn projection(&self, _game_id: Uuid, _event: &E) -> Vec<Statement> {
        Vec::new()
    }
}

async fn run_statement(tx: &mut PgTx, statement: &Statement) -> Result<(), AppFailure> {
    run_on(&mut tx.0, statement).await
}

async fn run_on(conn: &mut sqlx::PgConnection, statement: &Statement) -> Result<(), AppFailure> {
    let mut query = sqlx::query(statement.sql);
    for bind in &statement.binds {
        query = match bind {
            Bind::Uuid(v) => query.bind(*v),
            Bind::Text(v) => query.bind(v.clone()),
            Bind::Int(v) => query.bind(*v),
            Bind::Json(v) => query.bind(v.clone()),
            Bind::Bytes(v) => query.bind(v.clone()),
            Bind::NullText => query.bind(None::<String>),
        };
    }
    query
        .execute(conn)
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

/// ロックの待ちの上限（ミリ秒）。初期値。実測で決める（B13 計画の判断項目 2。architecture-backend.md の M4）。
/// 再構築の間、コマンドが無期限に待って、接続とタスクが積み上がらないようにする。
pub const LOCK_TIMEOUT_MILLIS: u32 = 2000;

/// 待ちの上限を、このトランザクションにだけ設定する。
async fn set_lock_timeout(conn: &mut sqlx::PgConnection) -> Result<(), sqlx::Error> {
    sqlx::query("SELECT set_config('lock_timeout', $1, true)")
        .bind(format!("{LOCK_TIMEOUT_MILLIS}ms"))
        .execute(conn)
        .await
        .map(|_| ())
}

/// ロックの取得の失敗を写す。待ちの超過（55P03）は、再送してよい失敗（`RetryExhausted`）。
fn lock_failure(e: &sqlx::Error) -> AppFailure {
    if let sqlx::Error::Database(db) = e
        && db.code().as_deref() == Some("55P03")
    {
        AppFailure::RetryExhausted
    } else {
        storage(e)
    }
}

/// コマンドの共有のロック。コマンド同士は待たせず、再構築（排他）とだけ同時に走らない。
/// トランザクションの終了で解放される（`_xact_`。接続が切れても残らない）。
/// 鍵はゲームごと（`hashtextextended(game_id, 0)`）。再構築の排他のロックも同じ鍵を使う。
async fn acquire_shared(conn: &mut sqlx::PgConnection, game_id: Uuid) -> Result<(), sqlx::Error> {
    set_lock_timeout(&mut *conn).await?;
    sqlx::query("SELECT pg_advisory_xact_lock_shared(hashtextextended($1::text, 0))")
        .bind(game_id)
        .execute(conn)
        .await
        .map(|_| ())
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
        let mut tx = match self.pool.begin().await {
            Ok(tx) => tx,
            // 接続を取れなかった（コマンドは未実行）。再送してよい失敗に写す
            Err(sqlx::Error::PoolTimedOut | sqlx::Error::PoolClosed) => {
                return Err(AppFailure::RetryExhausted);
            }
            Err(e) => return Err(storage(&e)),
        };
        if let Err(e) = acquire_shared(&mut tx, self.game_id).await {
            // 待ちが切れたら、接続をすぐ戻す（drop に任せない）
            drop(tx.rollback().await);
            return Err(lock_failure(&e));
        }
        Ok(PgTx(tx))
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
            let (actor_kind, actor_id) = self.codec.actor(event);
            version = version.saturating_add(1);
            sqlx::query(
                "INSERT INTO events (event_id, game_id, stream_type, stream_version, event_type, \
                 schema_version, payload, actor_kind, actor_id, correlation_id, command_id, occurred_at) \
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $1, $1, now())",
            )
            .bind(Uuid::new_v4())
            .bind(self.game_id)
            .bind(self.stream.as_str())
            .bind(version)
            .bind(event_type)
            .bind(schema_version)
            .bind(payload)
            .bind(actor_kind)
            .bind(actor_id)
            .execute(&mut *tx.0)
            .await
            .map_err(|e| append_failure(&e))?;
            for statement in self.codec.projection(self.game_id, event) {
                run_statement(tx, &statement).await?;
            }
        }
        if !events.is_empty() {
            // 進んだ版の記録（整合検査の入力）。追記と同じトランザクションで書く
            sqlx::query(
                "INSERT INTO projection_checkpoints (game_id, stream_type, projected_version, updated_at) \
                 VALUES ($1, $2, $3, now()) \
                 ON CONFLICT (game_id, stream_type) DO UPDATE \
                 SET projected_version = EXCLUDED.projected_version, updated_at = EXCLUDED.updated_at",
            )
            .bind(self.game_id)
            .bind(self.stream.as_str())
            .bind(version)
            .execute(&mut *tx.0)
            .await
            .map_err(|e| storage(&e))?;
        }
        Ok(u64::try_from(version).unwrap_or(0))
    }

    async fn find_idempotency(
        &self,
        tx: &mut PgTx,
        game_id: GameId,
        scope: &str,
        key_digest: &str,
    ) -> Result<Option<StoredResponse>, AppFailure> {
        // 期限内の記録だけを照合する（期限切れは、無いものとして扱う）
        let row = sqlx::query(
            "SELECT request_digest, status_code, response FROM idempotency_records \
             WHERE game_id = $1 AND scope = $2 AND key_digest = $3 AND expires_at > now()",
        )
        .bind(Uuid::from_u128(game_id.get()))
        .bind(scope)
        .bind(key_digest)
        .fetch_optional(&mut *tx.0)
        .await
        .map_err(|e| storage(&e))?;
        let Some(row) = row else { return Ok(None) };
        let request_digest: String = row.try_get("request_digest").map_err(|e| storage(&e))?;
        let status: i32 = row.try_get("status_code").map_err(|e| storage(&e))?;
        let body: Vec<u8> = row.try_get("response").map_err(|e| storage(&e))?;
        Ok(Some(StoredResponse {
            request_digest,
            status_code: u16::try_from(status).unwrap_or(500),
            body,
        }))
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

    async fn find_idempotency(
        &self,
        tx: &mut PgTx,
        game_id: GameId,
        scope: &str,
        key_digest: &str,
    ) -> Result<Option<StoredResponse>, AppFailure> {
        EventStore::<GameEvent>::find_idempotency(&self.game, tx, game_id, scope, key_digest).await
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

    async fn find_idempotency(
        &self,
        tx: &mut PgTx,
        game_id: GameId,
        scope: &str,
        key_digest: &str,
    ) -> Result<Option<StoredResponse>, AppFailure> {
        EventStore::<SessionEvent>::find_idempotency(&self.session, tx, game_id, scope, key_digest)
            .await
    }

    async fn write_peripheral(
        &self,
        tx: &mut PgTx,
        writes: &[PeripheralWrite],
    ) -> Result<(), AppFailure> {
        EventStore::<SessionEvent>::write_peripheral(&self.session, tx, writes).await
    }
}

impl PgGameStore {
    /// 資格の行（復帰資格・ブラウザセッション）を `CredentialRecord` にする。
    fn record_of(row: &sqlx::postgres::PgRow) -> Result<CredentialRecord, AppFailure> {
        let game: Uuid = row.try_get("game_id").map_err(|e| storage(&e))?;
        let kind: String = row.try_get("kind").map_err(|e| storage(&e))?;
        let subject: Uuid = row.try_get("subject_id").map_err(|e| storage(&e))?;
        let expires: i64 = row.try_get("expires_ms").map_err(|e| storage(&e))?;
        let revoked: bool = row.try_get("revoked").map_err(|e| storage(&e))?;
        let key_version: i32 = row.try_get("key_version").map_err(|e| storage(&e))?;
        let kind = match kind.as_str() {
            "FACILITATOR" => CredentialKind::Facilitator,
            "PARTICIPANT" => CredentialKind::Participant,
            "OBSERVER" => CredentialKind::Observer,
            "OBSERVER_INVITATION" => CredentialKind::ObserverInvitation,
            // 不明な種類は、無効な資格として扱う（fail closed）
            other => {
                return Err(AppFailure::Persistence(PersistenceFailure::Storage(
                    format!("不明な資格の種類: {other}"),
                )));
            }
        };
        Ok(CredentialRecord {
            game_id: GameId::new(game.as_u128()),
            kind,
            subject_id: subject.as_u128(),
            expires_at: Instant::from_epoch_millis(expires),
            revoked,
            key_version,
        })
    }
}

impl CredentialLookup for PgGameStore {
    /// ブラウザセッション。対象の復帰資格に、失効していないものが 1 つも無ければ `revoked`。
    async fn find(&self, digest: &str) -> Result<Option<CredentialRecord>, AppFailure> {
        let row = sqlx::query(
            "SELECT s.game_id, s.actor_kind AS kind, s.actor_id AS subject_id, s.key_version, \
             (extract(epoch FROM s.expires_at) * 1000)::bigint AS expires_ms, \
             (s.actor_kind <> 'OBSERVER' AND NOT EXISTS (SELECT 1 FROM credentials c WHERE c.game_id = s.game_id \
                         AND c.subject_id = s.actor_id AND c.revoked_at IS NULL)) AS revoked \
             FROM browser_sessions s WHERE s.credential_digest = $1",
        )
        .bind(digest)
        .fetch_optional(&self.game.pool)
        .await
        .map_err(|e| storage(&e))?;
        row.as_ref().map(Self::record_of).transpose()
    }

    async fn find_recovery(&self, digest: &str) -> Result<Option<CredentialRecord>, AppFailure> {
        let row = sqlx::query(
            "SELECT game_id, kind, subject_id, key_version, (extract(epoch FROM expires_at) * 1000)::bigint AS expires_ms, \
             revoked_at IS NOT NULL AS revoked FROM credentials WHERE credential_digest = $1",
        )
        .bind(digest)
        .fetch_optional(&self.game.pool)
        .await
        .map_err(|e| storage(&e))?;
        row.as_ref().map(Self::record_of).transpose()
    }
}

impl SessionWriter for PgGameStore {
    async fn start_session(
        &self,
        recovery_digest: &str,
        session: &PeripheralWrite,
        recovery_expires_at: Instant,
    ) -> Result<(), AppFailure> {
        let mut tx = self.game.pool.begin().await.map_err(|e| storage(&e))?;
        let statement = crate::projection::peripheral_statements(session);
        run_on(&mut tx, &statement).await?;
        sqlx::query(
            "UPDATE credentials SET expires_at = to_timestamp($2::double precision / 1000) WHERE credential_digest = $1",
        )
        .bind(recovery_digest)
        .bind(recovery_expires_at.epoch_millis())
        .execute(&mut *tx)
        .await
        .map_err(|e| storage(&e))?;
        tx.commit().await.map_err(|e| storage(&e))
    }
}
