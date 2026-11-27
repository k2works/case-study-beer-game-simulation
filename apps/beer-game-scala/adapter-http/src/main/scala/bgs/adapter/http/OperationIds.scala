package bgs.adapter.http

/** 経路から、契約（`openapi.yaml`）の `operationId` を引く（メトリクスの次元 `Operation`。B13）。識別子・週・役割名は `{id}`
  * に落としてから引く。
  */
object OperationIds:

  private val UuidPattern =
    "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"

  /** 契約の経路 → operationId。契約に操作を足したら、ここにも足す（足りない操作は `unknown` になり、試験で気づく）。 */
  private val table: Map[String, String] = Map(
    "POST /api/v1/games" -> "createGame",
    "GET /api/v1/games/{id}/lobby" -> "getLobby",
    "GET /api/v1/games/{id}/observation" -> "getObservation",
    "POST /api/v1/games/{id}/observer-invitations" -> "inviteObserver",
    "POST /api/v1/games/{id}/observer-invitations/{id}/revoke" -> "revokeObserverInvitation",
    "POST /api/v1/participations/observe" -> "joinAsObserver",
    "GET /api/v1/games/{id}/review" -> "getReview",
    "GET /api/v1/games/{id}/exports" -> "getExport",
    "GET /api/v1/games/{id}/retention" -> "getRetention",
    "PUT /api/v1/games/{id}/participants/{id}/role" -> "assignRole",
    "POST /api/v1/participations/join" -> "joinGame",
    "POST /api/v1/games/{id}/start" -> "startGame",
    "PUT /api/v1/sessions/{id}/decisions" -> "saveDecision",
    "POST /api/v1/sessions/{id}/weeks/{id}/commit" -> "commitWeek",
    "POST /api/v1/sessions/{id}/pause" -> "pauseSession",
    "PUT /api/v1/sessions/{id}/commit-mode" -> "setCommitMode",
    "POST /api/v1/sessions/{id}/resume" -> "resumeSession",
    "PUT /api/v1/sessions/{id}/proxy-decisions/{id}" -> "submitProxyDecision",
    "POST /api/v1/games/{id}/credentials/revoke" -> "revokeCredential",
    "POST /api/v1/games/{id}/credentials/reissue" -> "reissueCredential",
    "POST /api/v1/participations/recover" -> "recoverParticipation",
    "GET /api/v1/sessions/{id}/state" -> "getSessionState",
    "GET /api/v1/games/{id}/state" -> "getGameState",
    "GET /api/v1/health" -> "getHealth",
    "GET /api/v1/ready" -> "getReady"
  )

  def of(method: String, path: String): String =
    val normalized = path
      .replaceAll(UuidPattern, "{id}")
      .replaceAll("/weeks/[0-9]+/", "/weeks/{id}/")
      .replaceAll("/proxy-decisions/[A-Z]+$", "/proxy-decisions/{id}")
    table.getOrElse(s"$method $normalized", "unknown")
