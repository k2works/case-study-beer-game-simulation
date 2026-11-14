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
}
