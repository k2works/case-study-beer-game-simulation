package beergame.application

import beergame.domain.GameId
import beergame.domain.ParticipantId
import beergame.domain.Role

/*
 * 問い合わせ側の型。`ProjectedGame` は投影の表から読んだままの行（開示の規則は掛けていない）、
 * `Snapshot` は呼び出した人ごとに開示の規則（[Disclosure]）を掛けた結果。
 * 項目名は、OpenAPI（contracts/openapi.yaml）の `SessionState` が「未決」としているため、B1 の仮置き。
 */

enum class GameStatus { PREPARING, STARTED, ENDED }

enum class SessionStatus { ACTIVE, PAUSED, ENDED }

// ---- 投影から読んだ行 ----

data class ProjectedParticipant(
    val participantId: ParticipantId,
    val displayName: String?,
    val role: Role?,
    /** 役割の入れ替えで外された旧担当者（履歴と入力者のラベルのために行は残る）。 */
    val replaced: Boolean = false,
)

data class ProjectedSession(
    val status: SessionStatus,
    val week: Int,
    val submittedRoleCount: Int,
)

data class ProjectedRoleState(
    val inventory: Int,
    val backlog: Int,
    val arrivals: Int,
    val orders: Int,
    val cumulativeCostMinor: Long,
    val asOfWeek: Int,
)

data class ProjectedDecision(
    val week: Int,
    val quantity: Int,
    val version: Long,
)

data class ProjectedWeekResult(
    val week: Int,
    val role: Role,
    val orders: Int,
    val shipped: Int,
    val ordered: Int,
    val endingInventory: Int,
    val endingBacklog: Int,
    val weeklyCostMinor: Long,
    val cumulativeCostMinor: Long,
)

/** 1 ゲームの投影の行。将来の週の需要（`game_settings.demand`）は読まない（読み取りの型に持たせない）。 */
data class ProjectedGame(
    val gameId: GameId,
    val status: GameStatus,
    val finalWeek: Int,
    val joinCode: String,
    val participants: List<ProjectedParticipant>,
    val session: ProjectedSession?,
    val roleStates: Map<Role, ProjectedRoleState>,
    val decisions: Map<Role, ProjectedDecision>,
    val results: List<ProjectedWeekResult>,
    /** `projection_checkpoints` の版。行と同じ時点（行より新しい版を返さない）。 */
    val versions: Versions,
)

// ---- 呼び出した人ごとの投影 ----

data class SessionSummary(
    val status: SessionStatus,
    val week: Int,
    val submittedRoleCount: Int,
)

/** 1 役割の状況。[customerDemand] は小売店だけが持つ当週の顧客需要（他の役割は null）。 */
data class RoleStatus(
    val inventory: Int,
    val backlog: Int,
    val arrivals: Int,
    val orders: Int,
    val customerDemand: Int?,
    val decision: Int?,
    val decisionVersion: Long,
)

data class LobbyEntry(
    val participantId: ParticipantId,
    val displayName: String?,
    val role: Role?,
    val replaced: Boolean = false,
)

data class WeekResultView(
    val week: Int,
    val role: Role,
    val orders: Int,
    val shipped: Int,
    val ordered: Int,
    val endingInventory: Int,
    val endingBacklog: Int,
    val weeklyCostMinor: Long,
    val cumulativeCostMinor: Long,
)

sealed interface SnapshotView {
    /** 参加者: 自分の役割の状況だけ。他の役割の値、参加コード、他の参加者の表示名、将来の需要は含まない。 */
    data class Participant(
        val participantId: ParticipantId,
        val role: Role?,
        val status: RoleStatus?,
    ) : SnapshotView

    /** 進行役: 全役割の状況と入力、参加コード、ロビー、確定した週の結果。 */
    data class Facilitator(
        val joinCode: String,
        val finalWeek: Int,
        val lobby: List<LobbyEntry>,
        val roles: Map<Role, RoleStatus>,
        val results: List<WeekResultView>,
    ) : SnapshotView
}

data class Snapshot(
    val gameId: GameId,
    val status: GameStatus,
    val session: SessionSummary?,
    val versions: Versions,
    val view: SnapshotView,
)
