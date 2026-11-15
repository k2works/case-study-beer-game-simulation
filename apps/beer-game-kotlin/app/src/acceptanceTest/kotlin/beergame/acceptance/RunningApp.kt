package beergame.acceptance

import beergame.app.Secrets
import beergame.app.appPorts
import beergame.app.databaseProbe
import beergame.http.HttpDeps
import beergame.http.HttpSettings
import beergame.http.LogRecord
import beergame.http.LogSink
import beergame.http.beerGameModule
import beergame.persistence.Dialect
import beergame.persistence.Migrations
import beergame.persistence.Persistence
import beergame.persistence.PersistenceConfig
import com.zaxxer.hikari.HikariConfig
import com.zaxxer.hikari.HikariDataSource
import io.ktor.server.engine.EmbeddedServer
import io.ktor.server.engine.embeddedServer
import io.ktor.server.netty.Netty
import kotlinx.coroutines.runBlocking
import org.testcontainers.postgresql.PostgreSQLContainer
import java.sql.DriverManager
import java.time.OffsetDateTime
import java.util.UUID
import java.util.concurrent.CopyOnWriteArrayList

/*
 * 受け入れが通す「実物のアプリケーション」。Ktor（Netty）のサーバーを、本番と同じ組み立て（appPorts: application と adapter-persistence）で
 * シナリオごとに起動し、HTTP で呼ぶ。実行する DB は、システムプロパティ acceptance.db で選ぶ（postgres が正。h2 はローカルの経路）。
 * 時計と ID は本番と同じ（シナリオは、時刻や乱数の値に依存しない）。
 */

private const val KEY_BYTES = 32
private const val POOL_SIZE = 4
private const val CONNECTION_TIMEOUT_MILLIS = 3_000L
private const val SHUTDOWN_GRACE_MILLIS = 100L
private const val SHUTDOWN_TIMEOUT_MILLIS = 2_000L
private const val RATE_LIMIT_PER_MINUTE = 100_000
private const val MAX_ATTEMPTS = 5

/** 保存されたイベントの 1 件（監査履歴）。 */
class AuditRow(
    val eventType: String,
    val payload: String,
    val actorKind: String,
    val actorId: String?,
    val occurredAt: OffsetDateTime,
)

/** 期限を過去にできる資格の表。 */
enum class ExpirableTable(
    val expireSql: String,
) {
    CREDENTIALS("UPDATE credentials SET expires_at = ? WHERE game_id = ? AND subject_id = ?"),
    BROWSER_SESSIONS("UPDATE browser_sessions SET expires_at = ? WHERE game_id = ? AND actor_id = ?"),
}

private const val ROTATED_KEY_VERSION = 2
private const val ROTATED_KEY_SEED = 21

private const val AUDIT_SQL =
    "SELECT event_type, CAST(payload AS VARCHAR), actor_kind, CAST(actor_id AS VARCHAR), occurred_at " +
        "FROM events WHERE game_id = ? ORDER BY seq"

/** 受け入れが使う DB の種類。 */
enum class AcceptanceDb(
    val value: String,
) {
    POSTGRES("postgres"),
    H2("h2"),
    ;

    companion object {
        /** `acceptance.db`。未指定は PostgreSQL（受け入れの正）。 */
        fun selected(): AcceptanceDb {
            val raw = System.getProperty("acceptance.db") ?: POSTGRES.value
            return entries.firstOrNull { it.value == raw } ?: error("acceptance.db は postgres か h2: $raw")
        }
    }
}

/** 出力されたログを集める。 */
class CapturingLogs : LogSink {
    private val records = CopyOnWriteArrayList<LogRecord>()

    override fun emit(record: LogRecord) {
        records += record
    }

    fun all(): List<LogRecord> = records.toList()

    /** 出力される形（1 行の JSON）に直した全文。 */
    fun text(): String = records.joinToString("\n") { it.toJsonLine() }
}

/** PostgreSQL 18 のコンテナ。JVM で 1 つだけ起動し、シナリオ間で共有する（ゲームは ID と参加コードで独立している）。 */
private object SharedPostgres {
    val container: PostgreSQLContainer by lazy {
        PostgreSQLContainer("postgres:18-alpine").withDatabaseName("beergame_acceptance").also {
            it.start()
            Runtime.getRuntime().addShutdownHook(Thread { it.stop() })
            HikariDataSource(config(it)).use { pool -> Migrations.migrate(pool, Dialect.POSTGRES) }
        }
    }

    fun config(container: PostgreSQLContainer): HikariConfig =
        HikariConfig().apply {
            jdbcUrl = container.jdbcUrl
            username = container.username
            password = container.password
            maximumPoolSize = POOL_SIZE
            connectionTimeout = CONNECTION_TIMEOUT_MILLIS
        }
}

private fun secrets(): Secrets =
    Secrets(
        credentialKey = ByteArray(KEY_BYTES) { (it + 1).toByte() },
        idempotencyKey = ByteArray(KEY_BYTES) { (it + 2).toByte() },
        responseKey = ByteArray(KEY_BYTES) { (it + 3).toByte() },
        ephemeral = false,
    )

/** 1 つのシナリオのためのアプリケーション。[close] で、サーバーと接続を閉じる。 */
class RunningApp(
    val db: AcceptanceDb = AcceptanceDb.selected(),
) : AutoCloseable {
    val logs = CapturingLogs()
    val dataSource: HikariDataSource
    private val persistence: Persistence
    private var server: EmbeddedServer<*, *>
    private var secrets: Secrets = secrets()
    private val port: Int
    val baseUrl: String

    init {
        val dialect: Dialect
        when (db) {
            AcceptanceDb.POSTGRES -> {
                val container = SharedPostgres.container
                dialect = Dialect.POSTGRES
                dataSource = HikariDataSource(SharedPostgres.config(container))
                persistence =
                    Persistence.open(dialect, dataSource, PersistenceConfig(secrets.responseKey)) {
                        DriverManager.getConnection(container.jdbcUrl, container.username, container.password)
                    }
            }

            AcceptanceDb.H2 -> {
                dialect = Dialect.H2
                dataSource =
                    HikariDataSource(
                        HikariConfig().apply {
                            jdbcUrl =
                                "jdbc:h2:mem:${UUID.randomUUID()};MODE=PostgreSQL;DATABASE_TO_LOWER=TRUE;DB_CLOSE_DELAY=-1"
                            maximumPoolSize = POOL_SIZE * 2
                            connectionTimeout = CONNECTION_TIMEOUT_MILLIS
                        },
                    )
                Migrations.migrate(dataSource, dialect)
                persistence = Persistence.open(dialect, dataSource, PersistenceConfig(secrets.responseKey))
            }
        }
        clearAttemptWindows()
        server = startServer(secrets, 0)
        port =
            runBlocking {
                server.engine
                    .resolvedConnectors()
                    .first()
                    .port
            }
        baseUrl = "http://127.0.0.1:$port/api/v1"
    }

    /**
     * 参加・復帰の失敗の窓を空にする。PostgreSQL のコンテナはシナリオ間で共有し、接続元（127.0.0.1）も同じなので、
     * 前のシナリオの失敗が、次のシナリオの参加を止めないようにする（試験の分離。本番のコードではない）。
     */
    private fun clearAttemptWindows() {
        dataSource.connection.use { connection ->
            connection.createStatement().use { it.executeUpdate("DELETE FROM participation_attempts") }
        }
    }

    /** 本番と同じ組み立て（appPorts）でサーバーを起動する。[port] が 0 なら空いているポート。 */
    private fun startServer(
        secrets: Secrets,
        port: Int,
    ): EmbeddedServer<*, *> {
        val deps =
            HttpDeps(
                ports = appPorts(persistence, secrets, MAX_ATTEMPTS),
                database = databaseProbe(dataSource),
                settings =
                    HttpSettings(
                        allowedOrigins = setOf("http://localhost:5173"),
                        cookieSecure = false,
                        rateLimitPerMinute = RATE_LIMIT_PER_MINUTE,
                    ),
                logs = logs,
            )
        return embeddedServer(Netty, port = port, host = "127.0.0.1") { beerGameModule(deps) }.also {
            it.start(wait = false)
        }
    }

    /** 設定（鍵）を替えて、同じポート・同じ DB で再起動する（運営者の鍵の更新と同じ。設定は起動時に読む）。 */
    private fun restartWith(next: Secrets) {
        server.stop(SHUTDOWN_GRACE_MILLIS, SHUTDOWN_TIMEOUT_MILLIS)
        secrets = next
        server = startServer(next, port)
    }

    /** データベースへの接続を失わせる（接続プールを閉じる）。以降、接続の取得は失敗する。 */
    fun loseDatabase() = dataSource.close()

    /**
     * 保存されたイベントの記録（監査履歴）を、保存順に読む。API には監査履歴の読み出しが無いため、試験が保存先を直接読む（B5 Step 1）。
     * 読むだけで、書き込まない。
     */
    fun auditTrail(gameId: String): List<AuditRow> =
        dataSource.connection.use { connection ->
            connection.prepareStatement(AUDIT_SQL).use { statement ->
                statement.setObject(1, UUID.fromString(gameId))
                statement.executeQuery().use { rows ->
                    buildList {
                        while (rows.next()) {
                            add(
                                AuditRow(
                                    eventType = rows.getString(1),
                                    payload = rows.getString(2),
                                    actorKind = rows.getString(3),
                                    actorId = rows.getString(4),
                                    occurredAt = rows.getObject(5, OffsetDateTime::class.java),
                                ),
                            )
                        }
                    }
                }
            }
        }

    /**
     * 保存された資格の有効期限を過去にして、期限切れを再現する（時計を進める代わり）。
     * [table] は credentials（復帰資格）か browser_sessions（ブラウザセッション）。B1 は両方に同じダイジェストを書く。
     */
    fun expire(
        table: ExpirableTable,
        gameId: String,
        subjectId: String,
    ) {
        dataSource.connection.use { connection ->
            connection.prepareStatement(table.expireSql).use { statement ->
                statement.setObject(1, OffsetDateTime.now().minusDays(1))
                statement.setObject(2, UUID.fromString(gameId))
                statement.setObject(3, UUID.fromString(subjectId))
                statement.executeUpdate()
            }
        }
    }

    /**
     * 資格の署名鍵を新しい版へ更新する（運営者の操作）。現在の版を 2 にして、旧版（1）の鍵を残し、再起動する。
     * 旧版の資格は、期限まで有効のまま。
     */
    fun rotateCredentialKey() {
        val current = secrets
        restartWith(
            Secrets(
                credentialKey = ByteArray(KEY_BYTES) { (it + ROTATED_KEY_SEED).toByte() },
                idempotencyKey = current.idempotencyKey,
                responseKey = current.responseKey,
                ephemeral = false,
                credentialKeyVersion = ROTATED_KEY_VERSION,
                previousCredentialKeys = mapOf(current.credentialKeyVersion to current.credentialKey),
            ),
        )
    }

    /** 旧版の鍵を設定から外す（運営者の操作）。再起動する。旧版で発行した資格は、使えなくなる。 */
    fun dropOldCredentialKey() {
        val current = secrets
        restartWith(
            Secrets(
                credentialKey = current.credentialKey,
                idempotencyKey = current.idempotencyKey,
                responseKey = current.responseKey,
                ephemeral = false,
                credentialKeyVersion = current.credentialKeyVersion,
                previousCredentialKeys = emptyMap(),
            ),
        )
    }

    override fun close() {
        server.stop(SHUTDOWN_GRACE_MILLIS, SHUTDOWN_TIMEOUT_MILLIS)
        persistence.close()
        dataSource.close()
    }
}
