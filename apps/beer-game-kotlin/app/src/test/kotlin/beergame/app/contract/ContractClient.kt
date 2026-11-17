package beergame.app.contract

import beergame.app.API
import beergame.app.array
import beergame.app.body
import beergame.app.callWith
import beergame.app.credential
import beergame.app.readText
import beergame.app.str
import io.kotest.assertions.fail
import io.ktor.client.HttpClient
import io.ktor.client.request.HttpRequestBuilder
import io.ktor.client.request.header
import io.ktor.client.statement.HttpResponse
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpMethod
import kotlinx.serialization.json.jsonObject

/*
 * 契約テストの呼び出しの道具。実物のルート（H2 の永続化つき）を呼び、返った応答を、そのつど仕様（OpenApiDocument）に照らす。
 * 違反があれば、その場で失敗にする（どの呼び出しで外れたかが、メッセージに残る）。
 */

private val ROLE_NAMES =
    mapOf(
        "FACTORY" to "工場の花子",
        "DISTRIBUTOR" to "一次卸の次郎",
        "WHOLESALER" to "二次卸の三郎",
        "RETAILER" to "小売の四郎",
    )

internal val ROLES = ROLE_NAMES.keys.toList()

internal const val KIT_GAME = """{"kind":"KIT","finalWeek":3,"demand":[4,999,998]}"""

internal class Player(
    val role: String,
    val cookie: String,
    val participantId: String,
    /** 復帰資格（Cookie `bg_recovery` の値）。 */
    val recovery: String = "placeholder-recovery",
)

internal class PlayedGame(
    val id: String,
    val facilitator: String,
    val joinCode: String,
    val players: Map<String, Player>,
    /** 進行役の復帰コード（作成の応答の `recoveryCode`）。 */
    val facilitatorCode: String = "placeholder-recovery",
    /** 発行した観察用の招待（B9）。招待の ID と、招待コード（発行の応答だけが運ぶ）。 */
    val invitationId: String = "00000000-0000-0000-0000-0000000000c1",
    val invitationCode: String = "placeholder-invitation",
    /** 招待で参加した観察者のブラウザセッション（B9）。 */
    val observer: String = "placeholder",
) {
    fun cookieOf(role: String): String = players.getValue(role).cookie
}

private fun HttpResponse.cookieValue(name: String): String? =
    headers
        .getAll(HttpHeaders.SetCookie)
        .orEmpty()
        .firstOrNull { it.startsWith("$name=") }
        ?.substringAfter("$name=")
        ?.substringBefore(";")

internal class ContractClient(
    private val client: HttpClient,
    val doc: OpenApiDocument,
) {
    private var keyCounter = 0

    private val seenOperations: MutableSet<String> = mutableSetOf()

    /** 観測した応答の `operationId 状態`（仕様の宣言との突き合わせと、網羅の確認に使う）。 */
    fun observed(): Set<String> = seenOperations.toSet()

    fun nextKey(): String = "contract-key-${++keyCounter}"

    /**
     * 応答を仕様に照らし、違反があれば失敗にする。返り値は、そのまま本文などを読める応答。
     * 変更系（GET 以外）には、[headers] に指定がなければ、新しい Idempotency-Key を付ける。[headers] はそのまま付ける（If-Match など）。
     */
    suspend fun send(
        method: HttpMethod,
        path: String,
        body: String? = null,
        cookie: String? = null,
        headers: Map<String, String> = emptyMap(),
    ): HttpResponse {
        val key = if (method == HttpMethod.Get || headers.containsKey(IDEMPOTENCY_KEY)) null else nextKey()
        val response =
            client.callWith(method, path, body) {
                key?.let { header(IDEMPOTENCY_KEY, it) }
                cookie?.let { header(HttpHeaders.Cookie, "bg_session=$it") }
                headers.forEach { (name, value) -> header(name, value) }
            }
        val seen = observe(method, path, response)
        val violations = doc.responseViolations(seen)
        if (violations.isNotEmpty()) {
            fail("契約違反: ${method.value} $API$path -> ${seen.status}\n" + violations.joinToString("\n") { "  - $it" })
        }
        doc.operationFor(seen.method, seen.path)?.let { seenOperations += "${it.id} ${seen.status}" }
        return response
    }

    /** 仕様に照らさずに呼ぶ（要求の適合の検査で、わざと仕様に反する要求を送るとき）。 */
    suspend fun sendRaw(
        method: HttpMethod,
        path: String,
        body: String? = null,
        cookie: String? = null,
        key: String? = nextKey(),
    ): HttpResponse =
        client.callWith(method, path, body) {
            key?.let { header(IDEMPOTENCY_KEY, it) }
            cookie?.let { header(HttpHeaders.Cookie, "bg_session=$it") }
        }

    suspend fun observe(
        method: HttpMethod,
        path: String,
        response: HttpResponse,
    ): ObservedResponse =
        ObservedResponse(
            method = method.value,
            path = path.substringBefore('?'),
            status = response.status.value,
            headers = response.headers.entries().associate { it.key.lowercase() to it.value },
            body = response.readText(),
        )

    // ---- ゲームの準備（どれも、応答を仕様に照らしながら進める）----

    suspend fun createGame(body: String = KIT_GAME): HttpResponse = send(HttpMethod.Post, "/games", body)

    /** 作成 → 4 人が参加 → 4 役割に割り当て（開始はしない）。 */
    suspend fun prepared(): PlayedGame {
        val created = createGame()
        val facilitator = checkNotNull(created.credential()) { "進行役の資格が発行されていない" }
        val id =
            checkNotNull(created.headers[HttpHeaders.Location]).removePrefix("$API/games/").removeSuffix("/state")
        val joinCode = send(HttpMethod.Get, "/games/$id/state", cookie = facilitator).body().str("joinCode")
        val joinedAs =
            ROLES.associateWith { role ->
                send(
                    HttpMethod.Post,
                    "/participations/join",
                    """{"joinCode":"$joinCode","displayName":"${ROLE_NAMES.getValue(role)}"}""",
                )
            }
        val cookies = joinedAs.mapValues { checkNotNull(it.value.credential()) { "参加者の資格が発行されていない" } }
        val participants = send(HttpMethod.Get, "/games/$id/lobby", cookie = facilitator).body().array("participants")
        val players =
            ROLES.associateWith { role ->
                val participantId =
                    participants
                        .map { it.jsonObject }
                        .first { it.str("displayName") == ROLE_NAMES.getValue(role) }
                        .str("participantId")
                send(
                    HttpMethod.Put,
                    "/games/$id/participants/$participantId/role",
                    """{"role":"$role"}""",
                    cookie = facilitator,
                )
                Player(
                    role,
                    cookies.getValue(role),
                    participantId,
                    checkNotNull(joinedAs.getValue(role).cookieValue("bg_recovery")),
                )
            }
        val invited = send(HttpMethod.Post, "/games/$id/observer-invitations", "{}", cookie = facilitator)
        val code = invited.body().str("invitationCode")
        val observer =
            send(
                HttpMethod.Post,
                "/participations/observe",
                """{"invitationCode":"$code","displayName":"見学の五郎"}""",
            )
        return PlayedGame(
            id,
            facilitator,
            joinCode,
            players,
            created.body().str("recoveryCode"),
            invited.body().str("invitationId"),
            code,
            checkNotNull(observer.credential()) { "観察者の資格が発行されていない" },
        )
    }

    suspend fun started(): PlayedGame =
        prepared().also { send(HttpMethod.Post, "/games/${it.id}/start", cookie = it.facilitator) }

    /** [role] が、第 1 週の数量 4 を最初に保存する（版は 0 から 1 になる）。 */
    suspend fun saveFirst(
        game: PlayedGame,
        role: String,
    ): HttpResponse =
        send(
            HttpMethod.Put,
            "/sessions/${game.id}/decisions",
            """{"week":1,"quantity":4}""",
            cookie = game.cookieOf(role),
        )

    /** 4 役割が第 1 週の数量 4 を保存して、進行役が第 1 週を確定する。 */
    suspend fun playFirstWeek(game: PlayedGame) {
        ROLES.forEach { saveFirst(game, it) }
        send(HttpMethod.Post, "/sessions/${game.id}/weeks/1/commit", commitBody(1, 1), cookie = game.facilitator)
    }
}

internal const val IDEMPOTENCY_KEY = "Idempotency-Key"
