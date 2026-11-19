package beergame.persistence

import arrow.core.Either
import arrow.core.flatMap
import arrow.core.left
import arrow.core.right
import beergame.application.AppFailure
import beergame.application.ProjectionLock
import beergame.application.Tx
import beergame.domain.GameId
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import java.util.concurrent.locks.StampedLock

/**
 * PostgreSQL 版: アドバイザリロック（トランザクションの終了で自動的に解放される）。
 * 待ちの上限は `lock_timeout`（このトランザクションの間だけ）。超えた（SQLSTATE 55P03）ら RetryExhausted。
 * `game_id` は UUID の上位 64 ビットを 64 ビットのキーに写す（衝突は不要な待ちを生むだけで、整合性は損なわない）。
 */
internal class PostgresProjectionLock(
    private val timeoutMillis: Long,
) {
    fun port(): ProjectionLock =
        ProjectionLock(
            acquireShared = { tx, game -> acquire(tx, game, "pg_advisory_xact_lock_shared") },
            acquireExclusive = { tx, game -> acquire(tx, game, "pg_advisory_xact_lock") },
        )

    private fun acquire(
        tx: Tx,
        gameId: GameId,
        function: String,
    ): Either<AppFailure, Unit> =
        tx.jdbc(OP).flatMap { jdbcTx ->
            jdbcCall(OP) {
                val connection = jdbcTx.connection
                setLockTimeout(jdbcTx, "${timeoutMillis}ms")
                connection.prepareStatement("SELECT $function(?)").use { ps ->
                    ps.setLong(1, gameId.value.mostSignificantBits)
                    ps.execute()
                }
                setLockTimeout(jdbcTx, "0")
                Unit.right()
            }
        }

    /** `SET LOCAL lock_timeout` 相当。ロックの取得の間だけ上限を置き、その後の行ロックの待ちには効かせない。 */
    private fun setLockTimeout(
        tx: JdbcTx,
        value: String,
    ) {
        tx.connection.prepareStatement("SELECT set_config('lock_timeout', ?, true)").use { ps ->
            ps.setString(1, value)
            ps.execute()
        }
    }

    private companion object {
        const val OP = "projection-lock"
    }
}

/**
 * H2 版（ローカル開発）: プロセス内の読み書きロック（ゲームごと）。**単一プロセスでだけ有効**（複数プロセスでは保証しない）。
 * トランザクションの終了のフックで解放する。StampedLock は、取得したスレッドと解放するスレッドが違ってよい
 * （コルーチンは別のスレッドで再開しうる）。ゲームごとのロックは、プロセスの間は保持する（ローカルで使うゲーム数は小さい）。
 */
internal class LocalProjectionLock(
    private val timeoutMillis: Long,
) {
    private val locks = ConcurrentHashMap<GameId, StampedLock>()

    fun port(): ProjectionLock =
        ProjectionLock(
            acquireShared = { tx, game -> acquire(tx, game, shared = true) },
            acquireExclusive = { tx, game -> acquire(tx, game, shared = false) },
        )

    /** トランザクション（IO のディスパッチャーで動く）の中で、待ちの上限まで、呼び出したスレッドで待つ。 */
    private fun acquire(
        tx: Tx,
        gameId: GameId,
        shared: Boolean,
    ): Either<AppFailure, Unit> =
        tx.jdbc(OP).flatMap { jdbcTx ->
            val lock = locks.computeIfAbsent(gameId) { StampedLock() }
            val stamp = tryAcquire(lock, shared)
            if (stamp == 0L) {
                AppFailure.RetryExhausted.left()
            } else {
                jdbcTx.afterEnd { release(lock, stamp, shared) }
                Unit.right()
            }
        }

    private fun tryAcquire(
        lock: StampedLock,
        shared: Boolean,
    ): Long =
        if (shared) {
            lock.tryReadLock(timeoutMillis, TimeUnit.MILLISECONDS)
        } else {
            lock.tryWriteLock(timeoutMillis, TimeUnit.MILLISECONDS)
        }

    private fun release(
        lock: StampedLock,
        stamp: Long,
        shared: Boolean,
    ) = if (shared) lock.unlockRead(stamp) else lock.unlockWrite(stamp)

    private companion object {
        const val OP = "projection-lock"
    }
}
