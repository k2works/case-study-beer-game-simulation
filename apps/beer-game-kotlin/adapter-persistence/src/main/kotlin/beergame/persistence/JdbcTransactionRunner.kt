package beergame.persistence

import arrow.core.Either
import arrow.core.left
import arrow.core.right
import beergame.application.AppFailure
import beergame.application.TransactionRunner
import beergame.application.Tx
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.withContext
import java.sql.Connection
import java.sql.SQLException
import javax.sql.DataSource

/**
 * JDBC のトランザクション。READ COMMITTED で、ブロックが Left なら ROLLBACK、Right なら COMMIT。
 * JDBC のブロッキング I/O は IO のディスパッチャーに閉じ込める。COMMIT・ROLLBACK・接続の返却は NonCancellable で行い、
 * クライアントの切断でコルーチンがキャンセルされても、トランザクションは必ず閉じる。
 * CancellationException は握りつぶさず、そのまま伝える。
 */
internal class JdbcTransactionRunner(
    private val dataSource: DataSource,
    private val ioDispatcher: CoroutineDispatcher = Dispatchers.IO,
) : TransactionRunner {
    override suspend operator fun <A> invoke(block: suspend (Tx) -> Either<AppFailure, A>): Either<AppFailure, A> =
        withContext(ioDispatcher) {
            when (val opened = open()) {
                is Either.Left -> opened.value.left()
                is Either.Right -> runIn(opened.value, block)
            }
        }

    private fun open(): Either<AppFailure, Connection> =
        try {
            dataSource.connection
                .also {
                    it.autoCommit = false
                    it.transactionIsolation = Connection.TRANSACTION_READ_COMMITTED
                }.right()
        } catch (e: SQLException) {
            e.toAppFailure(OP_OPEN).left()
        }

    private suspend fun <A> runIn(
        connection: Connection,
        block: suspend (Tx) -> Either<AppFailure, A>,
    ): Either<AppFailure, A> {
        val tx = JdbcTx(connection)
        var finished = false
        try {
            val outcome = runBlock(tx, block)
            val result = withContext(NonCancellable) { finish(tx, outcome) }
            finished = true
            return result
        } finally {
            withContext(NonCancellable) {
                if (!finished) rollbackQuietly(tx)
                closeQuietly(connection)
            }
        }
    }

    private suspend fun <A> runBlock(
        tx: JdbcTx,
        block: suspend (Tx) -> Either<AppFailure, A>,
    ): Either<AppFailure, A> =
        try {
            block(tx)
        } catch (e: SQLException) {
            e.toAppFailure(OP_BLOCK).left()
        }

    private fun <A> finish(
        tx: JdbcTx,
        outcome: Either<AppFailure, A>,
    ): Either<AppFailure, A> {
        val result =
            when (outcome) {
                is Either.Right -> commit(tx, outcome)
                is Either.Left -> outcome.also { rollbackQuietly(tx) }
            }
        tx.runEndHooks()
        return result
    }

    private fun <A> commit(
        tx: JdbcTx,
        outcome: Either<AppFailure, A>,
    ): Either<AppFailure, A> =
        try {
            tx.connection.commit()
            tx.runCommitHooks()
            outcome
        } catch (e: SQLException) {
            rollbackQuietly(tx)
            e.toAppFailure(OP_COMMIT).left()
        }

    private fun rollbackQuietly(tx: JdbcTx) {
        try {
            if (!tx.connection.isClosed) tx.connection.rollback()
        } catch (_: SQLException) {
            // 接続が既に壊れている。プールが破棄する。
        } finally {
            tx.runEndHooks()
        }
    }

    private fun closeQuietly(connection: Connection) {
        try {
            connection.close()
        } catch (_: SQLException) {
            // 閉じられない接続は、プールが破棄する。
        }
    }

    private companion object {
        const val OP_OPEN = "open-connection"
        const val OP_BLOCK = "transaction"
        const val OP_COMMIT = "commit"
    }
}
