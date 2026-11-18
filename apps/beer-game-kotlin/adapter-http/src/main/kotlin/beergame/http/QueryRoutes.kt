package beergame.http

import arrow.core.Either
import arrow.core.left
import arrow.core.raise.either
import arrow.core.right
import beergame.application.AppFailure
import beergame.application.Snapshot
import beergame.application.SnapshotView
import beergame.application.review
import beergame.application.snapshot
import beergame.domain.GameId
import beergame.domain.GuidedTour
import beergame.domain.Role
import beergame.domain.SessionError
import io.ktor.http.HttpStatusCode
import io.ktor.server.application.ApplicationCall
import io.ktor.server.routing.Route
import io.ktor.server.routing.get
import kotlinx.serialization.json.JsonObject

/*
 * 問い合わせのルート。呼び出した人ごとの投影（開示の規則）は application の `snapshot` が掛ける。ここは書き出すだけ。
 * 資格が無効・別のゲーム・存在しないゲームは、区別せず同じ 403（資格の失敗と同じ本文）。
 */

@GuidedTour(
    name = "CQRS（コマンドと問い合わせの分離）",
    rank = 7,
    stage = "問い合わせ側",
    description = "問い合わせの入口。コマンドとは別の経路で、イベントストアを経由せずに、投影を読む",
)
internal fun Route.queryRoutes(deps: HttpDeps) {
    get("/sessions/{sessionId}/state") {
        call.operation("getSessionState")
        call.respondSnapshot(deps, "sessionId") { snapshot ->
            if (snapshot.session == null) {
                sessionNotStartedProblem().left()
            } else {
                snapshot.toSessionStateJson().right()
            }
        }
    }
    get("/games/{gameId}/state") {
        call.operation("getGameState")
        call.respondSnapshot(deps, "gameId") { snapshot -> snapshot.toGameStateJson().right() }
    }
    get("/games/{gameId}/review") {
        call.operation("getReview")
        val result =
            either<Problem, JsonObject> {
                val id = call.gameIdParam("gameId").bind()
                deps.ports
                    .review(GameId(id), call.credential())
                    .mapLeft { it.toProblem() }
                    .bind()
                    .toReviewJson()
            }
        result.fold({ call.respondProblem(it) }, { call.respondJson(HttpStatusCode.OK, it) })
    }
    get("/games/{gameId}/lobby") {
        call.operation("getLobby")
        call.respondSnapshot(deps, "gameId") { snapshot ->
            // B1: ロビーは進行役だけ（参加者向けのロビーは、投影の型に項目が無い。未実装）
            (snapshot.view as? SnapshotView.Facilitator)?.let { snapshot.toLobbyJson(it).right() }
                ?: unauthorizedProblem().left()
        }
    }
}

/** 準備中のゲームには、セッションの状態が無い（`session.not_active`）。 */
private fun sessionNotStartedProblem(): Problem = AppFailure.Domain(SessionError.NotActive).toProblem()

private suspend fun ApplicationCall.respondSnapshot(
    deps: HttpDeps,
    idName: String,
    render: (Snapshot) -> Either<Problem, JsonObject>,
) {
    val result =
        either<Problem, JsonObject> {
            val id = gameIdParam(idName).bind()
            val role = requestedRole().bind()
            val snapshot =
                deps.ports
                    .snapshot(GameId(id), credential(), role)
                    .mapLeft { it.toProblem() }
                    .bind()
            render(snapshot).bind()
        }
    result.fold({ respondProblem(it) }, { respondJson(HttpStatusCode.OK, it) })
}

/** `?role=RETAILER`: 他の役割の状況を取得しようとする問い合わせ（AC2.1.2）。自分の役割と違えば、application が拒否する。 */
private fun ApplicationCall.requestedRole(): Either<Problem, Role?> {
    val raw = request.queryParameters["role"]
    return if (raw == null) {
        (null as Role?).right()
    } else {
        Role.entries.firstOrNull { it.name == raw }?.right() ?: invalidRoleProblem().left()
    }
}

private fun invalidRoleProblem(): Problem {
    val names = Role.entries.joinToString("、") { it.name }
    return validationProblem(listOf(FieldError("role", "役割は $names のいずれかにしてください。")))
}
