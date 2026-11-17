package beergame.acceptance

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.util.UUID

/** 受け入れから見た 4 つの役割（業務の言葉）。[apiName] は API の値。 */
enum class Role(
    val label: String,
    val apiName: String,
) {
    RETAILER("小売店", "RETAILER"),
    WHOLESALER("二次卸", "WHOLESALER"),
    DISTRIBUTOR("一次卸", "DISTRIBUTOR"),
    FACTORY("工場", "FACTORY"),
    ;

    companion object {
        fun ofLabel(label: String): Role = entries.firstOrNull { it.label == label } ?: error("知らない役割: $label")

        fun ofApi(name: String): Role = entries.firstOrNull { it.apiName == name } ?: error("知らない役割の値: $name")
    }
}

/** HTTP の応答。本文は遅延して JSON にする。 */
class ApiResponse(
    val status: Int,
    private val headers: java.net.http.HttpHeaders,
    val text: String,
) {
    val json: JsonObject by lazy { Json.parseToJsonElement(text).jsonObject }

    fun header(name: String): String? = headers.firstValue(name).orElse(null)

    /** `Set-Cookie` の資格（bg_session）の値。 */
    fun credential(): String? =
        headers
            .allValues("Set-Cookie")
            .firstOrNull { it.startsWith("bg_session=") }
            ?.substringAfter("bg_session=")
            ?.substringBefore(";")

    /** problem+json の `code`。 */
    fun code(): String? = if (status >= HTTP_ERROR) json["code"]?.jsonPrimitive?.content else null

    /** `Set-Cookie` の復帰資格（bg_recovery）の値（判断項目 9 の案 A。B5 の提案）。 */
    fun recoveryCredential(): String? =
        headers
            .allValues("Set-Cookie")
            .firstOrNull { it.startsWith("bg_recovery=") }
            ?.substringAfter("bg_recovery=")
            ?.substringBefore(";")

    /** `Location`（`/api/v1/games/{gameId}/state`）から取り出したゲームの ID。 */
    fun createdGameId(): String? = header("Location")?.removePrefix("/api/v1/games/")?.removeSuffix("/state")

    companion object {
        const val HTTP_ERROR = 400
    }
}

fun JsonObject.text(name: String): String = getValue(name).jsonPrimitive.content

fun JsonObject.obj(name: String): JsonObject = getValue(name).jsonObject

fun JsonObject.array(name: String): JsonArray = getValue(name).jsonArray

fun JsonObject.number(name: String): Int = text(name).toInt()

/** 要求に添える、資格の Cookie（bg_session）と冪等キー以外の値。 */
data class RequestExtras(
    val recovery: String? = null,
    val ifMatch: String? = null,
)

/**
 * 受け入れが、アプリケーションに対して行う操作と問い合わせ。HTTP を呼ぶだけで、業務ロジックを持たない。
 * ステップ定義はこの窓口だけを呼ぶ（薄く保つ）。
 */
class GamePlayApi(
    private val baseUrl: String,
) {
    private val client = HttpClient.newHttpClient()

    fun newKey(): String = UUID.randomUUID().toString()

    private fun send(
        method: String,
        path: String,
        body: String?,
        cookie: String?,
        key: String?,
        extras: RequestExtras = RequestExtras(),
    ): ApiResponse {
        val builder = HttpRequest.newBuilder(URI.create("$baseUrl$path"))
        val cookies = listOfNotNull(cookie?.let { "bg_session=$it" }, extras.recovery?.let { "bg_recovery=$it" })
        if (cookies.isNotEmpty()) builder.header("Cookie", cookies.joinToString("; "))
        key?.let { builder.header("Idempotency-Key", it) }
        extras.ifMatch?.let { builder.header("If-Match", "\"$it\"") }
        val publisher =
            if (body == null) {
                HttpRequest.BodyPublishers.noBody()
            } else {
                builder.header("Content-Type", "application/json")
                HttpRequest.BodyPublishers.ofString(body)
            }
        val response = client.send(builder.method(method, publisher).build(), HttpResponse.BodyHandlers.ofString())
        return ApiResponse(response.statusCode(), response.headers(), response.body())
    }

    fun get(
        path: String,
        cookie: String? = null,
    ) = send("GET", path, null, cookie, null)

    fun post(
        path: String,
        body: String? = null,
        cookie: String? = null,
        key: String? = newKey(),
        extras: RequestExtras = RequestExtras(),
    ) = send("POST", path, body, cookie, key, extras)

    fun put(
        path: String,
        body: String,
        cookie: String? = null,
        key: String? = newKey(),
        extras: RequestExtras = RequestExtras(),
    ) = send("PUT", path, body, cookie, key, extras)

    // ---- ゲームの準備と参加 ----

    fun createGame(
        body: String,
        key: String = newKey(),
    ) = post("/games", body, key = key)

    fun gameState(
        gameId: String,
        cookie: String?,
    ) = get("/games/$gameId/state", cookie)

    fun lobby(
        gameId: String,
        cookie: String?,
    ) = get("/games/$gameId/lobby", cookie)

    fun join(
        joinCode: String,
        displayName: String,
    ) = post("/participations/join", """{"joinCode":"$joinCode","displayName":"$displayName"}""")

    fun assignRole(
        gameId: String,
        participantId: String,
        role: Role,
        facilitator: String?,
    ) = put("/games/$gameId/participants/$participantId/role", """{"role":"${role.apiName}"}""", facilitator)

    fun start(
        gameId: String,
        facilitator: String?,
    ) = post("/games/$gameId/start", cookie = facilitator)

    // ---- 1 週の進行 ----

    /** [quantityJson] は JSON の値そのもの（数値、文字列など）。形の誤りも送れるようにする。 */
    fun saveDecision(
        gameId: String,
        week: Int,
        quantityJson: String,
        participant: String?,
    ) = put("/sessions/$gameId/decisions", """{"week":$week,"quantity":$quantityJson}""", participant)

    fun commitBody(
        week: Int,
        basis: Map<Role, Int>,
    ): String =
        """{"requestedWeek":$week,"basis":{${basis.entries.joinToString(
            ",",
        ) { "\"${it.key.apiName}\":${it.value}" }}}}"""

    fun commitWeek(
        gameId: String,
        week: Int,
        body: String,
        facilitator: String?,
        key: String = newKey(),
    ) = post("/sessions/$gameId/weeks/$week/commit", body, facilitator, key)

    fun review(
        gameId: String,
        cookie: String?,
    ) = get("/games/$gameId/review", cookie)

    fun sessionState(
        gameId: String,
        cookie: String?,
        role: Role? = null,
    ) = get("/sessions/$gameId/state${role?.let { "?role=${it.apiName}" } ?: ""}", cookie)

    // ---- 継続と資格（B5。経路は contracts/openapi.yaml の提案） ----

    fun pause(
        gameId: String,
        facilitator: String?,
    ) = post("/sessions/$gameId/pause", cookie = facilitator)

    fun resume(
        gameId: String,
        facilitator: String?,
    ) = post("/sessions/$gameId/resume", cookie = facilitator)

    fun setCommitMode(
        gameId: String,
        mode: String,
        facilitator: String?,
    ) = put("/sessions/$gameId/commit-mode", """{"commitMode":"$mode"}""", facilitator)

    fun proxyDecision(
        gameId: String,
        role: Role,
        week: Int,
        quantity: Int,
        cookie: String?,
    ) = put(
        "/sessions/$gameId/proxy-decisions/${role.apiName}",
        """{"requestedWeek":$week,"quantity":$quantity}""",
        cookie,
    )

    /** 版つきの保存（同じ週に複数回保存するときは、直前の版を `If-Match` に付ける）。 */
    fun saveDecisionAt(
        gameId: String,
        week: Int,
        quantity: Int,
        version: Int,
        cookie: String?,
        key: String = newKey(),
    ) = put(
        "/sessions/$gameId/decisions",
        """{"week":$week,"quantity":$quantity}""",
        cookie,
        key,
        RequestExtras(ifMatch = version.toString()),
    )

    private fun subjectBody(participantId: String) = """{"subject":{"kind":"PARTICIPANT","id":"$participantId"}}"""

    fun revokeCredential(
        gameId: String,
        participantId: String,
        facilitator: String?,
    ) = post("/games/$gameId/credentials/revoke", subjectBody(participantId), facilitator)

    fun reissueCredential(
        gameId: String,
        participantId: String,
        facilitator: String?,
    ) = post("/games/$gameId/credentials/reissue", subjectBody(participantId), facilitator)

    /** 復帰。復帰資格は Cookie（[recovery]）か、本文の復帰コード（[recoveryCode]）で渡す。 */
    fun recover(
        gameId: String,
        recovery: String? = null,
        recoveryCode: String? = null,
        key: String = newKey(),
    ) = post(
        "/participations/recover",
        """{"gameId":"$gameId"${recoveryCode?.let { ",\"recoveryCode\":\"$it\"" } ?: ""}}""",
        key = key,
        extras = RequestExtras(recovery = recovery),
    )

    // ---- 運用 ----

    fun health() = get("/health")

    fun ready() = get("/ready")
}
