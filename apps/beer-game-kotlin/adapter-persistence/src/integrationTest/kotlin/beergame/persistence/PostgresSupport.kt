package beergame.persistence

import com.zaxxer.hikari.HikariConfig
import com.zaxxer.hikari.HikariDataSource
import org.testcontainers.postgresql.PostgreSQLContainer
import java.sql.Connection
import java.sql.DriverManager

/** 統合テスト用の PostgreSQL 18（Testcontainers）。専用のコンテナで、接続先がそのコンテナであることを検査する。 */
object PostgresSupport {
    const val IMAGE = "postgres:18-alpine"
    const val LISTEN_APPLICATION_NAME = "beergame-listen"

    val container: PostgreSQLContainer by lazy {
        PostgreSQLContainer(IMAGE).withDatabaseName("beergame_test").also { it.start() }
    }

    private fun jdbcUrl(applicationName: String? = null): String {
        val base = container.jdbcUrl
        check(base.contains(container.host) && base.contains(container.firstMappedPort.toString())) {
            "接続先がテスト用のコンテナではない: $base"
        }
        return if (applicationName == null) base else "$base&ApplicationName=$applicationName"
    }

    fun dataSource(maxPoolSize: Int = 12): HikariDataSource =
        HikariDataSource(
            HikariConfig().apply {
                jdbcUrl = jdbcUrl()
                username = container.username
                password = container.password
                maximumPoolSize = maxPoolSize
            },
        )

    fun listenConnection(): () -> Connection =
        { DriverManager.getConnection(jdbcUrl(LISTEN_APPLICATION_NAME), container.username, container.password) }

    /** 同じコンテナの別のデータベースへの URL（ロールは、クラスタ全体で共有される）。 */
    private fun jdbcUrlFor(database: String): String = jdbcUrl().replace("/${container.databaseName}", "/$database")

    /** コンテナの所有者（スーパーユーザー）で接続する。ロールの検査は、`SET ROLE` で切り替えて行う。 */
    fun connectionTo(database: String = container.databaseName): Connection =
        DriverManager.getConnection(jdbcUrlFor(database), container.username, container.password)

    /** 空の専用データベースを作る（再作成）。 */
    fun recreateDatabase(database: String) {
        connectionTo().use { c ->
            c.createStatement().use {
                it.execute("DROP DATABASE IF EXISTS $database WITH (FORCE)")
                it.execute("CREATE DATABASE $database")
            }
        }
    }

    /** [database] へ接続のたびに `SET ROLE` する接続プール（用途別のプール。本番の `DB_DELETER_ROLE` と同じ仕組み）。 */
    fun dataSourceAs(
        database: String,
        role: String,
    ): HikariDataSource =
        HikariDataSource(
            HikariConfig().apply {
                jdbcUrl = jdbcUrlFor(database)
                username = container.username
                password = container.password
                maximumPoolSize = 2
                connectionInitSql = "SET ROLE $role"
            },
        )

    fun dataSourceFor(database: String): HikariDataSource =
        HikariDataSource(
            HikariConfig().apply {
                jdbcUrl = jdbcUrlFor(database)
                username = container.username
                password = container.password
                maximumPoolSize = 4
            },
        )
}
