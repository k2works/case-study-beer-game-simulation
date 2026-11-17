package beergame.app.contract

import io.ktor.http.HttpMethod

/*
 * 仕様の各操作（生存・準備の確認を除く）を、1 つずつ呼ぶための、仕様どおりの要求。
 * 「全体の守り」（レート制限・サイズ・予期しない失敗）が、仕様のすべての操作に宣言されていることの検査に使う。
 * 仕様に操作が増えて、この表に無ければ、操作の網羅の検査が失敗する。
 */
internal class OperationRequest(
    val operationId: String,
    val method: HttpMethod,
    val path: String,
    val body: String?,
    val cookie: String?,
)

internal fun commitBody(
    requestedWeek: Int,
    version: Int,
): String = """{"requestedWeek":$requestedWeek,"basis":{${ROLES.joinToString(",") { "\"$it\":$version" }}}}"""

internal fun operationRequests(game: PlayedGame): List<OperationRequest> =
    listOf(
        OperationRequest("createGame", HttpMethod.Post, "/games", KIT_GAME, null),
        OperationRequest("getLobby", HttpMethod.Get, "/games/${game.id}/lobby", null, game.facilitator),
        OperationRequest(
            "assignRole",
            HttpMethod.Put,
            "/games/${game.id}/participants/${game.players.getValue("FACTORY").participantId}/role",
            // 工場の担当者を一次卸へ移す（実際に状態が変わる要求にする。同じ役割への割り当てでは、何も追記しない）
            """{"role":"DISTRIBUTOR"}""",
            game.facilitator,
        ),
        OperationRequest(
            "joinGame",
            HttpMethod.Post,
            "/participations/join",
            """{"joinCode":"${game.joinCode}","displayName":"契約の参加者"}""",
            null,
        ),
        OperationRequest("startGame", HttpMethod.Post, "/games/${game.id}/start", null, game.facilitator),
        OperationRequest(
            "saveDecision",
            HttpMethod.Put,
            "/sessions/${game.id}/decisions",
            """{"week":1,"quantity":4}""",
            game.cookieOf("FACTORY"),
        ),
        OperationRequest(
            "commitWeek",
            HttpMethod.Post,
            "/sessions/${game.id}/weeks/1/commit",
            commitBody(1, 1),
            game.facilitator,
        ),
        OperationRequest("getSessionState", HttpMethod.Get, "/sessions/${game.id}/state", null, game.facilitator),
        OperationRequest("getReview", HttpMethod.Get, "/games/${game.id}/review", null, game.facilitator),
        OperationRequest("getExport", HttpMethod.Get, "/games/${game.id}/exports?format=csv", null, game.facilitator),
        OperationRequest("getRetention", HttpMethod.Get, "/games/${game.id}/retention", null, game.facilitator),
        OperationRequest("getGameState", HttpMethod.Get, "/games/${game.id}/state", null, game.facilitator),
    ) + continuationRequests(game) + observerRequests(game)

/** B9 の観察者の操作（招待の発行・失効、観察者の参加、観察）。 */
private fun observerRequests(game: PlayedGame): List<OperationRequest> =
    listOf(
        OperationRequest(
            "inviteObserver",
            HttpMethod.Post,
            "/games/${game.id}/observer-invitations",
            "{}",
            game.facilitator,
        ),
        OperationRequest(
            "revokeObserverInvitation",
            HttpMethod.Post,
            "/games/${game.id}/observer-invitations/${game.invitationId}/revoke",
            null,
            game.facilitator,
        ),
        OperationRequest(
            "joinAsObserver",
            HttpMethod.Post,
            "/participations/observe",
            """{"invitationCode":"${game.invitationCode}","displayName":"契約の観察者"}""",
            null,
        ),
        OperationRequest("getObservation", HttpMethod.Get, "/games/${game.id}/observation", null, game.facilitator),
    )

/** 失効・再発行の本文（参加者を指す）。 */
internal fun subjectBody(participantId: String): String = """{"subject":{"kind":"PARTICIPANT","id":"$participantId"}}"""

/** B5 の継続と資格の操作（停止・再開・代理入力・失効・再発行・復帰）。復帰は、復帰コードを本文で渡す（Cookie は使わない）。 */
private fun continuationRequests(game: PlayedGame): List<OperationRequest> {
    val retailer = game.players.getValue("RETAILER")
    return listOf(
        OperationRequest("pauseSession", HttpMethod.Post, "/sessions/${game.id}/pause", null, game.facilitator),
        OperationRequest("resumeSession", HttpMethod.Post, "/sessions/${game.id}/resume", null, game.facilitator),
        OperationRequest(
            "setCommitMode",
            HttpMethod.Put,
            "/sessions/${game.id}/commit-mode",
            """{"commitMode":"AUTO"}""",
            game.facilitator,
        ),
        OperationRequest(
            "submitProxyDecision",
            HttpMethod.Put,
            "/sessions/${game.id}/proxy-decisions/FACTORY",
            """{"requestedWeek":1,"quantity":4}""",
            game.facilitator,
        ),
        OperationRequest(
            "revokeCredential",
            HttpMethod.Post,
            "/games/${game.id}/credentials/revoke",
            subjectBody(retailer.participantId),
            game.facilitator,
        ),
        OperationRequest(
            "reissueCredential",
            HttpMethod.Post,
            "/games/${game.id}/credentials/reissue",
            subjectBody(retailer.participantId),
            game.facilitator,
        ),
        OperationRequest(
            "recoverParticipation",
            HttpMethod.Post,
            "/participations/recover",
            """{"gameId":"${game.id}","recoveryCode":"${retailer.recovery}"}""",
            null,
        ),
    )
}

/** 資格・ID が実在しなくてよい検査（レート制限、サイズの上限）用の、仮のゲーム。 */
internal fun placeholderGame(): PlayedGame =
    PlayedGame(
        id = "00000000-0000-0000-0000-0000000000a1",
        facilitator = "placeholder",
        joinCode = "PLACEHOLDER0",
        players =
            ROLES.associateWith {
                Player(it, "placeholder", "00000000-0000-0000-0000-0000000000b1")
            },
    )
