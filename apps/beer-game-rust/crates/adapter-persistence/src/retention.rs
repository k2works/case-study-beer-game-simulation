//! 保持と削除の永続化（`RetentionStore`）。削除の完了は 1 つのトランザクション（連鎖削除・進行の記録の削除・受領記録）。

use beergame_application::{AppFailure, DueGame, PersistenceFailure, RetentionStore};
use beergame_domain::{GameId, Instant};
use sqlx::{PgPool, Row};
use uuid::Uuid;

/// PostgreSQL の保持と削除。
pub struct PgRetentionStore {
    pool: PgPool,
}

impl PgRetentionStore {
    #[must_use]
    pub const fn new(pool: PgPool) -> Self {
        PgRetentionStore { pool }
    }
}

fn storage(e: &sqlx::Error) -> AppFailure {
    AppFailure::Persistence(PersistenceFailure::Storage(e.to_string()))
}

fn uuid_of(game_id: GameId) -> Uuid {
    Uuid::from_u128(game_id.get())
}

impl RetentionStore for PgRetentionStore {
    async fn due_games(
        &self,
        now: Instant,
        only: Option<&[GameId]>,
    ) -> Result<Vec<DueGame>, AppFailure> {
        let only: Option<Vec<Uuid>> = only.map(|games| games.iter().map(|g| uuid_of(*g)).collect());
        // 期限に達し、削除の記録が無い、または再試行の時刻（貸出の期限を含む）が来ているもの。再試行をやめたもの（next_attempt_at が無い）は除く
        let rows = sqlx::query(
            "SELECT p.game_id, COALESCE(r.attempt, 0) AS attempt FROM retention_policies p \
             LEFT JOIN deletion_runs r ON r.game_id = p.game_id \
             WHERE p.delete_after <= to_timestamp($1::double precision / 1000) \
               AND (r.game_id IS NULL OR (r.next_attempt_at IS NOT NULL \
                    AND r.next_attempt_at <= to_timestamp($1::double precision / 1000))) \
               AND ($2::uuid[] IS NULL OR p.game_id = ANY($2)) \
             ORDER BY p.delete_after, p.game_id",
        )
        .bind(now.epoch_millis())
        .bind(only)
        .fetch_all(&self.pool)
        .await
        .map_err(|e| storage(&e))?;
        rows.iter()
            .map(|row| {
                Ok(DueGame {
                    game_id: GameId::new(
                        row.try_get::<Uuid, _>("game_id")
                            .map_err(|e| storage(&e))?
                            .as_u128(),
                    ),
                    attempt: row.try_get("attempt").map_err(|e| storage(&e))?,
                })
            })
            .collect()
    }

    async fn begin_attempt(
        &self,
        game_id: GameId,
        now: Instant,
        lease_until: Instant,
    ) -> Result<(), AppFailure> {
        let mut tx = self.pool.begin().await.map_err(|e| storage(&e))?;
        let attempt: i32 = sqlx::query_scalar(
            "INSERT INTO deletion_runs (deletion_id, game_id, status, attempt, requested_at, next_attempt_at) \
             VALUES ($1, $2, 'IN_PROGRESS', 1, to_timestamp($3::double precision / 1000), to_timestamp($4::double precision / 1000)) \
             ON CONFLICT (game_id) DO UPDATE SET status = 'IN_PROGRESS', attempt = deletion_runs.attempt + 1, \
                 next_attempt_at = EXCLUDED.next_attempt_at \
             RETURNING attempt",
        )
        .bind(Uuid::new_v4())
        .bind(uuid_of(game_id))
        .bind(now.epoch_millis())
        .bind(lease_until.epoch_millis())
        .fetch_one(&mut *tx)
        .await
        .map_err(|e| storage(&e))?;
        sqlx::query(
            "INSERT INTO deletion_attempts (deletion_id, attempt, started_at) \
             SELECT deletion_id, $2, to_timestamp($3::double precision / 1000) FROM deletion_runs WHERE game_id = $1",
        )
        .bind(uuid_of(game_id))
        .bind(attempt)
        .bind(now.epoch_millis())
        .execute(&mut *tx)
        .await
        .map_err(|e| storage(&e))?;
        tx.commit().await.map_err(|e| storage(&e))
    }

    async fn erase_and_record(
        &self,
        game_id: GameId,
        receipt_digest: &str,
        now: Instant,
        receipt_expires_at: Instant,
    ) -> Result<(), AppFailure> {
        let mut tx = self.pool.begin().await.map_err(|e| storage(&e))?;
        // 受領記録（ゲームを特定しない形）を先に書く。削除の進行の記録の ID を、受領記録の ID に使う
        let deletion_id: Uuid =
            sqlx::query_scalar("SELECT deletion_id FROM deletion_runs WHERE game_id = $1")
                .bind(uuid_of(game_id))
                .fetch_one(&mut *tx)
                .await
                .map_err(|e| storage(&e))?;
        sqlx::query(
            "INSERT INTO deletion_receipts (deletion_id, game_reference_digest, outcome, recorded_at, expires_at) \
             VALUES ($1, $2, 'COMPLETED', to_timestamp($3::double precision / 1000), to_timestamp($4::double precision / 1000))",
        )
        .bind(deletion_id)
        .bind(receipt_digest)
        .bind(now.epoch_millis())
        .bind(receipt_expires_at.epoch_millis())
        .execute(&mut *tx)
        .await
        .map_err(|e| storage(&e))?;
        // 連鎖削除（イベント・投影・周辺ストア・冪等記録）。同じトランザクションで進行の記録も消す（game_id を含む行を残さない）
        sqlx::query("DELETE FROM game_roots WHERE game_id = $1")
            .bind(uuid_of(game_id))
            .execute(&mut *tx)
            .await
            .map_err(|e| storage(&e))?;
        sqlx::query("DELETE FROM deletion_runs WHERE game_id = $1")
            .bind(uuid_of(game_id))
            .execute(&mut *tx)
            .await
            .map_err(|e| storage(&e))?;
        tx.commit().await.map_err(|e| storage(&e))
    }

    async fn record_failure(
        &self,
        game_id: GameId,
        failure_code: &str,
        next_attempt_at: Option<Instant>,
    ) -> Result<(), AppFailure> {
        let mut tx = self.pool.begin().await.map_err(|e| storage(&e))?;
        sqlx::query(
            "UPDATE deletion_runs SET status = 'FAILED', last_failure_code = $2, \
             next_attempt_at = CASE WHEN $3::bigint IS NULL THEN NULL ELSE to_timestamp($3::double precision / 1000) END \
             WHERE game_id = $1",
        )
        .bind(uuid_of(game_id))
        .bind(failure_code)
        .bind(next_attempt_at.map(Instant::epoch_millis))
        .execute(&mut *tx)
        .await
        .map_err(|e| storage(&e))?;
        sqlx::query(
            "UPDATE deletion_attempts SET failure_code = $2 WHERE (deletion_id, attempt) = \
             (SELECT deletion_id, attempt FROM deletion_runs WHERE game_id = $1)",
        )
        .bind(uuid_of(game_id))
        .bind(failure_code)
        .execute(&mut *tx)
        .await
        .map_err(|e| storage(&e))?;
        tx.commit().await.map_err(|e| storage(&e))
    }

    async fn purge_receipts(&self, now: Instant) -> Result<(), AppFailure> {
        sqlx::query("DELETE FROM deletion_receipts WHERE expires_at <= to_timestamp($1::double precision / 1000)")
            .bind(now.epoch_millis())
            .execute(&self.pool)
            .await
            .map(|_| ())
            .map_err(|e| storage(&e))
    }
}
