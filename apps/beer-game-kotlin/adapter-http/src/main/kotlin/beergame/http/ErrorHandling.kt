package beergame.http

import io.ktor.http.HttpStatusCode
import io.ktor.server.application.Application
import io.ktor.server.application.ApplicationCall
import io.ktor.server.application.install
import io.ktor.server.plugins.BadRequestException
import io.ktor.server.plugins.statuspages.StatusPages
import kotlinx.coroutines.CancellationException

/**
 * 予期しない例外は、500 の `app.internal` にして、スタックと相関 ID を記録する（利用者へは相関 ID だけを返す）。
 * 経路が無い・方法が違う呼び出しも、`type` を持つ problem+json で返す。
 *
 * StatusPages の状態コードの処理は、ルートが返した 404 などにも掛かる。ルートが problem を返していれば、
 * その problem をそのまま返し直す（`game.participant_not_found` を、経路の無い 404 に上書きしない）。
 */
internal fun Application.installErrorHandling(deps: HttpDeps) {
    install(StatusPages) {
        exception<Throwable> { call, cause ->
            if (cause is CancellationException) throw cause
            deps.logs.emit(errorRecord(call, deps, cause))
            call.respondProblem(internalProblem())
        }
        exception<BadRequestException> { call, _ ->
            call.respondProblem(badRequestProblem("リクエストを解釈できません。"))
        }
        status(HttpStatusCode.NotFound) { call, _ -> call.respondProblem(returned(call) ?: notFoundProblem()) }
        status(HttpStatusCode.MethodNotAllowed) { call, _ ->
            call.respondProblem(returned(call) ?: methodNotAllowedProblem())
        }
    }
}

private fun returned(call: ApplicationCall): Problem? = call.attributes.getOrNull(ProblemKey)

private fun methodNotAllowedProblem(): Problem =
    Problem(HttpStatusCodes.METHOD_NOT_ALLOWED, Codes.METHOD_NOT_ALLOWED, "この方法は使えません。")
