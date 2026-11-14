package beergame.persistence

import beergame.application.ChangeNotifier
import beergame.application.EventStore
import beergame.application.IdempotencyStore
import beergame.application.ProjectionLock
import beergame.application.ProjectionWriter
import java.sql.Connection
import javax.sql.DataSource

/** 永続化の設定。[responseKey] は冪等記録の応答の暗号化の鍵（32 バイト。実運用は Secrets Manager から注入する）。 */
class PersistenceConfig(
    val responseKey: ByteArray,
    val lockTimeoutMillis: Long = DEFAULT_LOCK_TIMEOUT_MILLIS,
    val listenReconnectMillis: Long = DEFAULT_LISTEN_RECONNECT_MILLIS,
) {
    companion object {
        const val DEFAULT_LOCK_TIMEOUT_MILLIS = 5_000L
        const val DEFAULT_LISTEN_RECONNECT_MILLIS = 1_000L
    }
}

/** 再構築との直列化と、版の通知。方言ごとに実装が違う 2 つのポート。 */
class Coordination(
    val lock: ProjectionLock,
    val notifier: ChangeNotifier,
)

/** 永続化のポートの束。方言ごとの実装を、設定（[Dialect]）で選んで組み立てる。 */
class Persistence internal constructor(
    val dialect: Dialect,
    val events: EventStore,
    val projections: ProjectionWriter,
    val idempotency: IdempotencyStore,
    private val coordination: Coordination,
    private val onClose: () -> Unit,
) : AutoCloseable {
    val lock: ProjectionLock get() = coordination.lock
    val notifier: ChangeNotifier get() = coordination.notifier

    override fun close() = onClose()

    companion object {
        private const val LISTEN_READY_TIMEOUT_MILLIS = 10_000L

        /**
         * [dataSource] はマイグレーション済みであること。PostgreSQL では、通知の受信用の専用の接続（プールの外）を
         * [listenConnection] で作る（必須）。H2 では使わない（プロセス内のロックとイベント）。
         * PostgreSQL では、最初の LISTEN ができるまで（最大 10 秒）呼び出したスレッドで待つ。起動時に 1 回だけ呼ぶ。
         */
        fun open(
            dialect: Dialect,
            dataSource: DataSource,
            config: PersistenceConfig,
            listenConnection: (() -> Connection)? = null,
        ): Persistence {
            val events = JdbcEventStore(dialect, JdbcTransactionRunner(dataSource)).port()
            val idempotency = JdbcIdempotencyStore(dialect, ResponseCipher(config.responseKey)).port()
            val projections = JdbcProjectionWriter(dialect)
            return when (dialect) {
                Dialect.POSTGRES -> {
                    val connect = requireNotNull(listenConnection) { "PostgreSQL では、LISTEN 用の接続の作り方が要る" }
                    val notifier = PostgresChangeNotifier(connect, config.listenReconnectMillis)
                    notifier.start(LISTEN_READY_TIMEOUT_MILLIS)
                    val lock = PostgresProjectionLock(config.lockTimeoutMillis).port()
                    Persistence(
                        dialect,
                        events,
                        projections,
                        idempotency,
                        Coordination(lock, notifier.port()),
                        notifier::close,
                    )
                }

                Dialect.H2 -> {
                    val lock = LocalProjectionLock(config.lockTimeoutMillis).port()
                    Persistence(
                        dialect,
                        events,
                        projections,
                        idempotency,
                        Coordination(lock, LocalChangeNotifier().port()),
                    ) {}
                }
            }
        }
    }
}
