package beergame.http

import arrow.core.Either
import arrow.core.getOrElse
import io.ktor.http.HttpStatusCode
import io.ktor.server.routing.Route
import io.ktor.server.routing.get
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

private const val PROBE_TIMEOUT_MILLIS = 3_000L

private fun statusBody(status: String): JsonObject = buildJsonObject { put("status", status) }

/**
 * `GET /health`（生存。何も確認しない）と `GET /ready`（準備。`SELECT 1` と接続プールの取得、通知の受信の生存）。
 * 負荷分散には `/ready` を使う（AC6.1.4）。準備できていない 503 は、`type`（`/problems/app.not_ready`）を持つ。
 */
internal fun Route.operationalRoutes(deps: HttpDeps) {
    get("/health") {
        call.operation("getHealth")
        call.respondJson(HttpStatusCode.OK, statusBody("ok"))
    }
    get("/ready") {
        call.operation("getReady")
        val database = probe { deps.database.isReachable() }
        val notifier = probe { deps.ports.notifier.isAlive() }
        if (database && notifier) {
            call.respondJson(HttpStatusCode.OK, statusBody("ok"))
        } else {
            call.respondProblem(notReadyProblem(database, notifier))
        }
    }
}

/** 確認が例外になる・時間内に終わらない場合は、準備できていない（false）として扱う（500 にしない）。 */
private suspend fun probe(check: suspend () -> Boolean): Boolean =
    withTimeoutOrNull(PROBE_TIMEOUT_MILLIS) { Either.catch { check() }.getOrElse { false } } ?: false

private fun notReadyProblem(
    database: Boolean,
    notifier: Boolean,
): Problem =
    Problem(
        status = HttpStatusCodes.UNAVAILABLE,
        code = Codes.NOT_READY,
        title = "準備できていません。",
        extras =
            mapOf(
                "checks" to
                    JsonObject(
                        mapOf("database" to JsonPrimitive(database), "notifier" to JsonPrimitive(notifier)),
                    ),
            ),
    )
