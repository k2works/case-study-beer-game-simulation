package beergame.app

import arrow.core.getOrElse
import beergame.application.AttemptPolicy
import beergame.http.HttpDeps
import beergame.http.HttpSettings
import beergame.persistence.Dialect
import beergame.persistence.Migrations
import beergame.persistence.Persistence
import beergame.persistence.PersistenceConfig
import com.zaxxer.hikari.HikariConfig
import com.zaxxer.hikari.HikariDataSource
import io.ktor.client.HttpClient
import io.ktor.client.request.header
import io.ktor.http.HttpMethod
import io.ktor.http.HttpStatusCode
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.serialization.json.jsonObject
import org.testcontainers.postgresql.PostgreSQLContainer
import java.io.File
import java.sql.DriverManager
import java.time.Duration
import java.util.concurrent.CopyOnWriteArrayList

/*
 * B15: 性能の計測の道具（NF-P1・P3・P8〜P10・P13〜P15・P18・P19、NF-C1・C2）。
 * 実 PostgreSQL 18（Testcontainers）の上で、インプロセスの Ktor（テストホスト）を HTTP で呼ぶ。
 * **ネットワーク・ブラウザ・SSE・複数のタスク・実環境（ECS・RDS・ALB）を含まない。** ローカルの値で、実環境の値ではない。
 * 既定は縮小した規模（毎回の統合テスト）。環境変数 `BEERGAME_MEASURE=1` で、NFR の規模（全規模）で測る。
 * 結果は `build/reports/performance-measurement.md` に書く。
 */

private const val POOL_SIZE = 10
private const val MAX_ATTEMPTS = 10
private const val CONNECTION_TIMEOUT_MILLIS = 10_000L
private const val UNLIMITED_RATE = 100_000_000
private const val RELAXED_ATTEMPT_FAILURES = 1_000_000
private const val SERVER_ERROR_STATUS = 500
private const val STACK_LINES = 6
private const val POOL_SAMPLE_MILLIS = 20L
private const val NANOS_PER_MILLI = 1_000_000L
private const val PERCENTILE_MIN_SAMPLES = 20
val ROLE_NAMES: List<String> = listOf("FACTORY", "DISTRIBUTOR", "WHOLESALER", "RETAILER")

/** 計測の規模。 */
data class Scale(
    val label: String,
    val loadGames: Int,
    val loadWeeks: Int,
    val exportRuns: Int,
    val replayRuns: Int,
    val rebuildRuns: Int,
    val manyGames: Int,
    val manyGameWeeks: Int,
    val longWeeks: Int,
) {
    companion object {
        /** 毎回の統合テスト用（縮小。上限は NFR と同じだが、標本が少なく p95 は参考値）。 */
        val CI =
            Scale(
                "縮小（CI）",
                loadGames = 15,
                loadWeeks = 4,
                exportRuns = 20,
                replayRuns = 30,
                rebuildRuns = 15,
                manyGames = 10,
                manyGameWeeks = 10,
                longWeeks = 20,
            )

        /** NFR の規模。 */
        val FULL =
            Scale(
                "全規模（NFR）",
                loadGames = 15,
                loadWeeks = 30,
                exportRuns = 100,
                replayRuns = 100,
                rebuildRuns = 100,
                manyGames = 100,
                manyGameWeeks = 50,
                longWeeks = 50,
            )

        fun current(): Scale = if (System.getenv("BEERGAME_MEASURE") == "1") FULL else CI
    }
}

/**
 * 参加・復帰の試行の窓（NF-S11。接続元ごと）を、計測では緩める。75 の利用者が 1 つの接続元（テストホスト）から参加するため、
 * 既定の窓にかかる（本番では、利用者ごとに接続元が違う）。**この計測は、参加・復帰の制限を含まない。**
 */
private fun relaxedAttempts(): AttemptPolicy =
    AttemptPolicy.of(RELAXED_ATTEMPT_FAILURES, Duration.ofMinutes(1)).getOrElse { error(it) }

/** 実 PostgreSQL の上の、本番と同じ組み立て（時計は実時間）。 */
class PostgresEnv(
    container: PostgreSQLContainer,
) : AutoCloseable {
    val dataSource =
        HikariDataSource(
            HikariConfig().apply {
                jdbcUrl = container.jdbcUrl
                username = container.username
                password = container.password
                maximumPoolSize = POOL_SIZE
                connectionTimeout = CONNECTION_TIMEOUT_MILLIS
            },
        )
    val persistence: Persistence

    init {
        Migrations.migrate(dataSource, Dialect.POSTGRES)
        persistence =
            Persistence.open(Dialect.POSTGRES, dataSource, PersistenceConfig(TEST_SECRETS.responseKey)) {
                DriverManager.getConnection(container.jdbcUrl, container.username, container.password)
            }
    }

    val logs = CapturingLogs()

    val deps =
        HttpDeps(
            ports =
                appPorts(
                    persistence,
                    TEST_SECRETS,
                    maxAttempts = MAX_ATTEMPTS,
                    tuning = Tuning(attempts = relaxedAttempts()),
                ),
            database = databaseProbe(dataSource),
            settings =
                HttpSettings(
                    setOf("http://localhost:5173"),
                    cookieSecure = false,
                    rateLimitPerMinute = UNLIMITED_RATE,
                ),
            logs = logs,
        )

    /**
     * [block] の間、接続プール（HikariCP）の使用状況を [POOL_SAMPLE_MILLIS] ミリ秒ごとに見て、最大値を返す。
     * 使用率は、キャパシティのアラーム（NF-C5。70%・80%）の閾値の見直しの材料。
     */
    suspend fun <T> samplingPool(block: suspend () -> T): Pair<T, String> =
        coroutineScope {
            var maxActive = 0
            var maxWaiting = 0
            val sampler =
                launch(Dispatchers.Default) {
                    val pool = dataSource.hikariPoolMXBean
                    while (isActive) {
                        maxActive = maxOf(maxActive, pool.activeConnections)
                        maxWaiting = maxOf(maxWaiting, pool.threadsAwaitingConnection)
                        delay(POOL_SAMPLE_MILLIS)
                    }
                }
            val result = block()
            sampler.cancelAndJoin()
            result to "接続プールの使用中の最大 $maxActive / $POOL_SIZE、接続を待つスレッドの最大 $maxWaiting"
        }

    /** サーバーエラー（5xx）の記録を、報告に残す（計測の最中に起きた本物の障害の手がかり）。 */
    fun recordServerErrors(scale: Scale) {
        val errors = logs.all().filter { it.status >= SERVER_ERROR_STATUS }
        if (errors.isNotEmpty()) {
            val first = errors.first()
            PerformanceReport.record(
                "サーバーエラー（5xx）",
                scale,
                "${errors.size} 件。最初: ${first.operation} ${first.status} ${first.errorType} ${first.message} " +
                    first.stack
                        .orEmpty()
                        .take(STACK_LINES)
                        .joinToString(" / "),
            )
        }
    }

    override fun close() {
        persistence.close()
        dataSource.close()
    }
}

/** 計測した時間（ミリ秒）の集まり。複数の並行の書き手から追加できる。 */
class Latencies {
    private val values = CopyOnWriteArrayList<Long>()
    private val failures = CopyOnWriteArrayList<String>()

    fun add(millis: Long) {
        values += millis
    }

    fun fail(reason: String) {
        failures += reason
    }

    val count: Int get() = values.size
    val failed: Int get() = failures.size
    val firstFailure: String? get() = failures.firstOrNull()

    fun percentile(p: Double): Long {
        val sorted = values.sorted()
        return sorted[(kotlin.math.ceil(p * sorted.size).toInt() - 1).coerceIn(0, sorted.size - 1)]
    }

    val max: Long get() = values.maxOrNull() ?: 0L

    /** 標本が少ないときは、p95 を言わず、最大値を示す。 */
    fun summary(): String =
        if (count >= PERCENTILE_MIN_SAMPLES) {
            "標本 $count、p50 ${percentile(0.5)} ms、p95 ${percentile(0.95)} ms、" +
                "p99 ${percentile(0.99)} ms、最大 $max ms、失敗 $failed"
        } else {
            "標本 $count（少ないので p95 は言わない）、最大 $max ms、失敗 $failed"
        }
}

/** 結果の表。テストの終了時に、ファイルへ書く。 */
object PerformanceReport {
    private val rows = CopyOnWriteArrayList<String>()

    fun record(
        id: String,
        scale: Scale,
        result: String,
    ) {
        rows += "| $id | ${scale.label} | $result |"
        System.err.println("[B15/$id] ${scale.label}: $result")
    }

    fun write() {
        File("build/reports").mkdirs()
        File("build/reports/performance-measurement.md").writeText(
            "| 項目 | 規模 | 結果（ローカルの PostgreSQL・インプロセスの Ktor。実環境の値ではない） |\n| :--- | :--- | :--- |\n" +
                rows.joinToString("\n") + "\n",
        )
    }
}

/** 呼び出しの時間（ミリ秒）を測る。 */
suspend fun <T> measured(block: suspend () -> T): Pair<T, Long> {
    val start = System.nanoTime()
    val result = block()
    return result to (System.nanoTime() - start) / NANOS_PER_MILLI
}

/** [items] を、それぞれ別のコルーチンで同時に実行する。 */
suspend fun <T, R> concurrently(
    items: List<T>,
    block: suspend CoroutineScope.(T) -> R,
): List<R> = coroutineScope { items.map { async(Dispatchers.Default) { block(it) } }.awaitAll() }

/** 1 ゲーム（4 役割・進行役）。 */
class Table(
    val gameId: String,
    val facilitator: String,
    val players: Map<String, String>,
)

/** 作成・参加・割り当て・開始までを行う。 */
suspend fun HttpClient.newTable(
    tag: String,
    finalWeek: Int,
    commitMode: String = "MANUAL",
): Table {
    val demand = List(finalWeek) { 4 }.joinToString(",")
    val created =
        call(
            HttpMethod.Post,
            "/games",
            """{"kind":"KIT","finalWeek":$finalWeek,"demand":[$demand],"commitMode":"$commitMode"}""",
            key = "$tag-create",
        )
    check(created.status == HttpStatusCode.Created) { "作成に失敗: ${created.status}" }
    val facilitator = checkNotNull(created.credential())
    val id = checkNotNull(created.headers["Location"]).removePrefix("$API/games/").removeSuffix("/state")
    val joinCode = call(HttpMethod.Get, "/games/$id/state", cookie = facilitator).body().str("joinCode")
    val players =
        ROLE_NAMES.associateWith { role ->
            val joined =
                call(
                    HttpMethod.Post,
                    "/participations/join",
                    """{"joinCode":"$joinCode","displayName":"参加者-$role"}""",
                    key = "$tag-join-$role",
                )
            val detail = if (joined.status == HttpStatusCode.OK) "" else joined.readText()
            checkNotNull(joined.credential()) { "参加に失敗: $role ${joined.status} $detail" }
        }
    val lobby = call(HttpMethod.Get, "/games/$id/lobby", cookie = facilitator).body().array("participants")
    ROLE_NAMES.forEach { role ->
        val participant =
            lobby.map { it.jsonObject }.first { it.str("displayName") == "参加者-$role" }.str("participantId")
        val assigned =
            call(
                HttpMethod.Put,
                "/games/$id/participants/$participant/role",
                """{"role":"$role"}""",
                cookie = facilitator,
                key = "$tag-assign-$role",
            )
        check(assigned.status == HttpStatusCode.OK) { "割り当てに失敗: $role ${assigned.status}" }
    }
    val started = call(HttpMethod.Post, "/games/$id/start", cookie = facilitator, key = "$tag-start")
    check(started.status == HttpStatusCode.OK) { "開始に失敗: ${started.status}" }
    return Table(id, facilitator, players)
}

/** 1 役割が、当週の数量を保存する（[version] は保存済みの回数。`If-Match`）。成功は時間、失敗は null（理由は [into] に残す）。 */
suspend fun HttpClient.save(
    table: Table,
    role: String,
    week: Int,
    version: Int,
    into: Latencies,
    key: String,
) {
    val (response, millis) =
        measured {
            callWith(
                HttpMethod.Put,
                "/sessions/${table.gameId}/decisions",
                """{"week":$week,"quantity":${4 + version % 3}}""",
            ) {
                header("Idempotency-Key", key)
                header("If-Match", version.toString())
                header("Cookie", "bg_session=${table.players.getValue(role)}")
            }
        }
    if (response.status ==
        HttpStatusCode.OK
    ) {
        into.add(millis)
    } else {
        into.fail("save $role w$week v$version -> ${response.status}")
    }
}

/** 週を確定する。basis は、各役割の保存済みの回数。 */
suspend fun HttpClient.commit(
    table: Table,
    week: Int,
    versions: Int,
    into: Latencies,
    key: String,
) {
    val basis = ROLE_NAMES.joinToString(",") { "\"$it\":$versions" }
    val (response, millis) =
        measured {
            call(
                HttpMethod.Post,
                "/sessions/${table.gameId}/weeks/$week/commit",
                """{"requestedWeek":$week,"basis":{$basis}}""",
                cookie = table.facilitator,
                key = key,
            )
        }
    if (response.status == HttpStatusCode.OK) into.add(millis) else into.fail("commit w$week -> ${response.status}")
}

/** 状態の取得（役割別）。 */
suspend fun HttpClient.readState(
    table: Table,
    cookie: String,
    into: Latencies,
) {
    val (response, millis) = measured { call(HttpMethod.Get, "/sessions/${table.gameId}/state", cookie = cookie) }
    if (response.status == HttpStatusCode.OK) into.add(millis) else into.fail("state -> ${response.status}")
}

/** 任意の GET の時間。 */
suspend fun HttpClient.timedGet(
    path: String,
    cookie: String,
    into: Latencies,
) {
    val (response, millis) = measured { call(HttpMethod.Get, path, cookie = cookie) }
    if (response.status == HttpStatusCode.OK) into.add(millis) else into.fail("GET $path -> ${response.status}")
}

/** 冪等キーつきの要求（停止・再開など）の時間。 */
suspend fun HttpClient.timed(
    method: HttpMethod,
    path: String,
    cookie: String,
    into: Latencies,
    key: String,
) {
    val (response, millis) = measured { call(method, path, cookie = cookie, key = key) }
    if (response.status == HttpStatusCode.OK) into.add(millis) else into.fail("$method $path -> ${response.status}")
}

/** [weeks] 週を、各役割 [savesPerRole] 回の保存と確定で進める（1 ゲーム。順に）。 */
suspend fun HttpClient.playWeeks(
    table: Table,
    weeks: IntRange,
    savesPerRole: Int,
    saves: Latencies,
    commits: Latencies,
) {
    for (week in weeks) {
        for (version in 0 until savesPerRole) {
            ROLE_NAMES.forEach { role ->
                save(table, role, week, version, saves, "${table.gameId}-$week-$role-$version")
            }
        }
        commit(table, week, savesPerRole, commits, "${table.gameId}-commit-$week")
    }
}
