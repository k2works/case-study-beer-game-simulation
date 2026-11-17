package beergame.http

import arrow.core.raise.either
import beergame.application.RetentionView
import beergame.application.retention
import beergame.domain.GameId
import io.ktor.http.HttpStatusCode
import io.ktor.server.routing.Route
import io.ktor.server.routing.get
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/*
 * 保持状態（B11。US5.1）。`GET /games/{gameId}/retention`。進行役だけ。
 * 資格が無効・参加者・観察者・別のゲーム・存在しないゲームは、区別せず同じ 403（`app.unauthorized`）。
 */

internal fun Route.retentionRoutes(deps: HttpDeps) {
    get("/games/{gameId}/retention") {
        call.operation("getRetention")
        val result =
            either<Problem, JsonObject> {
                val id = call.gameIdParam("gameId").bind()
                deps.ports
                    .retention(GameId(id), call.credential())
                    .mapLeft { it.toProblem() }
                    .bind()
                    .toJson()
            }
        result.fold({ call.respondProblem(it) }, { call.respondJson(HttpStatusCode.OK, it) })
    }
}

private fun RetentionView.toJson(): JsonObject =
    buildJsonObject {
        put("retentionDays", retentionDays)
        put("startsAt", startsAt.toString())
        put("deleteAfter", deleteAfter.toString())
        put("status", status.name)
        put("attempt", attempt)
        put("nextAttemptAt", nextAttemptAt?.toString()?.let(::JsonPrimitive) ?: JsonNull)
        put("lastFailureCode", lastFailureCode?.let(::JsonPrimitive) ?: JsonNull)
        put("backupRetentionDays", backupRetentionDays)
    }
