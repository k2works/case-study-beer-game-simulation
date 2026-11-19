package beergame.persistence

import beergame.application.AttemptScope
import beergame.application.AttemptWindow
import com.zaxxer.hikari.HikariConfig
import com.zaxxer.hikari.HikariDataSource
import io.kotest.assertions.throwables.shouldThrow
import io.kotest.core.spec.style.FunSpec
import io.kotest.matchers.collections.shouldContainExactlyInAnyOrder
import io.kotest.matchers.shouldBe
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import java.sql.SQLException
import java.time.Instant
import java.time.OffsetDateTime
import java.time.ZoneOffset
import java.util.UUID

private val WINDOW_START: Instant = Instant.parse("2026-11-16T09:00:00Z")
private const val CHECK_VIOLATION_POSTGRES = "23514"
private const val CHECK_VIOLATION_H2 = "23513"
private const val CONCURRENT_CHARGES = 24

/** 試験ごとに別の鍵（同じ DB を共有する試験の間で、行が混ざらない）。 */
private fun newWindow(
    scope: AttemptScope = AttemptScope.JOIN,
    start: Instant = WINDOW_START,
) = AttemptWindow(scope, "key-${UUID.randomUUID()}", start)

private suspend fun Fixture.charge(window: AttemptWindow): Int =
    tx { tx -> persistence.attempts.charge(tx, window) }.orFail()

private suspend fun Fixture.refund(window: AttemptWindow) =
    tx { tx -> persistence.attempts.refund(tx, window) }.orFail()

private suspend fun Fixture.purge(before: Instant) = tx { tx -> persistence.attempts.purge(tx, before) }.orFail()

private fun Fixture.storedCount(window: AttemptWindow): List<Int> =
    query(
        "SELECT failure_count FROM participation_attempts WHERE scope = ? AND key_digest = ? AND window_start = ?",
        window.scope.key,
        window.sourceKey,
        OffsetDateTime.ofInstant(window.start, ZoneOffset.UTC),
    ) { it.getInt(1) }

/**
 * 参加・復帰の窓（`participation_attempts`）の永続化の契約（B5 Step 5。NF-S11・NF-S19）。H2 と PostgreSQL の両方で実行する。
 * 窓の数は DB にあり、同じ DB を共有するインスタンス（接続プール）の間で合算される。
 */
fun FunSpec.attemptStoreContract(fixture: () -> Fixture) {
    attemptCountingContract(fixture)
    attemptSharedStateContract(fixture)
    attemptSchemaContract(fixture)
}

private fun FunSpec.attemptCountingContract(fixture: () -> Fixture) {
    test("[5.1 契約] Given 新しい窓 When 続けて charge する Then 1・2・3 と数えた値を返し、行に保存する") {
        val fx = fixture()
        val window = newWindow()

        listOf(fx.charge(window), fx.charge(window), fx.charge(window)) shouldBe listOf(1, 2, 3)

        fx.storedCount(window) shouldBe listOf(3)
    }

    test("[5.1 契約] Given 窓の違い（種別・鍵・開始時刻）When charge する Then それぞれ別に数える") {
        val fx = fixture()
        val join = newWindow()
        fx.charge(join)
        fx.charge(join)

        fx.charge(join.copy(scope = AttemptScope.RECOVER)) shouldBe 1
        fx.charge(join.copy(sourceKey = "other-${UUID.randomUUID()}")) shouldBe 1
        fx.charge(join.copy(start = WINDOW_START.plusSeconds(600))) shouldBe 1
        fx.charge(join) shouldBe 3
    }

    test("[5.1 契約] Given 数えた窓 When refund する Then 1 つ減る。0 より下には減らず、行の無い窓の refund は何もしない") {
        val fx = fixture()
        val window = newWindow()
        fx.charge(window)
        fx.charge(window)

        fx.refund(window)
        fx.storedCount(window) shouldBe listOf(1)
        fx.refund(window)
        fx.refund(window)
        fx.storedCount(window) shouldBe listOf(0)
        fx.refund(newWindow())
        fx.charge(window) shouldBe 1
    }

    test("[5.1 契約] Given 古い窓と新しい窓 When purge する Then 指定した時刻より前の窓だけが消える") {
        val fx = fixture()
        val old = newWindow(start = WINDOW_START.minusSeconds(1_200))
        val boundary = newWindow(start = WINDOW_START)
        val later = newWindow(start = WINDOW_START.plusSeconds(600))
        listOf(old, boundary, later).forEach { fx.charge(it) }

        fx.purge(WINDOW_START)

        fx.storedCount(old) shouldBe emptyList()
        fx.storedCount(boundary) shouldBe listOf(1)
        fx.storedCount(later) shouldBe listOf(1)
    }
}

private fun FunSpec.attemptSharedStateContract(fixture: () -> Fixture) {
    test("[5.1 契約] Given 同じ窓への同時の charge When 並行に実行する Then 数え落としも重複もなく、1 からの連番になる") {
        val fx = fixture()
        val window = newWindow()

        val counts =
            coroutineScope {
                // JDBC の待ちは、トランザクションの実行側（IO のディスパッチャー）にあるので、すべての呼び出しが同時に進む
                (1..CONCURRENT_CHARGES).map { async { fx.charge(window) } }.awaitAll()
            }

        counts shouldContainExactlyInAnyOrder (1..CONCURRENT_CHARGES).toList()
        fx.storedCount(window) shouldBe listOf(CONCURRENT_CHARGES)
    }

    test("[5.1 契約][NF-S11] Given 同じ DB を共有する 2 つの接続プール（2 つのインスタンス）When 交互に charge する Then 数は合算される") {
        val fx = fixture()
        val base = fx.dataSource as HikariDataSource
        val other =
            HikariDataSource(
                HikariConfig().apply {
                    jdbcUrl = base.jdbcUrl
                    username = base.username
                    password = base.password
                    maximumPoolSize = 4
                },
            )
        try {
            val second = JdbcAttemptStore().port()
            val secondRunner = JdbcTransactionRunner(other)
            val window = newWindow()

            fx.charge(window) shouldBe 1
            secondRunner { tx -> second.charge(tx, window) }.orFail() shouldBe 2
            fx.charge(window) shouldBe 3
            secondRunner { tx -> second.charge(tx, window) }.orFail() shouldBe 4

            fx.storedCount(window) shouldBe listOf(4)
        } finally {
            other.close()
        }
    }
}

private fun FunSpec.attemptSchemaContract(fixture: () -> Fixture) {
    test("[5.1 契約] Given 窓の表 When 負の数・未知の種別を直接書く Then 制約で拒否される") {
        val fx = fixture()

        val negative =
            shouldThrow<SQLException> {
                fx.execute("INSERT INTO participation_attempts VALUES ('join', 'k-negative', ?, -1)", windowTimestamp())
            }
        val unknownScope =
            shouldThrow<SQLException> {
                fx.execute("INSERT INTO participation_attempts VALUES ('bogus', 'k-scope', ?, 0)", windowTimestamp())
            }

        // 制約の違反の SQLSTATE は、PostgreSQL が 23514、H2 が 23513
        val expected = if (fx.dialect == Dialect.POSTGRES) CHECK_VIOLATION_POSTGRES else CHECK_VIOLATION_H2
        negative.sqlState shouldBe expected
        unknownScope.sqlState shouldBe expected
    }

    test("[5.1 契約] Given 窓の表 When 列を調べる Then 接続元の生の値を入れる列が無い（種別・鍵の要約・窓の開始・数だけ）") {
        val fx = fixture()

        val columns =
            fx.query(
                "SELECT column_name FROM information_schema.columns WHERE table_name = 'participation_attempts'",
            ) { it.getString(1).lowercase() }

        columns shouldContainExactlyInAnyOrder listOf("scope", "key_digest", "window_start", "failure_count")
    }
}

private fun windowTimestamp(): OffsetDateTime = OffsetDateTime.ofInstant(WINDOW_START, ZoneOffset.UTC)
