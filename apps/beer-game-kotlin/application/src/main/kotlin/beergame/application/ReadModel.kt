package beergame.application

import beergame.domain.Editor
import beergame.domain.GameId
import beergame.domain.ParticipantId
import beergame.domain.Role
import java.time.Instant

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
    /** 最後に保存した人（`current_decisions.editor_kind`・`editor_id`）。表示名は持たない（結合は開示の規則）。 */
    val editor: Editor,
    /** 保存の時刻（`current_decisions.updated_at`。イベントの時刻）。 */
    val savedAt: Instant,
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

/** 設定の種別（`KIT`・`CUSTOM`）と、キットの値から変えた項目の名前（B7）。 */
data class SettingsSummary(
    val kind: String,
    val changes: List<String>,
) {
    companion object {
        val KIT = SettingsSummary("KIT", emptyList())
    }
}

/** 1 ゲームの投影の行。将来の週の需要（`game_settings.demand`）は読まない（読み取りの型に持たせない）。 */
data class ProjectedGame(
    val gameId: GameId,
    val status: GameStatus,
    val finalWeek: Int,
    val joinCode: String,
    val settings: SettingsSummary = SettingsSummary.KIT,
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

enum class EditorKind { PARTICIPANT, FACILITATOR_PROXY }

/**
 * 入力を保存した人（B6）。[displayName] は参加者のときだけ（進行役の代理入力は持たない）。
 * 表示名は、同じ役割の共同担当と進行役にだけ返す（他の役割・観察者・無資格には、この値を持つ状況そのものを返さない）。
 */
data class DecisionEditorView(
    val kind: EditorKind,
    val isSelf: Boolean,
    val displayName: String?,
)

/** 保存済みの入力 1 件（数量・版・保存者・保存の時刻）。競合の 409 の `latest`・`current` の項目（B6）。 */
data class DecisionDetail(
    val quantity: Int,
    val version: Long,
    val editor: DecisionEditorView,
    val savedAt: Instant,
)

/**
 * 競合の失敗（`session.decision_conflict`・`session.decisions_changed`）に添える、最新の入力の詳細（B6）。
 * 投影から作り、呼び出した人ごとの開示の規則を掛けてある（[Disclosure.conflictDetail]）。
 */
sealed interface ConflictDetail {
    /** `decision_conflict` の最新の入力。入力がまだ無ければ null。 */
    data class Latest(
        val entry: DecisionDetail?,
    ) : ConflictDetail

    /** `decisions_changed` の、役割ごとの現在の入力。 */
    data class Current(
        val entries: Map<Role, DecisionDetail>,
    ) : ConflictDetail
}

/** 同じ役割の共同担当（B6）。参加者の ID は含めない。 */
data class CoHolderView(
    val displayName: String?,
    val isSelf: Boolean,
)

/**
 * 1 役割の状況。[customerDemand] は小売店だけが持つ当週の顧客需要（他の役割は null）。
 * [decisionEditor]・[decisionSavedAt] は、当週の入力を最後に保存した人と時刻（入力が無ければ null）。
 */
data class RoleStatus(
    val inventory: Int,
    val backlog: Int,
    val arrivals: Int,
    val orders: Int,
    val customerDemand: Int?,
    val decision: Int?,
    val decisionVersion: Long,
    val decisionEditor: DecisionEditorView? = null,
    val decisionSavedAt: Instant? = null,
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
    /**
     * 参加者: 自分の役割の状況だけ。他の役割の値、参加コード、他の役割の参加者の表示名、将来の需要は含まない。
     * [coHolders] は、同じ役割の共同担当（自分を含む。入れ替えで外れた旧担当者は含まない）。
     */
    data class Participant(
        val participantId: ParticipantId,
        val role: Role?,
        val status: RoleStatus?,
        val coHolders: List<CoHolderView> = emptyList(),
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
    val settings: SettingsSummary = SettingsSummary.KIT,
)
