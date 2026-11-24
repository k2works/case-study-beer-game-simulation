//! 投影の再構築と整合の検査（B13。data-model.md「投影の再構築」、NF-R15）。
//! 再構築は、ゲームごとに 1 トランザクション: 排他のロックを先頭で取り、投影の行と進んだ版の記録を消し、`events` を追記順（`seq`）に
//! 読み直して、同期投影と同じ文（`EventCodec::projection`）で作り直す。コマンドが見るのは、再構築の前後のどちらかだけ。
//! 検査は、同じ手順を行って比べたあと、**取り消す**（投影を変えない）。
//!
//! 投影の文は、時刻に `now()` を使う。再生では、その `now()` をイベントの `occurred_at` に置き換える
//! （追記の時刻と同じ値になり、作り直した行が元の行と一致する）。

use std::collections::BTreeMap;

use beergame_application::{
    AppFailure, Inconsistency, PersistenceFailure, ProjectionMaintenance, RebuildOutcome,
};
use beergame_domain::{GameEvent, GameId, SessionEvent};
use sqlx::{AssertSqlSafe, PgConnection, PgPool, Row};
use uuid::Uuid;

use crate::codec::{GameCodec, SessionCodec};
use crate::projection::{Bind, Statement};
use crate::store::{EventCodec, acquire_exclusive, lock_failure};

/// 投影の表。子（外部キーで参照する側）を先に消せる順。
pub const PROJECTION_TABLES: [&str; 13] = [
    "week_team_totals",
    "week_role_results",
    "week_commits",
    "current_decisions",
    "role_current_states",
    "session_overview",
    "lobby_observers",
    "lobby_observer_invitations",
    "lobby_participants",
    "game_settings",
    "game_join_codes",
    "game_overview",
    "retention_policies",
];

/// PostgreSQL の投影の保守。
pub struct PgProjectionMaintenance {
    pool: PgPool,
}

impl PgProjectionMaintenance {
    #[must_use]
    pub const fn new(pool: PgPool) -> Self {
        PgProjectionMaintenance { pool }
    }
}

fn storage(e: &sqlx::Error) -> AppFailure {
    AppFailure::Persistence(PersistenceFailure::Storage(e.to_string()))
}

fn failure(message: String) -> AppFailure {
    AppFailure::Persistence(PersistenceFailure::Storage(message))
}

/// 再構築の前後の内容（表ごとの、行の JSON 文字列の並び）。
type Dump = BTreeMap<&'static str, Vec<String>>;

struct Rebuilt {
    events: usize,
    before: Dump,
    after: Dump,
}

impl Rebuilt {
    fn drifts(&self) -> Vec<Inconsistency> {
        PROJECTION_TABLES
            .iter()
            .filter_map(|table| {
                let before = self.before.get(table).map_or(&[][..], Vec::as_slice);
                let after = self.after.get(table).map_or(&[][..], Vec::as_slice);
                let (missing, unexpected) = difference(before, after);
                (missing + unexpected > 0).then(|| Inconsistency::RowDrift {
                    table: (*table).to_owned(),
                    missing,
                    unexpected,
                })
            })
            .collect()
    }

    fn outcome(&self, game_id: GameId) -> RebuildOutcome {
        let changed_rows = self
            .drifts()
            .iter()
            .map(|d| match d {
                Inconsistency::RowDrift {
                    missing,
                    unexpected,
                    ..
                } => missing + unexpected,
                Inconsistency::CheckpointDrift { .. } => 0,
            })
            .sum();
        RebuildOutcome {
            game_id,
            events: self.events,
            rows: self.after.values().map(Vec::len).sum(),
            changed_rows,
        }
    }
}

/// 多重集合としての差。`(after にあって before に無い行, before にあって after に無い行)`。
fn difference(before: &[String], after: &[String]) -> (usize, usize) {
    let mut counts: BTreeMap<&str, i64> = BTreeMap::new();
    for row in before {
        *counts.entry(row).or_insert(0) -= 1;
    }
    for row in after {
        *counts.entry(row).or_insert(0) += 1;
    }
    counts.values().fold((0, 0), |(missing, unexpected), n| {
        if *n > 0 {
            (missing + usize::try_from(*n).unwrap_or(0), unexpected)
        } else {
            (missing, unexpected + usize::try_from(-*n).unwrap_or(0))
        }
    })
}

async fn dump(conn: &mut PgConnection, game: Uuid) -> Result<Dump, AppFailure> {
    let mut out = Dump::new();
    for table in PROJECTION_TABLES {
        // 表の名前は上の定数だけ（利用者の入力ではない）
        let sql = format!("SELECT row_to_json(t)::text FROM {table} t WHERE game_id = $1");
        let mut rows: Vec<String> = sqlx::query_scalar(AssertSqlSafe(sql))
            .bind(game)
            .fetch_all(&mut *conn)
            .await
            .map_err(|e| storage(&e))?;
        rows.sort();
        out.insert(table, rows);
    }
    Ok(out)
}

/// 投影の文が、追記の時点の「ストリームの最後の版」を引くサブクエリ（`week_commits.stream_version`）。
/// 追記のときは、そのイベントまで書いた状態の最大の版を返すが、再生では全イベントが既にあるため、イベント自身の版に置き換える。
const HEAD_VERSION_SUBQUERY: &str =
    "(SELECT max(stream_version) FROM events WHERE game_id = $1 AND stream_type = 'SESSION')";

/// 再生するイベントの、追記の時点の値（時刻と版）。
struct Moment {
    occurred_micros: i64,
    stream_version: i64,
}

/// 1 文を実行する。`now()` はイベントの `occurred_at`（マイクロ秒）に、「最後の版」のサブクエリはイベント自身の版に置き換える。
async fn run_at(
    conn: &mut PgConnection,
    statement: &Statement,
    moment: &Moment,
) -> Result<(), AppFailure> {
    let mut extra: Vec<i64> = Vec::new();
    let mut sql = statement.sql.to_owned();
    if sql.contains(HEAD_VERSION_SUBQUERY) {
        extra.push(moment.stream_version);
        let position = statement.binds.len() + extra.len();
        sql = sql.replace(HEAD_VERSION_SUBQUERY, &format!("${position}::bigint"));
    }
    if sql.contains("now()") {
        extra.push(moment.occurred_micros);
        let position = statement.binds.len() + extra.len();
        let at = format!("(timestamptz 'epoch' + ${position}::bigint * interval '1 microsecond')");
        sql = sql.replace("now()", &at);
    }
    let mut query = sqlx::query(AssertSqlSafe(sql));
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
    for value in extra {
        query = query.bind(value);
    }
    query
        .execute(conn)
        .await
        .map(|_| ())
        .map_err(|e| storage(&e))
}

/// 投影の行と進んだ版の記録を消し、イベントから作り直す。
async fn rebuild_in(conn: &mut PgConnection, game: Uuid) -> Result<Rebuilt, AppFailure> {
    let rows = sqlx::query(
        "SELECT stream_type, stream_version, event_type, schema_version, payload, \
         (extract(epoch FROM occurred_at) * 1000000)::bigint AS at_us \
         FROM events WHERE game_id = $1 ORDER BY seq",
    )
    .bind(game)
    .fetch_all(&mut *conn)
    .await
    .map_err(|e| storage(&e))?;
    if rows.is_empty() {
        return Err(failure(format!("イベントが無いゲーム: {game}")));
    }
    let before = dump(conn, game).await?;
    for table in PROJECTION_TABLES {
        let sql = format!("DELETE FROM {table} WHERE game_id = $1");
        sqlx::query(AssertSqlSafe(sql))
            .bind(game)
            .execute(&mut *conn)
            .await
            .map_err(|e| storage(&e))?;
    }
    sqlx::query("DELETE FROM projection_checkpoints WHERE game_id = $1")
        .bind(game)
        .execute(&mut *conn)
        .await
        .map_err(|e| storage(&e))?;
    for row in &rows {
        let stream: String = row.try_get("stream_type").map_err(|e| storage(&e))?;
        let event_type: String = row.try_get("event_type").map_err(|e| storage(&e))?;
        let schema_version: i32 = row.try_get("schema_version").map_err(|e| storage(&e))?;
        let payload: serde_json::Value = row.try_get("payload").map_err(|e| storage(&e))?;
        let moment = Moment {
            occurred_micros: row.try_get("at_us").map_err(|e| storage(&e))?,
            stream_version: row.try_get("stream_version").map_err(|e| storage(&e))?,
        };
        let statements = match stream.as_str() {
            "GAME" => {
                let event: GameEvent = GameCodec
                    .decode(&event_type, schema_version, payload)
                    .map_err(failure)?;
                GameCodec.projection(game, &event)
            }
            "SESSION" => {
                let event: SessionEvent = SessionCodec
                    .decode(&event_type, schema_version, payload)
                    .map_err(failure)?;
                SessionCodec.projection(game, &event)
            }
            other => return Err(failure(format!("不明なストリーム: {other}"))),
        };
        for statement in &statements {
            run_at(conn, statement, &moment).await?;
        }
    }
    sqlx::query(
        "INSERT INTO projection_checkpoints (game_id, stream_type, projected_version, updated_at) \
         SELECT game_id, stream_type, max(stream_version), now() FROM events \
         WHERE game_id = $1 GROUP BY game_id, stream_type",
    )
    .bind(game)
    .execute(&mut *conn)
    .await
    .map_err(|e| storage(&e))?;
    let after = dump(conn, game).await?;
    Ok(Rebuilt {
        events: rows.len(),
        before,
        after,
    })
}

/// ストリームごとに、進んだ版の記録がイベントの最後の版と一致するか。
async fn checkpoint_drift(
    conn: &mut PgConnection,
    game: Uuid,
) -> Result<Vec<Inconsistency>, AppFailure> {
    let heads: Vec<(String, i64)> = sqlx::query_as(
        "SELECT stream_type, max(stream_version) FROM events WHERE game_id = $1 \
         GROUP BY stream_type ORDER BY stream_type",
    )
    .bind(game)
    .fetch_all(&mut *conn)
    .await
    .map_err(|e| storage(&e))?;
    let projected: Vec<(String, i64)> = sqlx::query_as(
        "SELECT stream_type, projected_version FROM projection_checkpoints WHERE game_id = $1",
    )
    .bind(game)
    .fetch_all(&mut *conn)
    .await
    .map_err(|e| storage(&e))?;
    Ok(heads
        .into_iter()
        .filter_map(|(stream, head)| {
            let version = projected
                .iter()
                .find(|(s, _)| *s == stream)
                .map(|(_, v)| *v);
            (version != Some(head)).then_some(Inconsistency::CheckpointDrift {
                stream,
                projected: version,
                head,
            })
        })
        .collect())
}

fn uuid_of(game_id: GameId) -> Uuid {
    Uuid::from_u128(game_id.get())
}

impl PgProjectionMaintenance {
    async fn begin_locked(
        &self,
        game: Uuid,
    ) -> Result<sqlx::Transaction<'static, sqlx::Postgres>, AppFailure> {
        let mut tx = match self.pool.begin().await {
            Ok(tx) => tx,
            Err(sqlx::Error::PoolTimedOut | sqlx::Error::PoolClosed) => {
                return Err(AppFailure::RetryExhausted);
            }
            Err(e) => return Err(storage(&e)),
        };
        if let Err(e) = acquire_exclusive(&mut tx, game).await {
            // 待ちが切れたら、接続をすぐ戻す
            drop(tx.rollback().await);
            return Err(lock_failure(&e));
        }
        Ok(tx)
    }
}

impl ProjectionMaintenance for PgProjectionMaintenance {
    async fn games(&self) -> Result<Vec<GameId>, AppFailure> {
        let ids: Vec<Uuid> =
            sqlx::query_scalar("SELECT game_id FROM game_roots ORDER BY created_at, game_id")
                .fetch_all(&self.pool)
                .await
                .map_err(|e| storage(&e))?;
        Ok(ids.into_iter().map(|u| GameId::new(u.as_u128())).collect())
    }

    async fn rebuild(&self, game_id: GameId) -> Result<RebuildOutcome, AppFailure> {
        let game = uuid_of(game_id);
        let mut tx = self.begin_locked(game).await?;
        match rebuild_in(&mut tx, game).await {
            Ok(rebuilt) => {
                tx.commit().await.map_err(|e| storage(&e))?;
                Ok(rebuilt.outcome(game_id))
            }
            Err(e) => {
                drop(tx.rollback().await);
                Err(e)
            }
        }
    }

    async fn verify(&self, game_id: GameId) -> Result<Vec<Inconsistency>, AppFailure> {
        let game = uuid_of(game_id);
        let mut tx = self.begin_locked(game).await?;
        let result = async {
            let mut findings = checkpoint_drift(&mut tx, game).await?;
            findings.extend(rebuild_in(&mut tx, game).await?.drifts());
            Ok(findings)
        }
        .await;
        // 検査は投影を変えない。結果にかかわらず取り消す
        drop(tx.rollback().await);
        result
    }
}
