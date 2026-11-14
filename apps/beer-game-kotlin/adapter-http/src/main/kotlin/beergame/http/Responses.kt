package beergame.http

import beergame.application.GameStatus
import beergame.application.LobbyEntry
import beergame.application.RoleStatus
import beergame.application.Snapshot
import beergame.application.SnapshotView
import beergame.application.Versions
import beergame.application.WeekResultView
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/*
 * 応答の本文。コマンドの応答は `versions`（ストリームごとの版）だけで、確定の結果などは含めない（H8）。
 * 項目名は contracts/openapi.yaml。問い合わせ（state、lobby）は、application が呼び出した人ごとに開示の規則を掛けた
 * [Snapshot] の項目だけを書き出す（ここで値を足さない）。
 */

/** `{"game": n|null, "session": n|null}`。追記しなかったストリームは null。 */
internal fun Versions.toJson(): JsonObject =
    buildJsonObject {
        put("game", game?.value?.let(::JsonPrimitive) ?: JsonNull)
        put("session", session?.value?.let(::JsonPrimitive) ?: JsonNull)
    }

internal fun commandResponse(versions: Versions): JsonObject = buildJsonObject { put("versions", versions.toJson()) }

private fun roleStatusJson(status: RoleStatus): JsonObject =
    buildJsonObject {
        put("inventory", status.inventory)
        put("backlog", status.backlog)
        put("arrivals", status.arrivals)
        put("orders", status.orders)
        status.customerDemand?.let { put("customerDemand", it) }
        put("decision", status.decision?.let(::JsonPrimitive) ?: JsonNull)
        put("decisionVersion", status.decisionVersion)
    }

private fun weekResultJson(result: WeekResultView): JsonObject =
    buildJsonObject {
        put("role", result.role.name)
        put("week", result.week)
        put("orders", result.orders)
        put("order", result.ordered)
        put("inventory", result.endingInventory)
        put("backlog", result.endingBacklog)
        put("shipment", result.shipped)
        put("cost", result.weeklyCostMinor)
        put("cumulativeCost", result.cumulativeCostMinor)
    }

private fun lobbyEntryJson(entry: LobbyEntry): JsonObject =
    buildJsonObject {
        put("participantId", entry.participantId.value.toString())
        put("displayName", entry.displayName?.let(::JsonPrimitive) ?: JsonNull)
        put("role", entry.role?.name?.let(::JsonPrimitive) ?: JsonNull)
    }

/** `GET /sessions/{id}/state`。参加者は自分の役割だけ、進行役は全役割と確定した週の結果。 */
internal fun Snapshot.toSessionStateJson(): JsonObject =
    buildJsonObject {
        put("sessionId", gameId.value.toString())
        session?.let {
            put("status", it.status.name)
            put("week", it.week)
            put("submittedRoleCount", it.submittedRoleCount)
        }
        when (val current = view) {
            is SnapshotView.Participant -> {
                put("participantId", current.participantId.value.toString())
                current.role?.let { put("role", it.name) }
                current.status?.let { put("roleStatus", roleStatusJson(it)) }
            }

            is SnapshotView.Facilitator -> {
                put("finalWeek", current.finalWeek)
                put(
                    "roles",
                    JsonObject(
                        current.roles.entries.associate { (role, state) ->
                            role.name to
                                roleStatusJson(state)
                        },
                    ),
                )
                put("results", JsonArray(current.results.map(::weekResultJson)))
            }
        }
        put("versions", versions.toJson())
    }

/** `GET /games/{id}/state`。開始後に `sessionId`（このゲームでは gameId と同じ）を得る。進行役にだけ参加コードを含める。 */
internal fun Snapshot.toGameStateJson(): JsonObject =
    buildJsonObject {
        put("gameId", gameId.value.toString())
        put("sessionId", if (status == GameStatus.PREPARING) JsonNull else JsonPrimitive(gameId.value.toString()))
        put("status", status.name)
        when (val current = view) {
            is SnapshotView.Participant -> {
                put("participantId", current.participantId.value.toString())
                current.role?.let { put("role", it.name) }
            }

            is SnapshotView.Facilitator -> {
                put("joinCode", current.joinCode)
                put("finalWeek", current.finalWeek)
            }
        }
        put("versions", versions.toJson())
    }

/** `GET /games/{id}/lobby`（進行役向け）。参加コード・表示名・割り当てを返す。 */
internal fun Snapshot.toLobbyJson(facilitator: SnapshotView.Facilitator): JsonObject =
    buildJsonObject {
        put("gameId", gameId.value.toString())
        put("status", status.name)
        put("joinCode", facilitator.joinCode)
        put("participants", JsonArray(facilitator.lobby.map(::lobbyEntryJson)))
        put("versions", versions.toJson())
    }
