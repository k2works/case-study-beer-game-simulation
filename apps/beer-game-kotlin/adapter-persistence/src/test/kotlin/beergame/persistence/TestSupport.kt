package beergame.persistence

import arrow.core.Either
import beergame.application.AppFailure
import beergame.application.Tx
import com.zaxxer.hikari.HikariConfig
import com.zaxxer.hikari.HikariDataSource
import io.kotest.assertions.fail
import java.sql.Connection
import java.sql.PreparedStatement
import java.sql.ResultSet
import java.util.UUID
import javax.sql.DataSource

/** 試験用の鍵（32 バイト。試験の外では使わない）。 */
val TEST_RESPONSE_KEY: ByteArray = ByteArray(32) { it.toByte() }

fun <A> Either<*, A>.orFail(): A =
    when (this) {
        is Either.Right -> value
        is Either.Left -> fail("Left だった: $value")
    }

fun <B> Either<B, *>.leftOrFail(): B =
    when (this) {
        is Either.Left -> value
        is Either.Right -> fail("Right だった: $value")
    }

/** 試験の道具。方言ごとの [DataSource] と、組み立てたポートの束と、素の SQL の確認用の関数を持つ。 */
class Fixture(
    val dialect: Dialect,
    val dataSource: DataSource,
    val persistence: Persistence,
) : AutoCloseable {
    suspend fun <A> tx(block: suspend (Tx) -> Either<AppFailure, A>): Either<AppFailure, A> =
        persistence.events.transaction(block)

    fun <T> query(
        sql: String,
        vararg params: Any?,
        map: (ResultSet) -> T,
    ): List<T> =
        dataSource.connection.use { c ->
            c.prepareStatement(sql).use { ps ->
                ps.bindAll(params)
                ps.executeQuery().use { rs -> generateSequence { if (rs.next()) map(rs) else null }.toList() }
            }
        }

    fun count(
        sql: String,
        vararg params: Any?,
    ): Int = query("SELECT COUNT(*) FROM $sql", *params) { it.getInt(1) }.single()

    fun execute(
        sql: String,
        vararg params: Any?,
    ): Int =
        dataSource.connection.use { c ->
            c.prepareStatement(sql).use { ps ->
                ps.bindAll(params)
                ps.executeUpdate()
            }
        }

    override fun close() {
        persistence.close()
        (dataSource as? AutoCloseable)?.close()
    }
}

private fun PreparedStatement.bindAll(params: Array<out Any?>) {
    params.forEachIndexed { i, p -> setObject(i + 1, p) }
}

/** H2（PostgreSQL モード）の、メモリ上の独立した DB を作る（ローカル開発と同じ接続の設定）。 */
fun h2DataSource(): HikariDataSource {
    val config =
        HikariConfig().apply {
            jdbcUrl = "jdbc:h2:mem:${UUID.randomUUID()};MODE=PostgreSQL;DATABASE_TO_LOWER=TRUE;DB_CLOSE_DELAY=-1"
            maximumPoolSize = 8
        }
    return HikariDataSource(config)
}

fun openFixture(
    dialect: Dialect,
    dataSource: DataSource,
    listenConnection: (() -> Connection)? = null,
    lockTimeoutMillis: Long = 300,
    listenReconnectMillis: Long = 300,
): Fixture {
    Migrations.migrate(dataSource, dialect)
    val persistence =
        Persistence.open(
            dialect,
            dataSource,
            PersistenceConfig(TEST_RESPONSE_KEY, lockTimeoutMillis, listenReconnectMillis),
            listenConnection,
        )
    return Fixture(dialect, dataSource, persistence)
}
