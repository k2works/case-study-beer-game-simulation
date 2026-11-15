package beergame.persistence

import arrow.core.Either
import arrow.core.flatMap
import arrow.core.left
import arrow.core.right
import beergame.application.AppFailure
import beergame.application.AttemptStore
import beergame.application.AttemptWindow
import beergame.application.PersistenceFailure
import beergame.application.Tx
import java.sql.PreparedStatement
import java.time.Instant

/**
 * 参加・復帰の窓（`participation_attempts`）。H2 と PostgreSQL で同じ SQL（PostgreSQL 固有の機能は使わない）。
 * - [charge]: 行が無ければ 0 で作り（`ON CONFLICT DO NOTHING`。同時の作成は、先に作った方に譲る）、1 を足し、足した後の数を読む。
 *   足す UPDATE が行をロックするので、同時の呼び出しは直列になり、数え落としも重複も出ない（各呼び出しが、自分の足した後の数を読む）。
 * - [refund]: 1 を戻す（0 より下には下げない）。行が無ければ何もしない。
 * - [purge]: 開始が指定の時刻より前の窓を消す。
 * 接続元は、鍵付きの要約（[AttemptWindow.sourceKey]）だけを受け取る。生の IP アドレスは、ここへ届かない。
 */
internal class JdbcAttemptStore {
    fun port(): AttemptStore = AttemptStore(::charge, ::refund, ::purge)

    private fun charge(
        tx: Tx,
        window: AttemptWindow,
    ): Either<AppFailure, Int> =
        tx.jdbc(OP_CHARGE).flatMap { jdbcTx ->
            jdbcCall(OP_CHARGE) {
                val connection = jdbcTx.connection
                connection.prepareStatement(CREATE_SQL).use { ps ->
                    ps.windowParams(window)
                    ps.executeUpdate()
                }
                connection.prepareStatement(INCREMENT_SQL).use { ps ->
                    ps.windowParams(window)
                    ps.executeUpdate()
                }
                connection.prepareStatement(COUNT_SQL).use { ps ->
                    ps.windowParams(window)
                    ps.executeQuery().use { rs -> if (rs.next()) rs.getInt(1).right() else missingRow(OP_CHARGE) }
                }
            }
        }

    private fun refund(
        tx: Tx,
        window: AttemptWindow,
    ): Either<AppFailure, Unit> =
        tx.jdbc(OP_REFUND).flatMap { jdbcTx ->
            jdbcCall(OP_REFUND) {
                jdbcTx.connection.prepareStatement(DECREMENT_SQL).use { ps ->
                    ps.windowParams(window)
                    ps.executeUpdate()
                }
                Unit.right()
            }
        }

    private fun purge(
        tx: Tx,
        before: Instant,
    ): Either<AppFailure, Unit> =
        tx.jdbc(OP_PURGE).flatMap { jdbcTx ->
            jdbcCall(OP_PURGE) {
                jdbcTx.connection.prepareStatement(PURGE_SQL).use { ps ->
                    ps.params().instant(before)
                    ps.executeUpdate()
                }
                Unit.right()
            }
        }

    private fun PreparedStatement.windowParams(window: AttemptWindow) {
        params().string(window.scope.key).string(window.sourceKey).instant(window.start)
    }

    private fun missingRow(operation: String): Either<AppFailure, Int> =
        AppFailure.Persistence(PersistenceFailure(operation, "足した窓の行が読めない")).left()

    private companion object {
        const val OP_CHARGE = "attempts.charge"
        const val OP_REFUND = "attempts.refund"
        const val OP_PURGE = "attempts.purge"
        const val KEY = "WHERE scope = ? AND key_digest = ? AND window_start = ?"
        const val CREATE_SQL =
            "INSERT INTO participation_attempts (scope, key_digest, window_start, failure_count) " +
                "VALUES (?, ?, ?, 0) ON CONFLICT DO NOTHING"
        const val INCREMENT_SQL = "UPDATE participation_attempts SET failure_count = failure_count + 1 $KEY"
        const val DECREMENT_SQL =
            "UPDATE participation_attempts SET failure_count = failure_count - 1 $KEY AND failure_count > 0"
        const val COUNT_SQL = "SELECT failure_count FROM participation_attempts $KEY"
        const val PURGE_SQL = "DELETE FROM participation_attempts WHERE window_start < ?"
    }
}
