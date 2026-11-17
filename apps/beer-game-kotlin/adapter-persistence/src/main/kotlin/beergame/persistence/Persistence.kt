package beergame.persistence

import beergame.application.AttemptStore
import beergame.application.ChangeNotifier
import beergame.application.EventStore
import beergame.application.IdempotencyStore
import beergame.application.PeripheralStore
import beergame.application.ProjectionLock
import beergame.application.ProjectionReader
import beergame.application.ProjectionWriter
import beergame.application.Stores
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
    val stores: Stores,
    private val coordination: Coordination,
    private val onClose: () -> Unit,
) : AutoCloseable {
    val events: EventStore get() = stores.events
    val projections: ProjectionWriter get() = stores.project
    val idempotency: IdempotencyStore get() = stores.idempotency
    val peripheral: PeripheralStore get() = stores.peripheral
    val attempts: AttemptStore get() = stores.attempts
    val reader: ProjectionReader get() = stores.reader
    val lock: ProjectionLock get() = coordination.lock
    val notifier: ChangeNotifier get() = coordination.notifier

    override fun close() = onClose()

    companion object {
        private const val LISTEN_READY_TIMEOUT_MILLIS = 10_000L

        /**
         * [dataSource] はマイグレーション済みであること。PostgreSQL では、通知の受信用の専用の接続（プールの外）を
         * [listenConnection] で作る（必須）。H2 では使わない（プロセス内のロックとイベント）。
         * PostgreSQL では、最初の LISTEN ができるまで（最大 10 秒）呼び出したスレッドで待つ。起動時に 1 回だけ呼ぶ。
         * [observerDataSource] は、観察者の読み取り専用の接続プール（`beergame_observer` のロールに絞ったもの。B9）。無ければ [dataSource]。
         */
        fun open(
            dialect: Dialect,
            dataSource: DataSource,
            config: PersistenceConfig,
            observerDataSource: DataSource? = null,
            listenConnection: (() -> Connection)? = null,
        ): Persistence {
            val stores =
                Stores(
                    events = JdbcEventStore(dialect, JdbcTransactionRunner(dataSource)).port(),
                    project = JdbcProjectionWriter(dialect),
                    idempotency = JdbcIdempotencyStore(dialect, ResponseCipher(config.responseKey)).port(),
                    peripheral = JdbcPeripheralStore().port(),
                    attempts = JdbcAttemptStore().port(),
                    reader = JdbcProjectionReader(dataSource),
                    // 観察者の読み取りは、3 表だけを読む専用のポート。観察者用の接続プール（DB のロールを絞った）があれば、それを使う
                    observation = JdbcObservationReader(observerDataSource ?: dataSource),
                )
            return when (dialect) {
                Dialect.POSTGRES -> {
                    val connect = requireNotNull(listenConnection) { "PostgreSQL では、LISTEN 用の接続の作り方が要る" }
                    val notifier = PostgresChangeNotifier(connect, config.listenReconnectMillis)
                    notifier.start(LISTEN_READY_TIMEOUT_MILLIS)
                    val lock = PostgresProjectionLock(config.lockTimeoutMillis).port()
                    Persistence(dialect, stores, Coordination(lock, notifier.port()), notifier::close)
                }

                Dialect.H2 -> {
                    val lock = LocalProjectionLock(config.lockTimeoutMillis).port()
                    Persistence(dialect, stores, Coordination(lock, LocalChangeNotifier().port())) {}
                }
            }
        }
    }
}
