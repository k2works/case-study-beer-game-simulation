package beergame.app

import beergame.http.HttpDeps
import beergame.http.HttpSettings
import beergame.http.LEVEL_INFO
import beergame.http.LEVEL_WARN
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
import java.sql.Connection
import java.sql.DriverManager
import java.time.Instant
import java.util.Properties
import java.util.UUID

/*
 * 起動。設定 → 接続プール → （マイグレーション）→ 永続化のポート → Ktor の順に組み立てる。
 * 失敗は例外のまま呼び出し側（[runMain]）へ渡し、そこで記録して終了コードにする。
 */

private const val CONNECTION_TIMEOUT_MILLIS = 3_000L
private const val POOL_SIZE = 10
private const val H2_POOL_SIZE = 8
private const val SHUTDOWN_GRACE_MILLIS = 1_000L
private const val SHUTDOWN_TIMEOUT_MILLIS = 5_000L
private const val LISTEN_APPLICATION_NAME = "beergame-listen"

/** 起動済みの API。[close] で、受付を止め、接続を閉じる。 */
class RunningApi internal constructor(
    val port: Int,
    private val server: EmbeddedServer<*, *>,
    private val persistence: Persistence,
    private val dataSource: HikariDataSource,
) : AutoCloseable {
    override fun close() {
        server.stop(SHUTDOWN_GRACE_MILLIS, SHUTDOWN_TIMEOUT_MILLIS)
        persistence.close()
        dataSource.close()
    }
}

/** 運用記録（起動・停止・マイグレーション）。リクエストの外なので、相関 ID は起動ごとに作る。 */
internal fun operationalRecord(
    level: String,
    operation: String,
    result: String,
    message: String,
): LogRecord =
    LogRecord(
        timestamp = Instant.now().toString(),
        level = level,
        correlationId = UUID.randomUUID().toString(),
        operation = operation,
        result = result,
        status = 0,
        durationMillis = 0,
        message = message,
    )

internal fun openDataSource(database: DatabaseSettings): HikariDataSource =
    HikariDataSource(
        HikariConfig().apply {
            jdbcUrl = database.url
            if (database is DatabaseSettings.Postgres) {
                username = database.user
                password = database.password
            }
            maximumPoolSize = if (database is DatabaseSettings.Postgres) POOL_SIZE else H2_POOL_SIZE
            connectionTimeout = CONNECTION_TIMEOUT_MILLIS
        },
    )

internal fun dialectOf(database: DatabaseSettings): Dialect =
    when (database) {
        is DatabaseSettings.H2 -> Dialect.H2
        is DatabaseSettings.Postgres -> Dialect.POSTGRES
    }

/** 通知の受信用の専用の接続（プールの外）。PostgreSQL だけが使う。 */
private fun listenConnection(database: DatabaseSettings): (() -> Connection)? =
    (database as? DatabaseSettings.Postgres)?.let { postgres ->
        {
            val properties =
                Properties().apply {
                    setProperty("user", postgres.user)
                    setProperty("password", postgres.password)
                    setProperty("ApplicationName", LISTEN_APPLICATION_NAME)
                }
            DriverManager.getConnection(postgres.url, properties)
        }
    }

/** マイグレーションだけを適用する（起動モード `migrate`）。適用した件数を返す。 */
internal fun migrate(database: DatabaseSettings): Int =
    openDataSource(database).use { Migrations.migrate(it, dialectOf(database)) }

fun startApi(
    config: ServerConfig,
    logs: LogSink,
): RunningApi {
    val dataSource = openDataSource(config.database)
    val dialect = dialectOf(config.database)
    if (config.migrateOnStart) {
        val applied = Migrations.migrate(dataSource, dialect)
        logs.emit(operationalRecord(LEVEL_INFO, "migrate", "ok", "マイグレーションを適用しました（$applied 件）"))
    }
    val persistence =
        Persistence.open(
            dialect,
            dataSource,
            PersistenceConfig(config.secrets.responseKey),
            listenConnection(config.database),
        )
    val deps =
        HttpDeps(
            ports =
                appPorts(
                    persistence,
                    config.secrets,
                    config.maxAttempts,
                    tuning = Tuning.of(config),
                ),
            database = databaseProbe(dataSource),
            settings =
                HttpSettings(
                    allowedOrigins = config.allowedOrigins,
                    cookieSecure = config.app.env != AppEnv.Local,
                ),
            logs = logs,
        )
    val server = embeddedServer(Netty, port = config.port, host = config.host) { beerGameModule(deps) }
    server.start(wait = false)
    val port =
        runBlocking {
            server.engine
                .resolvedConnectors()
                .first()
                .port
        }
    logs.emit(startupRecord(config, port))
    return RunningApi(port, server, persistence, dataSource)
}

/** 起動した環境とデータベースの種類を記録する。H2 は警告（ローカル開発専用。守られない制約がある）。 */
private fun startupRecord(
    config: ServerConfig,
    port: Int,
): LogRecord {
    val h2 = config.app.dbKind == DbKind.H2
    val note = if (config.secrets.ephemeral) "、鍵は使い捨て（再起動で資格が無効になる）" else ""
    return operationalRecord(
        level = if (h2) LEVEL_WARN else LEVEL_INFO,
        operation = "startup",
        result = "started",
        message = "APP_ENV=${config.app.env.value} DB_KIND=${config.app.dbKind.value} port=$port$note",
    )
}
