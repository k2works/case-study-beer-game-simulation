package beergame.http

import beergame.application.InvitationView
import beergame.application.LobbyEntry
import beergame.application.Observation
import beergame.application.ObservationWeek
import beergame.application.ObserverView
import beergame.application.Review
import beergame.application.Snapshot
import beergame.application.SnapshotView
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/*
 * 問い合わせの応答の本文（ロビー、振り返り、観察）。項目名は contracts/openapi.yaml。
 * application が呼び出した人ごとに開示の規則を掛けた値だけを書き出す（ここで値を足さない）。Responses.kt が関数の数の上限に
 * 達したため、B9 で、ロビーと振り返りの書き出しをここへ移した。
 */

private fun lobbyEntryJson(entry: LobbyEntry): JsonObject =
    buildJsonObject {
        put("participantId", entry.participantId.value.toString())
        put("displayName", entry.displayName?.let(::JsonPrimitive) ?: JsonNull)
        put("role", entry.role?.name?.let(::JsonPrimitive) ?: JsonNull)
        // 入れ替えで外された旧担当者だけに付ける（それ以外は省略 = false。仕様の LobbyParticipant.replaced）
        if (entry.replaced) put("replaced", true)
    }

private fun invitationJson(view: InvitationView): JsonObject =
    buildJsonObject {
        put("invitationId", view.invitationId.value.toString())
        put("expiresAt", view.expiresAt.toString())
        put("revoked", view.revoked)
        put("createdAt", view.createdAt.toString())
    }

/** 観察者は、役割を持たない（`role` の項目が無い）。 */
private fun observerJson(view: ObserverView): JsonObject =
    buildJsonObject {
        put("observerId", view.observerId.value.toString())
        put("displayName", view.displayName?.let(::JsonPrimitive) ?: JsonNull)
        put("joinedAt", view.joinedAt.toString())
    }

/** `GET /games/{id}/lobby`（進行役向け）。参加コード・表示名・割り当てと、観察用の招待・観察者を返す。 */
internal fun Snapshot.toLobbyJson(facilitator: SnapshotView.Facilitator): JsonObject =
    buildJsonObject {
        put("gameId", gameId.value.toString())
        put("status", status.name)
        put("joinCode", facilitator.joinCode)
        putSettings(settings)
        put("participants", JsonArray(facilitator.lobby.map(::lobbyEntryJson)))
        put("invitations", JsonArray(facilitator.invitations.map(::invitationJson)))
        put("observers", JsonArray(facilitator.observers.map(::observerJson)))
        put("versions", versions.toJson())
    }

/** `GET /games/{id}/review`（B4）。全役割の全週の結果。 */
internal fun Review.toReviewJson(): JsonObject =
    buildJsonObject {
        put("gameId", gameId.value.toString())
        put("finalWeek", finalWeek)
        putSettings(settings)
        put("results", JsonArray(results.map(::weekResultJson)))
        put("versions", versions.toJson())
    }

private fun observationWeekJson(week: ObservationWeek): JsonObject =
    buildJsonObject {
        put("week", week.week)
        when (week) {
            is ObservationWeek.Visible -> {
                put("order", week.ordered)
                put("inventory", week.inventory)
                put("backlog", week.backlog)
            }

            is ObservationWeek.Hidden -> {
                put("hidden", true)
                put("reason", week.reason.name)
            }
        }
    }

/**
 * `GET /games/{id}/observation`（B9）。現在週・完了状況（入力済みの役割数）・チーム合計だけ。
 * 役割別の値・将来の需要・参加コード・入力者の項目を持たない。合計を出さないとき（公開範囲が「なし」）は、
 * `weeks` が空で、`hiddenReason` に理由を示す。
 */
internal fun Observation.toObservationJson(): JsonObject =
    buildJsonObject {
        put("gameId", gameId.value.toString())
        put("status", status.name)
        put("finalWeek", finalWeek)
        session?.let {
            put("sessionStatus", it.status.name)
            put("week", it.week)
            put("submittedRoleCount", it.submittedRoleCount)
        }
        put(
            "totals",
            buildJsonObject {
                put("policy", totals.policy.name)
                totals.hiddenReason?.let { put("hiddenReason", it.name) }
                put("weeks", JsonArray(totals.weeks.map(::observationWeekJson)))
            },
        )
        put("versions", versions.toJson())
    }
