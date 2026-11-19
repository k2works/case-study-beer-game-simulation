package beergame.persistence

import arrow.core.Either
import arrow.core.right
import beergame.application.AppFailure
import beergame.application.DeletionReceipt
import beergame.application.DueDeletion
import beergame.application.ProjectedDeletionRun
import beergame.application.ProjectedRetention
import beergame.application.RetentionStore
import beergame.domain.GameId
import beergame.domain.RetentionEvent
import beergame.domain.RetentionState
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.sql.Connection
import java.sql.ResultSet
import java.sql.SQLException
import java.time.Instant
import java.time.OffsetDateTime
import java.util.UUID
import javax.sql.DataSource

/*
 * 保持と削除（B11。US5.1）の永続化。
 * - [RetentionRows]: 主の読み取り（[JdbcProjectionReader]）が使う、保持方針と削除の進行（`deletion_runs`）。
 * - [JdbcRetentionStore]: `retention` モードが使う削除の永続化。**削除用のロール**（`beergame_deleter`。
 *   PostgreSQL では接続のたびに `SET ROLE`）で動く [DataSource] を渡す。H2 では、単一の接続ユーザー
 *   （ローカルでは、権限の分離は守られない）。
 */

internal object RetentionRows {
    private const val POLICY_SQL =
        "SELECT p.retention_days, p.retention_starts_at, p.delete_after, " +
            "r.status, r.attempt, r.next_attempt_at, r.last_failure_code " +
            "FROM retention_policies p LEFT JOIN deletion_runs r ON r.game_id = p.game_id WHERE p.game_id = ?"

    fun read(
        c: Connection,
        gameId: GameId,
    ): ProjectedRetention? =
        c
            .query(POLICY_SQL, gameId) { rs ->
                ProjectedRetention(
                    retentionDays = rs.getInt("retention_days"),
                    startsAt = rs.getInstant("retention_starts_at"),
                    deleteAfter = rs.getInstant("delete_after"),
                    run =
                        rs.getString("status")?.let {
                            ProjectedDeletionRun(
                                status = it,
                                attempt = rs.getInt("attempt"),
                                nextAttemptAt = rs.optionalInstant("next_attempt_at"),
                                lastFailureCode = rs.getString("last_failure_code"),
                            )
                        },
                )
            }.firstOrNull()
}

/** 削除の永続化。[dataSource] は、削除用のロールで動く接続のプール（`retention` モード）。 */
fun retentionStore(dataSource: DataSource): RetentionStore = JdbcRetentionStore(dataSource)

private fun ResultSet.optionalInstant(label: String): Instant? =
    getObject(label, OffsetDateTime::class.java)?.toInstant()

internal class JdbcRetentionStore(
    private val dataSource: DataSource,
    private val ioDispatcher: CoroutineDispatcher = Dispatchers.IO,
) : RetentionStore {
    override suspend fun due(
        now: Instant,
        limit: Int,
    ): Either<AppFailure, List<DueDeletion>> =
        withContext(ioDispatcher) {
            query("retention.due") { c ->
                c.prepareStatement(DUE_SQL).use { ps ->
                    ps
                        .params()
                        .instant(now)
                        .instant(now)
                        .int(limit)
                    ps.executeQuery().use { rs -> generateSequence { if (rs.next()) due(rs) else null }.toList() }
                }
            }
        }

    override suspend fun begin(
        gameId: GameId,
        deletionId: UUID,
        started: RetentionEvent.DeletionStarted,
    ): Either<AppFailure, Unit> =
        withContext(ioDispatcher) {
            transaction("retention.begin") { c ->
                val updated =
                    c.prepareStatement(UPDATE_RUN_SQL).use { ps ->
                        ps
                            .params()
                            .int(started.attempt)
                            .instant(started.leaseUntil)
                            .uuid(deletionId)
                        ps.executeUpdate()
                    }
                if (updated == 0) {
                    c.prepareStatement(INSERT_RUN_SQL).use { ps ->
                        ps
                            .params()
                            .uuid(deletionId)
                            .uuid(gameId.value)
                            .int(started.attempt)
                            .instant(started.at)
                            .instant(started.leaseUntil)
                        ps.executeUpdate()
                    }
                }
                c.prepareStatement(INSERT_ATTEMPT_SQL).use { ps ->
                    ps
                        .params()
                        .uuid(deletionId)
                        .int(started.attempt)
                        .instant(started.at)
                    ps.executeUpdate()
                }
                Unit
            }
        }

    /**
     * `game_roots` の削除（連鎖で、`game_id` を持つ全表の行が消える）、削除の進行の行の削除、受領記録の挿入を、
     * 1 つのトランザクションで行う。途中で失敗したら、ロールバックして、何も消さない。
     */
    override suspend fun delete(
        gameId: GameId,
        receipt: DeletionReceipt,
    ): Either<AppFailure, Unit> =
        withContext(ioDispatcher) {
            transaction("retention.delete") { c ->
                c.prepareStatement(DELETE_ROOT_SQL).use { ps ->
                    ps.params().uuid(gameId.value)
                    ps.executeUpdate()
                }
                c.prepareStatement(DELETE_ATTEMPTS_SQL).use { ps ->
                    ps.params().uuid(receipt.deletionId)
                    ps.executeUpdate()
                }
                c.prepareStatement(DELETE_RUN_SQL).use { ps ->
                    ps.params().uuid(receipt.deletionId)
                    ps.executeUpdate()
                }
                c.prepareStatement(INSERT_RECEIPT_SQL).use { ps ->
                    ps
                        .params()
                        .uuid(receipt.deletionId)
                        .string(receipt.gameReferenceDigest)
                        .instant(receipt.recordedAt)
                        .instant(receipt.expiresAt)
                    ps.executeUpdate()
                }
                Unit
            }
        }

    override suspend fun fail(
        deletionId: UUID,
        failed: RetentionEvent.DeletionFailed,
    ): Either<AppFailure, Unit> =
        withContext(ioDispatcher) {
            transaction("retention.fail") { c ->
                c.prepareStatement(FAIL_RUN_SQL).use { ps ->
                    ps
                        .params()
                        .string(failed.failureCode)
                        .instantOrNull(failed.nextAttemptAt)
                        .uuid(deletionId)
                    ps.executeUpdate()
                }
                c.prepareStatement(FAIL_ATTEMPT_SQL).use { ps ->
                    ps
                        .params()
                        .string(failed.failureCode)
                        .uuid(deletionId)
                        .int(failed.attempt)
                    ps.executeUpdate()
                }
                Unit
            }
        }

    override suspend fun purgeReceipts(now: Instant): Either<AppFailure, Int> =
        withContext(ioDispatcher) {
            transaction("retention.purge") { c ->
                c.prepareStatement(PURGE_RECEIPTS_SQL).use { ps ->
                    ps.params().instant(now)
                    ps.executeUpdate()
                }
            }
        }

    private fun due(rs: ResultSet): DueDeletion {
        val gameId = GameId(checkNotNull(rs.getUuid("game_id")))
        val deletionId = rs.getUuid("deletion_id")
        val attempt = rs.getInt("attempt")
        val next = rs.optionalInstant("next_attempt_at")
        val state =
            when {
                deletionId == null -> RetentionState.Pending
                rs.getString("status") == "IN_PROGRESS" -> RetentionState.InProgress(attempt, checkNotNull(next))
                else -> RetentionState.Failed(attempt, checkNotNull(next), rs.getString("last_failure_code").orEmpty())
            }
        return DueDeletion(gameId, deletionId, state)
    }

    /** 読み取り。呼び出し側が、入出力用のディスパッチャーで実行する。例外（SQL の失敗）は、失敗の値にする。 */
    private fun <A> query(
        operation: String,
        block: (Connection) -> A,
    ): Either<AppFailure, A> =
        try {
            dataSource.connection.use { c -> block(c).right() }
        } catch (e: SQLException) {
            Either.Left(e.toAppFailure(operation))
        }

    /** 1 つのトランザクションで [block] を行う。例外（SQL の失敗）は、ロールバックして、失敗の値にする。 */
    private fun <A> transaction(
        operation: String,
        block: (Connection) -> A,
    ): Either<AppFailure, A> =
        try {
            dataSource.connection.use { c ->
                c.autoCommit = false
                try {
                    val result = block(c)
                    c.commit()
                    result.right()
                } catch (e: SQLException) {
                    c.rollback()
                    throw e
                }
            }
        } catch (e: SQLException) {
            Either.Left(e.toAppFailure(operation))
        }

    private companion object {
        // 期限に達し、まだ削除が終わっていないゲーム。次の試行の時刻（IN_PROGRESS では貸出の期限）に達したものだけ。
        // FAILED で次の試行の時刻が無いもの（再試行をやめた）は含めない。
        const val DUE_SQL =
            "SELECT p.game_id, r.deletion_id, r.status, r.attempt, r.next_attempt_at, r.last_failure_code " +
                "FROM retention_policies p LEFT JOIN deletion_runs r ON r.game_id = p.game_id " +
                "WHERE p.delete_after <= ? AND " +
                "(r.deletion_id IS NULL OR (r.next_attempt_at IS NOT NULL AND r.next_attempt_at <= ?)) " +
                "ORDER BY p.delete_after, p.game_id LIMIT ?"
        const val UPDATE_RUN_SQL =
            "UPDATE deletion_runs SET status = 'IN_PROGRESS', attempt = ?, next_attempt_at = ? WHERE deletion_id = ?"
        const val INSERT_RUN_SQL =
            "INSERT INTO deletion_runs (deletion_id, game_id, status, attempt, requested_at, next_attempt_at) " +
                "VALUES (?, ?, 'IN_PROGRESS', ?, ?, ?)"
        const val INSERT_ATTEMPT_SQL =
            "INSERT INTO deletion_attempts (deletion_id, attempt, started_at) VALUES (?, ?, ?)"
        const val DELETE_ROOT_SQL = "DELETE FROM game_roots WHERE game_id = ?"
        const val DELETE_ATTEMPTS_SQL = "DELETE FROM deletion_attempts WHERE deletion_id = ?"
        const val DELETE_RUN_SQL = "DELETE FROM deletion_runs WHERE deletion_id = ?"
        const val INSERT_RECEIPT_SQL =
            "INSERT INTO deletion_receipts (deletion_id, game_reference_digest, outcome, recorded_at, expires_at) " +
                "VALUES (?, ?, 'COMPLETED', ?, ?)"
        const val FAIL_RUN_SQL =
            "UPDATE deletion_runs SET status = 'FAILED', last_failure_code = ?, next_attempt_at = ? " +
                "WHERE deletion_id = ?"
        const val FAIL_ATTEMPT_SQL =
            "UPDATE deletion_attempts SET failure_code = ? WHERE deletion_id = ? AND attempt = ?"
        const val PURGE_RECEIPTS_SQL = "DELETE FROM deletion_receipts WHERE expires_at <= ?"
    }
}
