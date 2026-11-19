package beergame.persistence

import arrow.core.Either
import beergame.application.AppFailure
import beergame.application.AttemptSource
import beergame.application.CommandOutcome
import beergame.application.CreateGameInput
import beergame.application.JoinGameInput
import beergame.application.Ports
import beergame.application.createGame
import beergame.application.joinGame
import beergame.application.sourceKey
import io.kotest.core.spec.style.FunSpec
import io.kotest.matchers.shouldBe
import io.kotest.matchers.string.shouldNotContain
import io.kotest.matchers.types.shouldBeInstanceOf
import kotlinx.coroutines.runBlocking

/** 試験ごとに別の接続元（同じ DB・同じ固定の時計の窓を共有するので、接続元で分ける）。 */
private val SHARED_SOURCE = AttemptSource.of("203.0.113.7")
private val UNCOUNTED_SOURCE = AttemptSource.of("203.0.113.8")
private val RAW_SOURCE = AttemptSource.of("203.0.113.9")
private val BYSTANDER = AttemptSource.of("198.51.100.9")
private val LIMIT = FLOW_ATTEMPT_POLICY.maxFailures

/** 参加コードを持つ新しいゲームを作り、参加コードを返す。 */
private fun Fixture.openGame(tag: String): String =
    runBlocking {
        val created = ports().createGame(CreateGameInput(3, listOf(4, 5, 6), 90), meta("create-$tag")).orFail()
        query("SELECT join_code FROM game_join_codes WHERE game_id = ?", created.gameId.value) {
            it.getString(1)
        }.single()
    }

private fun Ports.joinFrom(
    source: AttemptSource,
    code: String,
    key: String,
    name: String = "参加者",
): Either<AppFailure, CommandOutcome> = runBlocking { joinGame(JoinGameInput(code, name), meta(key, source = source)) }

private fun Ports.guess(
    source: AttemptSource,
    index: Int,
) = joinFrom(source, "JOIN-9${index.toString().padStart(3, '0')}", "guess-${source.hashCode()}-$index")

private fun AppFailure.code(): String? = (this as? AppFailure.Domain)?.error?.code

/** 実 DB の全表の全列を文字列にして集め、[needle] を含む表を返す。 */
private fun Fixture.tablesContaining(needle: String): List<String> {
    val tables =
        query(
            "SELECT table_name FROM information_schema.tables " +
                "WHERE table_schema = 'public' AND table_type = 'BASE TABLE'",
        ) { it.getString(1) }
    return tables.filter { table ->
        dataSource.connection.use { c ->
            c.createStatement().use { st ->
                st.executeQuery("SELECT * FROM $table").use { rs ->
                    val width = rs.metaData.columnCount
                    generateSequence {
                        if (rs.next()) {
                            (1..width).joinToString(
                                "|",
                            ) { rs.getString(it).orEmpty() }
                        } else {
                            null
                        }
                    }.any { needle in it }
                }
            }
        }
    }
}

/**
 * 参加の専用のレート制限を、実 DB の上で通す契約（B5 Step 5。NF-S11・NF-S19）。H2 と PostgreSQL の両方で実行する。
 * 窓は DB にあるので、別のインスタンス（別の Ports）が受けた失敗も合算される。生の接続元は、どの表にも残らない。
 */
fun FunSpec.attemptFlowContract(fixture: () -> Fixture) {
    test("[5.1][NF-S11] Given 2 つのインスタンスが同じ接続元の失敗を受ける When 合算で上限を超える Then 正しい参加コードでも RateLimited。別の接続元は参加できる") {
        val fx = fixture()
        val code = fx.openGame("limit")
        val instanceA = fx.ports()
        val instanceB = fx.ports()

        instanceA.guess(SHARED_SOURCE, 1).leftOrFail().code() shouldBe "game.invitation_invalid"
        instanceB.guess(SHARED_SOURCE, 2).leftOrFail().code() shouldBe "game.invitation_invalid"
        instanceA.guess(SHARED_SOURCE, 3).leftOrFail().code() shouldBe "game.invitation_invalid"

        val blocked = instanceB.joinFrom(SHARED_SOURCE, code, "b-blocked")
        blocked.leftOrFail() shouldBe AppFailure.RateLimited(FLOW_ATTEMPT_POLICY.window.seconds.toInt())
        instanceB.joinFrom(BYSTANDER, code, "bystander").orFail()
    }

    test("[5.1] Given 成功した参加と、入力の検証の失敗 When 上限を超えて繰り返す Then 窓に数えない（DB の数は 0 のまま）") {
        val fx = fixture()
        val code = fx.openGame("not-counted")
        val ports = fx.ports()
        val key = ports.settings.sourceKey(UNCOUNTED_SOURCE)

        repeat(LIMIT + 2) { i -> ports.joinFrom(UNCOUNTED_SOURCE, code, "ok-$i", "参加者$i").orFail() }
        repeat(LIMIT + 2) { i ->
            ports.joinFrom(UNCOUNTED_SOURCE, code, "bad-$i", "").leftOrFail().shouldBeInstanceOf<AppFailure.Invalid>()
        }

        fx.query("SELECT COALESCE(SUM(failure_count), 0) FROM participation_attempts WHERE key_digest = ?", key) {
            it.getInt(1)
        } shouldBe listOf(0)
    }

    test("[5.1][NF-S14] Given 失敗を記録した接続元 When 全表を調べる Then 生の接続元はどこにも無く、窓の鍵は鍵付き要約だけ") {
        val fx = fixture()
        fx.openGame("no-raw-source")
        val ports = fx.ports()
        val key = ports.settings.sourceKey(RAW_SOURCE)

        repeat(LIMIT) { i -> ports.guess(RAW_SOURCE, i).leftOrFail() }

        fx.tablesContaining("203.0.113.9") shouldBe emptyList()
        fx.query("SELECT failure_count FROM participation_attempts WHERE key_digest = ?", key) { it.getInt(1) } shouldBe
            listOf(LIMIT)
        key shouldNotContain "203.0.113.9"
    }
}
