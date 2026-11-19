package beergame.http

import arrow.core.flatMap
import arrow.core.right
import beergame.application.ProxyDecisionInput
import beergame.application.Recovered
import beergame.application.pauseSession
import beergame.application.recover
import beergame.application.reissueCredential
import beergame.application.resumeSession
import beergame.application.revokeCredential
import beergame.application.setCommitMode
import beergame.application.submitProxyDecision
import beergame.domain.ActorKind
import beergame.domain.GameId
import io.ktor.http.HttpStatusCode
import io.ktor.server.routing.Route
import io.ktor.server.routing.post
import io.ktor.server.routing.put
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive

/*
 * 継続と資格のルート（B5）: 停止・再開・代理入力、資格の失効・再発行、復帰。
 * ルートは、本文の形の検証と、資格・冪等キーの取り出しだけを持つ。認可（進行役だけ、など）は application と domain が持つ。
 * 応答は `versions`。再発行（復帰コードと期限）と復帰（gameId・kind・role）だけが、項目を足す（ADR-015）。
 */

internal fun Route.continuationRoutes(deps: HttpDeps) {
    sessionControlRoutes(deps)
    credentialRoutes(deps)
}

private fun Route.sessionControlRoutes(deps: HttpDeps) {
    val ports = deps.ports
    post("/sessions/{sessionId}/pause") {
        call.operation("pauseSession")
        call.withIds(call.gameIdParam("sessionId")) { id ->
            call.command(deps, HttpStatusCode.OK, { Unit.right() }) { _, meta ->
                ports.pauseSession(GameId(id), meta).reply()
            }
        }
    }
    post("/sessions/{sessionId}/resume") {
        call.operation("resumeSession")
        call.withIds(call.gameIdParam("sessionId")) { id ->
            call.command(deps, HttpStatusCode.OK, { Unit.right() }) { _, meta ->
                ports.resumeSession(GameId(id), meta).reply()
            }
        }
    }
    put("/sessions/{sessionId}/commit-mode") {
        call.operation("setCommitMode")
        call.withIds(call.gameIdParam("sessionId")) { id ->
            call.command(deps, HttpStatusCode.OK, ::parseSetCommitMode) { mode, meta ->
                ports.setCommitMode(GameId(id), mode, meta).reply()
            }
        }
    }
    put("/sessions/{sessionId}/proxy-decisions/{role}") {
        call.operation("submitProxyDecision")
        val role = roleParam(call.parameters["role"])
        call.withIds(call.gameIdParam("sessionId").flatMap { id -> role.map { id to it } }) { (id, target) ->
            call.command(deps, HttpStatusCode.OK, ::parseProxyDecision) { body, meta ->
                ports
                    .submitProxyDecision(
                        GameId(id),
                        ProxyDecisionInput(target, body.requestedWeek, body.quantity),
                        meta,
                    ).reply()
            }
        }
    }
}

private fun Route.credentialRoutes(deps: HttpDeps) {
    val ports = deps.ports
    post("/games/{gameId}/credentials/revoke") {
        call.operation("revokeCredential")
        call.withIds(call.gameIdParam("gameId")) { id ->
            call.command(deps, HttpStatusCode.OK, ::parseCredentialSubject) { subject, meta ->
                ports.revokeCredential(GameId(id), subject, meta).reply()
            }
        }
    }
    post("/games/{gameId}/credentials/reissue") {
        call.operation("reissueCredential")
        call.withIds(call.gameIdParam("gameId")) { id ->
            call.command(deps, HttpStatusCode.OK, ::parseCredentialSubject) { subject, meta ->
                // 新しい復帰コードと期限は、この応答だけが運ぶ（再表示しない）。進行役が参加者へ渡すので、Cookie にはしない
                ports.reissueCredential(GameId(id), subject, meta).map { outcome ->
                    val recovery = checkNotNull(outcome.recovery) { "再発行した復帰資格が無い" }
                    val expiresAt = checkNotNull(recovery.expiresAt) { "再発行した復帰資格の有効期限が無い" }
                    Reply(
                        outcome,
                        mapOf(
                            "recoveryCode" to JsonPrimitive(recovery.raw),
                            "expiresAt" to JsonPrimitive(expiresAt.toString()),
                        ),
                    )
                }
            }
        }
    }
    post("/participations/recover") {
        call.operation("recoverParticipation")
        // 復帰の認可は、提示した復帰資格（本文の復帰コード、なければ Cookie bg_recovery）。接続元ごとの失敗の窓で制限する（B5 Step 5）
        val policy = CallPolicy(limited = true, credentialCookie = RECOVERY_COOKIE_NAME)
        call.command(deps, HttpStatusCode.OK, ::parseRecover, policy) { body, meta ->
            val presented = meta.copy(credential = body.recoveryCode ?: meta.credential)
            ports.recover(GameId(body.gameId), presented).map(::recoveredReply)
        }
    }
}

/** 復帰の応答の本文: gameId、復帰した操作者の種別、参加者の担当の役割（未割り当てなら付けない）。 */
private fun recoveredReply(recovered: Recovered): Reply {
    val outcome = recovered.outcome
    val actor = checkNotNull(outcome.issued) { "復帰のブラウザセッションが無い" }.actor
    val extra = mutableMapOf<String, JsonElement>("gameId" to JsonPrimitive(outcome.gameId.value.toString()))
    extra["kind"] = JsonPrimitive(if (actor.kind == ActorKind.FACILITATOR) "FACILITATOR" else "PARTICIPANT")
    recovered.role?.let { extra["role"] = JsonPrimitive(it.name) }
    return Reply(outcome, extra)
}
