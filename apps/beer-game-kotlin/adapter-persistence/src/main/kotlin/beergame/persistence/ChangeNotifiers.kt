package beergame.persistence

import arrow.core.Either
import arrow.core.left
import arrow.core.right
import beergame.application.ChangeNotifier
import beergame.application.PersistenceFailure
import beergame.application.Tx
import beergame.application.VersionNotice
import beergame.domain.GameId
import beergame.domain.StreamType
import beergame.domain.StreamVersion
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import org.postgresql.PGConnection
import java.sql.Connection
import java.sql.SQLException
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

private const val BUFFER = 1024
private const val NOTICE_PARTS = 3

/** 通知の流れ。遅い購読者には古い通知を捨てる（版は単調に増えるので、最新だけで足りる）。 */
private fun versionFlow() =
    MutableSharedFlow<VersionNotice>(extraBufferCapacity = BUFFER, onBufferOverflow = BufferOverflow.DROP_OLDEST)

/** 通知の配信の形式。ゲームの ID・ストリーム・版だけで、個人情報を含まない。 */
internal object NoticeFormat {
    fun encode(notice: VersionNotice): String =
        "${notice.gameId.value}|${notice.streamType.name}|${notice.version.value}"

    fun decode(raw: String): VersionNotice? {
        val parts = raw.split('|')
        if (parts.size != NOTICE_PARTS) return null
        val (game, stream, version) = parts
        val gameId = runCatching { UUID.fromString(game) }.getOrNull()
        val streamType = StreamType.entries.firstOrNull { it.name == stream }
        val streamVersion = version.toLongOrNull()?.let { StreamVersion.of(it).getOrNull() }
        return if (gameId != null && streamType != null && streamVersion != null) {
            VersionNotice(GameId(gameId), streamType, streamVersion)
        } else {
            null
        }
    }
}

/**
 * H2 版（ローカル開発）: プロセス内のイベント。publish はトランザクションの COMMIT 後に配信し、ROLLBACK では捨てる。
 * **単一プロセスでだけ有効**（複数プロセスへは届かない）。
 */
internal class LocalChangeNotifier {
    private val flow = versionFlow()

    fun port(): ChangeNotifier = ChangeNotifier(::publish, { flow.asSharedFlow() }, { true })

    private fun publish(
        tx: Tx,
        notices: List<VersionNotice>,
    ): Either<PersistenceFailure, Unit> =
        when (tx) {
            is JdbcTx -> {
                tx.afterCommit { notices.forEach { flow.tryEmit(it) } }
                Unit.right()
            }

            else -> {
                PersistenceFailure(OP, "JDBC のトランザクションではない").left()
            }
        }

    private companion object {
        const val OP = "notify.publish"
    }
}

/**
 * PostgreSQL 版: `pg_notify`（コミット時にだけ配信される）と、専用の LISTEN 接続（プールの外。1 本）。
 * LISTEN の接続が切れても、[reconnectMillis] 待って接続し直し、プロセスは落ちない（beer-game2 の B1 の学び #3）。
 * 切れている間は [isAlive] が false（/ready が見る）。切断中の通知の欠落を、`projection_checkpoints` の照合で補う処理は、
 * SSE（Step 9）と一緒に作る（未実装）。
 */
internal class PostgresChangeNotifier(
    private val connect: () -> Connection,
    private val reconnectMillis: Long,
    private val ioDispatcher: CoroutineDispatcher = Dispatchers.IO,
) : AutoCloseable {
    private val flow = versionFlow()
    private val listening = AtomicBoolean(false)
    private val ready = CountDownLatch(1)
    private val scope = CoroutineScope(SupervisorJob() + ioDispatcher)
    private val logger = System.getLogger("beergame.persistence.notifier")

    fun port(): ChangeNotifier = ChangeNotifier(::publish, { flow.asSharedFlow() }, { listening.get() })

    /** 受信ループを始め、最初の LISTEN ができるまで待つ（[timeoutMillis] で諦めても、ループは再接続を続ける）。 */
    fun start(timeoutMillis: Long) {
        scope.launch {
            while (isActive) {
                listenOnce { isActive }
                listening.set(false)
                delay(reconnectMillis)
            }
        }
        ready.await(timeoutMillis, TimeUnit.MILLISECONDS)
    }

    override fun close() = scope.cancel()

    private fun publish(
        tx: Tx,
        notices: List<VersionNotice>,
    ): Either<PersistenceFailure, Unit> =
        when (tx) {
            is JdbcTx -> notify(tx, notices)
            else -> PersistenceFailure(OP, "JDBC のトランザクションではない").left()
        }

    private fun notify(
        tx: JdbcTx,
        notices: List<VersionNotice>,
    ): Either<PersistenceFailure, Unit> =
        try {
            tx.connection.prepareStatement("SELECT pg_notify(?, ?)").use { ps ->
                notices.forEach {
                    ps.params().string(CHANNEL).string(NoticeFormat.encode(it))
                    ps.execute()
                }
            }
            Unit.right()
        } catch (e: SQLException) {
            PersistenceFailure(OP, "SQLSTATE=${e.sqlState}").left()
        }

    /** 接続して受信する。切れたら（SQLException）警告を出して戻る。呼び出し側のループが、待ってから再接続する。 */
    private fun listenOnce(active: () -> Boolean) {
        try {
            connect().use { listen(it, active) }
        } catch (e: SQLException) {
            logger.log(System.Logger.Level.WARNING, "LISTEN の接続が切れた。再接続する: SQLSTATE=${e.sqlState}")
        }
    }

    /** 受信のループ（ブロッキング。IO のディスパッチャーで動かす）。500 ミリ秒ごとにキャンセルと接続の生死を確かめる。 */
    private fun listen(
        connection: Connection,
        active: () -> Boolean,
    ) {
        connection.autoCommit = true
        connection.createStatement().use { it.execute("LISTEN $CHANNEL") }
        listening.set(true)
        ready.countDown()
        val pg = connection.unwrap(PGConnection::class.java)
        while (active()) {
            pg.getNotifications(POLL_MILLIS)?.forEach { n ->
                NoticeFormat.decode(n.parameter)?.let { flow.tryEmit(it) }
            }
            if (!connection.isValid(VALID_SECONDS)) throw SQLException("LISTEN の接続が無効", "08006")
        }
    }

    private companion object {
        const val OP = "notify.publish"
        const val CHANNEL = "beergame_versions"
        const val POLL_MILLIS = 500
        const val VALID_SECONDS = 2
    }
}
