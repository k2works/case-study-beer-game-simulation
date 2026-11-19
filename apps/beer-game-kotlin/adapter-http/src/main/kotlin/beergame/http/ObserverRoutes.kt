package beergame.http

import arrow.core.Either
import arrow.core.flatMap
import arrow.core.raise.either
import arrow.core.raise.zipOrAccumulate
import arrow.core.right
import beergame.application.JoinObserverInput
import beergame.application.invitationIdOf
import beergame.application.inviteObserver
import beergame.application.joinAsObserver
import beergame.application.observe
import beergame.application.revokeObserverInvitation
import beergame.domain.GameId
import beergame.domain.InvitationId
import io.ktor.http.HttpStatusCode
import io.ktor.server.routing.Route
import io.ktor.server.routing.get
import io.ktor.server.routing.post
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/*
 * 観察者のルート（B9）: 観察用の招待の発行・失効、観察者の参加、観察。
 * ルートは、本文の形の検証と、資格・冪等キーの取り出しだけを持つ。認可（進行役だけ、観察者と進行役だけ）は application と domain が持つ。
 * 招待コードは、発行の応答だけが運ぶ（再表示しない）。観察者の参加は、ブラウザセッションの Cookie だけを発行し、復帰資格は発行しない。
 */

/** 観察者の参加の本文。 */
internal fun parseJoinObserver(body: ByteArray): Either<Problem, JoinObserverInput> =
    parseObject(body).flatMap { obj ->
        collect {
            zipOrAccumulate(
                ::combine,
                { obj.string("invitationCode").bind() },
                { obj.string("displayName").bind() },
            ) { code, displayName -> JoinObserverInput(code, displayName) }
        }
    }

internal fun Route.observerRoutes(deps: HttpDeps) {
    val ports = deps.ports
    post("/games/{gameId}/observer-invitations") {
        call.operation("inviteObserver")
        call.withIds(call.gameIdParam("gameId")) { id ->
            call.command(deps, HttpStatusCode.OK, ::parseEmptyObject) { _, meta ->
                // 招待コードと招待の ID、期限は、この応答だけが運ぶ（再表示しない。Cookie にもしない）
                ports.inviteObserver(GameId(id), meta).map { outcome ->
                    val invitation = checkNotNull(outcome.recovery) { "発行した招待が無い" }
                    Reply(
                        outcome,
                        mapOf(
                            "invitationId" to JsonPrimitive(invitationIdOf(invitation).value.toString()),
                            "invitationCode" to JsonPrimitive(invitation.raw),
                            "expiresAt" to JsonPrimitive(checkNotNull(invitation.expiresAt) { "招待の期限が無い" }.toString()),
                        ),
                    )
                }
            }
        }
    }
    post("/games/{gameId}/observer-invitations/{invitationId}/revoke") {
        call.operation("revokeObserverInvitation")
        val ids = call.gameIdParam("gameId").flatMap { game -> call.uuidParam("invitationId").map { game to it } }
        call.withIds(ids) { (game, invitation) ->
            call.command(deps, HttpStatusCode.OK, { Unit.right() }) { _, meta ->
                ports.revokeObserverInvitation(GameId(game), InvitationId(invitation), meta).reply()
            }
        }
    }
    post("/participations/observe") {
        call.operation("joinAsObserver")
        // 観察者の参加は、参加と同じ接続元ごとの失敗の窓で制限する。ブラウザセッション（bg_session）だけを発行する
        call.command(deps, HttpStatusCode.OK, ::parseJoinObserver, CallPolicy(limited = true)) { input, meta ->
            ports.joinAsObserver(input, meta).map { outcome ->
                Reply(
                    outcome,
                    mapOf(
                        "gameId" to JsonPrimitive(outcome.gameId.value.toString()),
                        "kind" to JsonPrimitive("OBSERVER"),
                    ),
                )
            }
        }
    }
    get("/games/{gameId}/observation") {
        call.operation("getObservation")
        val result =
            either<Problem, JsonObject> {
                val id = call.gameIdParam("gameId").bind()
                ports
                    .observe(GameId(id), call.credential())
                    .mapLeft { it.toProblem() }
                    .bind()
                    .toObservationJson()
            }
        result.fold({ call.respondProblem(it) }, { call.respondJson(HttpStatusCode.OK, it) })
    }
}

/** 本文が空でも `{}` でもよい要求（招待の発行）。JSON のオブジェクトでなければ 400。 */
private fun parseEmptyObject(body: ByteArray): Either<Problem, Unit> =
    if (body.isEmpty()) Unit.right() else parseObject(body).map { }
