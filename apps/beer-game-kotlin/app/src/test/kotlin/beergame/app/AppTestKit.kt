package beergame.app

import beergame.application.AttemptPolicy
import beergame.application.Ports
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
import io.ktor.client.HttpClient
import io.ktor.client.request.HttpRequestBuilder
import io.ktor.client.request.header
import io.ktor.client.request.request
import io.ktor.client.request.setBody
import io.ktor.client.statement.HttpResponse
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.HttpMethod
import io.ktor.http.contentType
import io.ktor.server.testing.ApplicationTestBuilder
import io.ktor.server.testing.testApplication
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.sql.Connection
import java.time.Instant
import java.util.UUID
import java.util.concurrent.atomic.AtomicReference

/*
 * app の HTTP の試験の道具。実物の永続化（H2 の PostgreSQL モード）と、実物の application・HTTP を、本番と同じ組み立て
 * （[appPorts]）で通す。時計だけ差し替える。
 */

val T0: Instant = Instant.parse("2026-11-16T09:00:00Z")

/** 進められる時計。 */
class TestClock(
    start: Instant = T0,
) {
    private val current = AtomicReference(start)

    fun now(): Instant = current.get()

    fun advance(seconds: Long) {
        current.updateAndGet { it.plusSeconds(seconds) }
    }
}

/** 出力されたログを集める。 */
class CapturingLogs : LogSink {
    private val records = java.util.concurrent.CopyOnWriteArrayList<LogRecord>()

    override fun emit(record: LogRecord) {
        records += record
    }

    fun all(): List<LogRecord> = records.toList()

    /** 出力される形（1 行の JSON）に直した全文。秘密が含まれないことの検査に使う。 */
    fun text(): String = records.joinToString("\n") { it.toJsonLine() }
}

val TEST_SECRETS =
    Secrets(
        credentialKey = ByteArray(32) { (it + 1).toByte() },
        idempotencyKey = ByteArray(32) { (it + 2).toByte() },
        responseKey = ByteArray(32) { (it + 3).toByte() },
        ephemeral = false,
    )

fun h2TestDataSource(): HikariDataSource =
    HikariDataSource(
        HikariConfig().apply {
            jdbcUrl = "jdbc:h2:mem:${UUID.randomUUID()};MODE=PostgreSQL;DATABASE_TO_LOWER=TRUE;DB_CLOSE_DELAY=-1"
            maximumPoolSize = 8
            connectionTimeout = 1_000
        },
    )

/** 1 つの試験の世界。H2 の独立した DB、永続化、時計、ログの集め場所。 */
class World(
    val clock: TestClock = TestClock(),
    val logs: CapturingLogs = CapturingLogs(),
    maxAttempts: Int = 3,
    rateLimitPerMinute: Int = 100_000,
    attempts: AttemptPolicy = defaultAttemptPolicy(),
    val wrap: (Ports) -> Ports = { it },
) : AutoCloseable {
    val dataSource: HikariDataSource = h2TestDataSource()
    val persistence: Persistence

    init {
        Migrations.migrate(dataSource, Dialect.H2)
        persistence = Persistence.open(Dialect.H2, dataSource, PersistenceConfig(TEST_SECRETS.responseKey))
    }

    val settings =
        HttpSettings(
            allowedOrigins = setOf("http://localhost:5173"),
            cookieSecure = false,
            rateLimitPerMinute = rateLimitPerMinute,
        )
    val ports: Ports = wrap(appPorts(persistence, TEST_SECRETS, maxAttempts, clock::now, Tuning(attempts = attempts)))

    fun deps(): HttpDeps =
        HttpDeps(
            ports = ports,
            database = databaseProbe(dataSource),
            settings = settings,
            logs = logs,
            clock = clock::now,
        )

    fun execute(sql: String): Int = dataSource.connection.use { c -> c.createStatement().use { it.executeUpdate(sql) } }

    /** 表の行数。 */
    fun count(table: String): Int =
        dataSource.connection.use { connection -> firstInt(connection, "SELECT COUNT(*) FROM $table") }

    override fun close() {
        persistence.close()
        dataSource.close()
    }
}

private fun firstInt(
    connection: Connection,
    sql: String,
): Int =
    connection.createStatement().use { statement ->
        statement.executeQuery(sql).use { rows ->
            check(rows.next()) { "結果の行が無い: $sql" }
            rows.getInt(1)
        }
    }

fun withWorld(
    world: World = World(),
    block: suspend ApplicationTestBuilder.(World) -> Unit,
) = world.use { w ->
    testApplication {
        application { beerGameModule(w.deps()) }
        block(w)
    }
}

// ---- 呼び出しの道具 ----

const val API = "/api/v1"

fun json(text: String): JsonObject = Json.parseToJsonElement(text).jsonObject

fun JsonObject.str(name: String): String = getValue(name).jsonPrimitive.content

fun JsonObject.obj(name: String): JsonObject = getValue(name).jsonObject

/*
 * Ktor の suspend 関数を呼ぶだけの 2 つの土台（sendRequest、readText）は、`suspend fun` ではなく「suspend の関数型の値」にしてある。
 * detekt 1.23.8 は、Kotlin 2.4 でビルドされたライブラリ（Ktor）の suspend 関数の呼び出しを検出できず、`suspend` の修飾を
 * 冗長と誤判定する（`@Suppress` も設定の緩和も使わない。Step 7 の判断 #10 と同じ原因）。以降の補助は、この値を呼ぶ。
 */
val sendRequest: suspend HttpClient.(
    String,
    HttpRequestBuilder.() -> Unit,
) -> HttpResponse = { url, block -> request(url, block) }

val readText: suspend HttpResponse.() -> String = { bodyAsText() }

suspend fun HttpResponse.body(): JsonObject = json(readText())

/** 応答の `Set-Cookie` から、資格の値を取り出す。 */
fun HttpResponse.credential(): String? =
    headers
        .getAll("Set-Cookie")
        .orEmpty()
        .firstOrNull { it.startsWith("bg_session=") }
        ?.substringAfter("bg_session=")
        ?.substringBefore(";")

/** 資格（Cookie）と冪等キーを付けた要求。 */
suspend fun HttpClient.call(
    method: HttpMethod,
    path: String,
    body: String? = null,
    cookie: String? = null,
    key: String? = null,
): HttpResponse =
    callWith(method, path, body) {
        key?.let { header("Idempotency-Key", it) }
        cookie?.let { header("Cookie", "bg_session=$it") }
    }

/** 要求の組み立てを呼び出し側に任せる（If-Match、Origin など、追加のヘッダーを付けるとき）。 */
suspend fun HttpClient.callWith(
    method: HttpMethod,
    path: String,
    body: String? = null,
    configure: HttpRequestBuilder.() -> Unit,
): HttpResponse =
    sendRequest("$API$path") {
        this.method = method
        if (body != null) {
            contentType(ContentType.Application.Json)
            setBody(body)
        }
        configure()
    }

suspend fun HttpResponse.problemWithoutCorrelation(): String {
    val body = body()
    return JsonObject(body.filterKeys { it != "correlationId" }).toString()
}

fun JsonObject.array(name: String) = getValue(name).jsonArray
