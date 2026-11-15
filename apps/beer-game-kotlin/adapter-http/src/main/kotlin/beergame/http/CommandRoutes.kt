package beergame.http

import arrow.core.Either
import arrow.core.flatMap
import arrow.core.left
import arrow.core.raise.either
import arrow.core.raise.ensureNotNull
import arrow.core.right
import beergame.application.AppFailure
import beergame.application.AttemptSource
import beergame.application.CommandOutcome
import beergame.application.CommitWeekInput
import beergame.application.Ports
import beergame.application.RequestMeta
import beergame.application.SaveDecisionInput
import beergame.application.SnapshotView
import beergame.application.assignRole
import beergame.application.commitWeek
import beergame.application.createGame
import beergame.application.joinGame
import beergame.application.saveDecision
import beergame.application.snapshot
import beergame.application.sourceKey
import beergame.application.startGame
import beergame.domain.GameId
import beergame.domain.ParticipantId
import io.ktor.http.CookieEncoding
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.renderSetCookieHeader
import io.ktor.server.application.ApplicationCall
import io.ktor.server.plugins.origin
import io.ktor.server.response.header
import io.ktor.server.routing.Route
import io.ktor.server.routing.post
import io.ktor.server.routing.put
import java.util.UUID

/*
 * コマンドのルート。ルートは、本文の形の検証（RequestParsing）と、資格・冪等キーの取り出しだけを持つ。
 * 認証・認可・冪等・業務の判定は application（execute と decide）にあり、ここには無い。
 * 応答は `versions` だけ（資格を発行する作成・参加は、Set-Cookie も付ける）。
 */

private val SAME_SITE_STRICT = mapOf("SameSite" to "Strict")

internal fun Route.commandRoutes(deps: HttpDeps) {
    val ports = deps.ports
    post("/games") {
        call.operation("createGame")
        call.command(deps, HttpStatusCode.Created, ::parseCreateGame) { input, meta -> ports.createGame(input, meta) }
    }
    post("/participations/join") {
        call.operation("joinGame")
        // 参加は、接続元ごとの失敗の窓で制限する（B5 Step 5。復帰の経路は Step 6 で同じく limited にする）
        call.command(deps, HttpStatusCode.OK, ::parseJoinGame, limited = true) { input, meta ->
            ports.joinGame(input, meta)
        }
    }
    put("/games/{gameId}/participants/{participantId}/role") {
        call.operation("assignRole")
        val ids = call.gameIdParam("gameId").flatMap { game -> call.uuidParam("participantId").map { game to it } }
        call.withIds(ids) { (game, participant) ->
            call.command(deps, HttpStatusCode.OK, ::parseAssignRole) { role, meta ->
                ports.assignRole(GameId(game), ParticipantId(participant), role, meta)
            }
        }
    }
    post("/games/{gameId}/start") {
        call.operation("startGame")
        call.withIds(call.gameIdParam("gameId")) { game ->
            call.command(deps, HttpStatusCode.OK, { Unit.right() }) { _, meta -> ports.startGame(GameId(game), meta) }
        }
    }
    sessionCommandRoutes(deps)
}

private fun Route.sessionCommandRoutes(deps: HttpDeps) {
    val ports = deps.ports
    put("/sessions/{sessionId}/decisions") {
        call.operation("saveDecision")
        call.withIds(call.gameIdParam("sessionId")) { id ->
            val ifMatch = call.request.headers[HttpHeaders.IfMatch]
            call.command(deps, HttpStatusCode.OK, { body -> parseSaveDecision(body, ifMatch) }) { body, meta ->
                // 入力する役割は、資格から決まる（本文に役割を持たせない）。役割が無い操作者（進行役、役割が未割り当ての参加者）は、
                // 権限の無い操作として、資格の失敗と同じ応答にする
                either {
                    val snapshot = ports.snapshot(GameId(id), meta.credential).bind()
                    val role =
                        ensureNotNull((snapshot.view as? SnapshotView.Participant)?.role) { AppFailure.Unauthorized }
                    val input = SaveDecisionInput(role, body.week, body.quantity, body.expectedVersion)
                    ports.saveDecision(GameId(id), input, meta).bind()
                }
            }
        }
    }
    post("/sessions/{sessionId}/weeks/{week}/commit") {
        call.operation("commitWeek")
        val pathWeek = call.parameters["week"]?.toIntOrNull()
        call.withIds(call.gameIdParam("sessionId")) { id ->
            val parse = { body: ByteArray -> parseCommitWeek(body).flatMap { sameWeek(it, pathWeek) } }
            call.command(deps, HttpStatusCode.OK, parse) { input, meta -> ports.commitWeek(GameId(id), input, meta) }
        }
    }
}

/** 経路の週と本文の `requestedWeek` が違う確定は、拒否する（どちらの週を確定するのか決められない）。 */
private fun sameWeek(
    input: CommitWeekInput,
    path: Int?,
): Either<Problem, CommitWeekInput> =
    if (input.requestedWeek == path) {
        input.right()
    } else {
        validationProblem(listOf(FieldError("requestedWeek", "経路の週（${path ?: "不正"}）と一致しません。"))).left()
    }

/** 経路の ID が不正なら、404 を返す。そうでなければ [block] を続ける。 */
private suspend fun <A> ApplicationCall.withIds(
    ids: Either<Problem, A>,
    block: suspend (A) -> Unit,
) {
    when (ids) {
        is Either.Left -> respondProblem(ids.value)
        is Either.Right -> block(ids.value)
    }
}

/**
 * 1 つのコマンドの共通の流れ: 冪等キー → 本文（上限つき）→ 形の検証 → application → 応答。
 * 失敗は、写像の関数（[toProblem]）で problem+json にする。
 * [limited] は、参加・復帰の専用のレート制限の対象（接続元を正規化して application へ渡し、ログには鍵付き要約だけを載せる）。
 */
private suspend fun <A> ApplicationCall.command(
    deps: HttpDeps,
    status: HttpStatusCode,
    parse: (ByteArray) -> Either<Problem, A>,
    limited: Boolean = false,
    run: suspend (A, RequestMeta) -> Either<AppFailure, CommandOutcome>,
) {
    val source = if (limited) attemptSource(deps) else null
    val result =
        either<Problem, CommandOutcome> {
            val key = idempotencyKey().bind()
            val body = readBody(deps.settings.maxBodyBytes).bind()
            val input = parse(body).bind()
            run(input, RequestMeta(key, credential(), correlationId, source)).mapLeft { it.toProblem() }.bind()
        }
    result.fold({ respondProblem(it) }, { respondOutcome(deps, status, it) })
}

/**
 * 接続元（TCP の接続元。`X-Forwarded-For` は信頼しない。ALB の背後の扱いは未決で、B14 で決める）を正規化する。
 * ログ用に、鍵付き要約（窓の鍵と同じ値）を覚える。生の接続元は、ここから先へ渡さない（ログにも載せない）。
 */
private fun ApplicationCall.attemptSource(deps: HttpDeps): AttemptSource {
    val source = AttemptSource.of(request.origin.remoteHost)
    attributes.put(SourceKey, deps.ports.settings.sourceKey(source))
    return source
}

private suspend fun ApplicationCall.respondOutcome(
    deps: HttpDeps,
    status: HttpStatusCode,
    outcome: CommandOutcome,
) {
    attributes.put(VersionsKey, outcome.versions)
    attributes.put(GameIdKey, outcome.gameId.value.toString())
    outcome.issued?.let { issued ->
        val ttl =
            deps.ports.settings.participantCredentialTtl.seconds
                .toInt()
        // Ktor の既定は、内部の符号化の印（$x-enc）を Set-Cookie に付ける。標準の属性だけにする
        val setCookie =
            renderSetCookieHeader(
                name = COOKIE_NAME,
                value = issued.raw,
                encoding = CookieEncoding.URI_ENCODING,
                maxAge = ttl,
                path = "/",
                secure = deps.settings.cookieSecure,
                httpOnly = true,
                extensions = SAME_SITE_STRICT,
                includeEncoding = false,
            )
        response.header(HttpHeaders.SetCookie, setCookie)
    }
    if (status == HttpStatusCode.Created) {
        response.header(HttpHeaders.Location, "$API_BASE/games/${outcome.gameId.value}/state")
    }
    respondJson(status, commandResponse(outcome.versions))
}
