package beergame.domain

import arrow.core.Either
import arrow.core.left
import arrow.core.raise.Raise
import arrow.core.raise.either
import arrow.core.raise.ensure
import arrow.core.raise.ensureNotNull
import arrow.core.raise.nullable
import arrow.core.right
import java.time.Instant

/*
 * Session 集約（進行。ストリーム `session`）。B1: 入力の保存、手動の確定、最終週での終了。
 * B5: 停止・再開、進行役の代理入力、1 役割・1 週あたりの保存回数の上限。
 * 確定方式の変更・自動確定は後続の Bolt（B8）、進行役による終了は範囲外。
 * 開始（SessionStarted）は startGame が作る。
 */

/** 1 役割・1 週あたりの保存回数の上限（NF-C8。代理入力を含む）。 */
const val SAVE_LIMIT_PER_ROLE_WEEK = 9

/** 確定の方式（イベントに残す）。手動（進行役の確定）か、自動（入力がそろったときの自動確定。B8）。 */
enum class CommitKind {
    MANUAL,
    AUTO,
}

/** 終了の理由。B1 は最終週の確定だけ（進行役による終了は範囲外）。 */
enum class EndReason {
    FINAL_WEEK,
}

/** 入力した人。参加者の保存と、進行役の代理入力（B5）。 */
sealed interface Editor {
    data class ByParticipant(
        val id: ParticipantId,
    ) : Editor

    /** 進行役の代理入力。表示名を含まず、ゲームの識別子だけを持つ。 */
    data class ByFacilitator(
        val gameId: GameId,
    ) : Editor
}

/** 当週に保存された、1 役割の意思決定。 */
data class DecisionEntry(
    val quantity: Quantity,
    val version: DecisionVersion,
    val editor: Editor,
)

data class SessionData(
    val gameId: GameId,
    val settings: GameSettings,
    val assignments: RoleMap<Set<ParticipantId>>,
    val week: Week,
    val roleStates: RoleMap<RoleState>,
    val decisions: Map<Role, DecisionEntry>,
    val decisionVersions: RoleMap<DecisionVersion>,
    val commitMode: CommitMode,
) {
    /** まだ入力されていない役割（上流から下流の順）。 */
    fun missingRoles(): List<Role> = Role.entries.filter { it !in decisions }

    /** 4 役割の入力がそろっているときだけ、役割ごとの数量。 */
    fun completeDecisions(): RoleMap<Quantity>? =
        nullable { RoleMap.of { role -> ensureNotNull(decisions[role]?.quantity) } }

    /**
     * 保存の事実（参加者の保存も進行役の代理入力も同じ）を採用する。意思決定の版は、当週の保存回数と同じ
     * （保存のたびに 1 増え、確定で 0 に戻る）なので、回数は別に持たない。
     */
    internal fun withDecision(
        role: Role,
        saved: DecisionEntry,
    ): SessionData {
        val versions = decisionVersions.map { r, version -> if (r == role) saved.version else version }
        return copy(decisions = decisions + (role to saved), decisionVersions = versions)
    }

    /** 入れ替えの事実を採用する。[role] の担当者から [removed] を外し、[added] を入れる（ほかの役割・入力・版は変えない）。 */
    internal fun withHolderReplaced(
        role: Role,
        removed: Set<ParticipantId>,
        added: ParticipantId,
    ): SessionData =
        copy(assignments = assignments.map { r, holders -> if (r == role) holders - removed + added else holders })

    /** 当週に、この役割へ保存できる回数が残っているか。 */
    fun hasSaveCapacity(role: Role): Boolean = decisionVersions[role].value < SAVE_LIMIT_PER_ROLE_WEEK

    /** 確定の事実（結果と次週の状態）を採用する。計算し直さない（D5）。最終週は週を進めない。 */
    internal fun afterCommit(event: SessionEvent.WeekCommitted): SessionData =
        copy(
            roleStates = event.nextStates,
            week = if (week == settings.finalWeek) week else week.next() ?: week,
            decisions = emptyMap(),
            decisionVersions = RoleMap.all(DecisionVersion.ZERO),
        )
}

@CoreConcept(
    "進行（プレイ）",
    "進行の状態（未開始・進行中・一時停止・終了）。session ストリームのイベントを畳み込んだ結果で、4 役割の入力を揃えて週を一度だけ確定する整合性の土台",
)
@KeyLandmark(
    map = "ドメイン駆動設計（DDD）",
    layer = "戦術的設計",
    description = "集約（進行）。イベントの畳み込みで復元し、4 役割の入力を揃えて週を一度だけ確定する整合性の境界",
)
sealed interface SessionState {
    val version: StreamVersion

    data object NotStarted : SessionState {
        override val version: StreamVersion = StreamVersion.ZERO
    }

    data class Active(
        val data: SessionData,
        override val version: StreamVersion,
    ) : SessionState

    /** 一時停止中。参加者の保存と週の確定を受け付けない。進行役の代理入力は受け付ける（確定はしない）。 */
    @Term("一時停止", "進行役が進行を止めた状態。参加者は入力の保存も週の確定もできず、入力済みの値は失われない。再開すると最後の確定済みの週から続ける", "AC3.1.1、AC3.1.3")
    data class Paused(
        val data: SessionData,
        override val version: StreamVersion,
    ) : SessionState

    data class Ended(
        val data: SessionData,
        override val version: StreamVersion,
    ) : SessionState
}

sealed interface SessionCommand : Command {
    /** 進行役が、進行中のセッションを一時停止する。 */
    data class PauseSession(
        override val actor: Actor,
        override val at: Instant,
    ) : SessionCommand

    /** 進行役が、一時停止中のセッションを再開する。 */
    data class ResumeSession(
        override val actor: Actor,
        override val at: Instant,
    ) : SessionCommand

    /** 進行役が、確定方式を変える（進行中でも停止中でも。B8）。 */
    data class SetCommitMode(
        override val actor: Actor,
        override val at: Instant,
        val commitMode: CommitMode,
    ) : SessionCommand

    /** 進行役が、画面の週 [requestedWeek] で、[role] の数量を代わりに入力する。意思決定の版は要求しない（最終決定）。 */
    @Term("代理入力", "不在の参加者に代わって、進行役が役割の発注量を入力すること。値・操作者・役割・時刻を履歴に残し、一時停止中も受け付ける（確定はしない）", "AC3.1.2、FR-15")
    data class SubmitProxyDecision(
        override val actor: Actor,
        override val at: Instant,
        val role: Role,
        val requestedWeek: Week,
        val quantity: Quantity,
    ) : SessionCommand

    /** 画面が表示している週 [requestedWeek] と、期待する意思決定の版を持つ。 */
    data class SaveDecision(
        override val actor: Actor,
        override val at: Instant,
        val role: Role,
        val requestedWeek: Week,
        val quantity: Quantity,
        val expectedDecisionVersion: DecisionVersion,
    ) : SessionCommand

    /** 確定しようとしている週 [requestedWeek] と、確定の根拠にした各役割の意思決定の版 [basis]（D10）。 */
    data class CommitWeek(
        override val actor: Actor,
        override val at: Instant,
        val requestedWeek: Week,
        val basis: RoleMap<DecisionVersion>,
    ) : SessionCommand
}

@KeyLandmark(
    map = "ドメイン駆動設計（DDD）",
    layer = "戦術的設計",
    description = "ドメインイベント。進行で起きた事実を、過去形で表す。状態はここから取り戻し、投影の元にもなる",
)
sealed interface SessionEvent : DomainEvent {
    /** 設定と役割の割り当ての写しを運ぶ。以後 session は game を読まない（D4）。[gameId] は session の識別子でもある。 */
    @EventSpec("EV-S01", "StartGame（game ストリームの GameStarted と同一トランザクション）")
    data class SessionStarted(
        val gameId: GameId,
        val settings: GameSettings,
        val assignments: RoleMap<Set<ParticipantId>>,
        val initialStates: RoleMap<RoleState>,
        val commitMode: CommitMode,
    ) : SessionEvent

    @EventSpec("EV-S05", "SaveDecision。進行中、その役割の参加者、意思決定の版が一致")
    data class DecisionSaved(
        val week: Week,
        val role: Role,
        val quantity: Quantity,
        val decisionVersion: DecisionVersion,
        val editor: Editor,
        val submittedRoleCount: Int,
    ) : SessionEvent

    /** 進行役が一時停止した。 */
    @EventSpec("EV-S02", "PauseSession。進行役、進行中")
    data object SessionPaused : SessionEvent

    /** 進行役が再開した。 */
    @EventSpec("EV-S03", "ResumeSession。進行役、一時停止中")
    data object SessionResumed : SessionEvent

    /** 進行役の代理入力。値・入力者（進行役）を残す。操作者と時刻は封筒が持つ（FR-15）。 */
    @EventSpec("EV-S06", "SubmitProxyDecision。進行役、進行中または一時停止中、requestedWeek が現在の週と一致")
    data class ProxyDecisionSubmitted(
        val week: Week,
        val role: Role,
        val quantity: Quantity,
        val decisionVersion: DecisionVersion,
        val editor: Editor,
        val submittedRoleCount: Int,
    ) : SessionEvent

    /** 1 週の事実のすべて。結果と次週の状態を含み、evolve はそれを採用するだけ（D5）。 */
    @EventSpec("EV-S08", "CommitWeek（進行役、進行中、4 役割が揃う、週と意思決定の版が一致）。自動確定（B8）は、最後の入力・再開・方式の変更と同じ追記")
    data class WeekCommitted(
        val week: Week,
        val commitKind: CommitKind,
        val decisions: RoleMap<Quantity>,
        val results: RoleMap<RoleWeekResult>,
        val nextStates: RoleMap<RoleState>,
        val contributors: Int,
    ) : SessionEvent

    /** 確定方式の変更（B8）。以後、4 役割の入力がそろったときの自動確定の有無が変わる。 */
    @EventSpec("EV-S10", "SetCommitMode。進行役、進行中または一時停止中")
    data class CommitModeChanged(
        val commitMode: CommitMode,
    ) : SessionEvent

    @EventSpec("EV-S04", "最終週の WeekCommitted と同じ decide。手動の EndSession は未実装")
    data class SessionEnded(
        val reason: EndReason,
    ) : SessionEvent

    /**
     * 役割の入れ替えで、[role] の担当者の写しを更新した（旧担当者の集合 [removed] を外し、[added] を入れる。D4）。
     * 当週の入力と版は変えない。game の入れ替え（ParticipantReplaced ほか）と同じトランザクションで追記する。
     */
    @EventSpec("EV-S09", "AssignRole（開始後の入れ替え）。game ストリームの ParticipantReplaced と同一トランザクション。進行中または一時停止中")
    data class RoleHolderReplaced(
        val role: Role,
        val removed: Set<ParticipantId>,
        val added: ParticipantId,
    ) : SessionEvent
}

sealed interface SessionError : DomainError {
    /** セッションが始まっていない（未開始）。一時停止中は [Paused]。 */
    data object NotActive : SessionError {
        override val code: String = "session.not_active"
        override val category: ErrorCategory = ErrorCategory.InvalidState
    }

    /** 一時停止中で、保存・確定・二重の停止はできない。 */
    data object Paused : SessionError {
        override val code: String = "session.paused"
        override val category: ErrorCategory = ErrorCategory.InvalidState
    }

    /** 一時停止中でないセッションの再開。 */
    data object NotPaused : SessionError {
        override val code: String = "session.not_paused"
        override val category: ErrorCategory = ErrorCategory.InvalidState
    }

    /** 1 役割・1 週あたりの保存回数の上限（[SAVE_LIMIT_PER_ROLE_WEEK] 回。代理入力を含む）に達した。 */
    data object SaveLimitReached : SessionError {
        override val code: String = "session.save_limit_reached"
        override val category: ErrorCategory = ErrorCategory.InvalidState
    }

    data object AlreadyEnded : SessionError {
        override val code: String = "session.already_ended"
        override val category: ErrorCategory = ErrorCategory.InvalidState
    }

    data object AlreadyStarted : SessionError {
        override val code: String = "session.already_started"
        override val category: ErrorCategory = ErrorCategory.InvalidState
    }

    data class Forbidden(
        val reason: String,
    ) : SessionError {
        override val code: String = "session.forbidden"
        override val category: ErrorCategory = ErrorCategory.Forbidden
    }

    /** 確定で週が進んだ後の要求。共同入力の競合（[DecisionConflict]）とは別。 */
    data class WeekAdvanced(
        val requested: Week,
        val current: Week,
    ) : SessionError {
        override val code: String = "session.week_advanced"
        override val category: ErrorCategory = ErrorCategory.Conflict
    }

    /** 同じ役割の入力で、期待した版が古い。最新値と最後の保存者を返す。 */
    data class DecisionConflict(
        val role: Role,
        val latest: DecisionEntry?,
    ) : SessionError {
        override val code: String = "session.decision_conflict"
        override val category: ErrorCategory = ErrorCategory.Conflict
    }

    /** 確定の根拠にした入力が、確定の前に変わった。現在の値と保存者を返す。 */
    data class DecisionsChanged(
        val week: Week,
        val current: Map<Role, DecisionEntry>,
    ) : SessionError {
        override val code: String = "session.decisions_changed"
        override val category: ErrorCategory = ErrorCategory.Conflict
    }

    /** 4 役割の入力がそろっていない週は確定できない。不足している役割を示す。 */
    data class IncompleteDecisions(
        val missing: List<Role>,
    ) : SessionError {
        override val code: String = "session.incomplete_decisions"
        override val category: ErrorCategory = ErrorCategory.RuleViolation
    }
}

/** 進行中のときだけデータを返す。一時停止中は [SessionError.Paused]。 */
internal fun SessionState.activeData(): Either<SessionError, SessionData> =
    when (this) {
        is SessionState.Active -> data.right()
        is SessionState.Paused -> SessionError.Paused.left()
        is SessionState.NotStarted -> SessionError.NotActive.left()
        is SessionState.Ended -> SessionError.AlreadyEnded.left()
    }

/** 一時停止中のときだけデータを返す。進行中は [SessionError.NotPaused]。 */
private fun SessionState.pausedData(): Either<SessionError, SessionData> =
    when (this) {
        is SessionState.Paused -> data.right()
        is SessionState.Active -> SessionError.NotPaused.left()
        is SessionState.NotStarted -> SessionError.NotActive.left()
        is SessionState.Ended -> SessionError.AlreadyEnded.left()
    }

/** 進行中でも一時停止中でもデータを返す（進行役の代理入力と、役割の入れ替えが使う）。 */
internal fun SessionState.openData(): Either<SessionError, SessionData> =
    when (this) {
        is SessionState.Active -> data.right()
        is SessionState.Paused -> data.right()
        is SessionState.NotStarted -> SessionError.NotActive.left()
        is SessionState.Ended -> SessionError.AlreadyEnded.left()
    }

/** 入力できるのは、その役割に割り当てられた参加者だけ（開始時の写しで確認する）。 */
private fun Raise<SessionError>.editorOf(
    actor: Actor,
    role: Role,
    assignments: RoleMap<Set<ParticipantId>>,
): Editor =
    when (actor) {
        is Actor.Participant -> {
            if (actor.id in assignments[role]) {
                Editor.ByParticipant(actor.id)
            } else {
                raise(SessionError.Forbidden("その役割の参加者だけが入力できる"))
            }
        }

        is Actor.Facilitator, is Actor.Observer, is Actor.Anonymous -> {
            raise(SessionError.Forbidden("その役割の参加者だけが入力できる"))
        }
    }

private fun Raise<SessionError>.saveDecisionEvents(
    data: SessionData,
    command: SessionCommand.SaveDecision,
): List<SessionEvent> {
    val editor = editorOf(command.actor, command.role, data.assignments)
    ensure(command.requestedWeek == data.week) { SessionError.WeekAdvanced(command.requestedWeek, data.week) }
    val current = data.decisionVersions[command.role]
    ensure(command.expectedDecisionVersion == current) {
        SessionError.DecisionConflict(command.role, data.decisions[command.role])
    }
    ensure(data.hasSaveCapacity(command.role)) { SessionError.SaveLimitReached }
    val submitted = (data.decisions.keys + command.role).size
    return listOf(
        SessionEvent.DecisionSaved(data.week, command.role, command.quantity, current.next(), editor, submitted),
    )
}

private fun Raise<SessionError>.proxyDecisionEvents(
    data: SessionData,
    command: SessionCommand.SubmitProxyDecision,
): List<SessionEvent> {
    ensure(command.actor.isFacilitatorOf(data.gameId)) { SessionError.Forbidden("代理入力は進行役だけができる") }
    ensure(command.requestedWeek == data.week) { SessionError.WeekAdvanced(command.requestedWeek, data.week) }
    ensure(data.hasSaveCapacity(command.role)) { SessionError.SaveLimitReached }
    val submitted = (data.decisions.keys + command.role).size
    return listOf(
        SessionEvent.ProxyDecisionSubmitted(
            data.week,
            command.role,
            command.quantity,
            data.decisionVersions[command.role].next(),
            Editor.ByFacilitator(data.gameId),
            submitted,
        ),
    )
}

private fun Raise<SessionError>.pauseEvents(
    data: SessionData,
    command: SessionCommand.PauseSession,
): List<SessionEvent> {
    ensure(command.actor.isFacilitatorOf(data.gameId)) { SessionError.Forbidden("一時停止は進行役だけができる") }
    return listOf(SessionEvent.SessionPaused)
}

private fun Raise<SessionError>.resumeEvents(
    data: SessionData,
    command: SessionCommand.ResumeSession,
): List<SessionEvent> {
    ensure(command.actor.isFacilitatorOf(data.gameId)) { SessionError.Forbidden("再開は進行役だけができる") }
    return listOf(SessionEvent.SessionResumed)
}

/**
 * 入力の保存、代理入力、停止・再開、手動と自動の確定、確定方式の変更の規則は、ここと SessionCommit.kt に集まる。`simulateWeek`（純粋）は確定のときだけ呼び、
 * 結果と次週の状態を `WeekCommitted` に事実として固定する。最終週の確定は `SessionEnded` も返す。
 * 保存・確定は進行中だけ、代理入力は進行中と一時停止中、停止は進行中だけ、再開は一時停止中だけ。
 */
@CoreConcept(
    "進行（プレイ）",
    "進行の規則のすべてが集まる場所。入力の保存・代理入力・停止と再開・手動と自動の確定の可否を決め、事実（イベント）だけを返す。共同入力と自動確定の整合性もここで守る",
)
@KeyLandmark(
    map = "アプリケーションアーキテクチャ",
    layer = "核",
    description = "進行の規則のすべてを、状態とコマンドから事実を決める 1 つの純粋関数に集める。入出力は値だけで、規則を変えても外側の層は変わらない",
)
@GuidedTour(
    name = "イベントソーシング（事実が状態の正本）",
    rank = 1,
    stage = "事実を決める",
    description =
        "状態とコマンドから、起きる事実（イベント）の列を決める純粋関数。状態を書き換えず、事実だけを返す。" +
            "返した事実が、状態の唯一の正本になる",
)
@GuidedTour(
    name = "CQRS（コマンドと問い合わせの分離）",
    rank = 3,
    stage = "コマンド側",
    description =
        "進行の規則を判断し、事実（イベント）の列を返す純粋関数。状態を変えず、副作用も無い。" +
            "返した事実が、次に追記される",
)
fun decideSession(
    state: SessionState,
    command: SessionCommand,
): Either<SessionError, List<SessionEvent>> =
    either {
        when (command) {
            is SessionCommand.SaveDecision -> {
                state.withAutoCommit(saveDecisionEvents(state.activeData().bind(), command))
            }

            is SessionCommand.CommitWeek -> {
                commitWeekEvents(state.activeData().bind(), command)
            }

            is SessionCommand.PauseSession -> {
                pauseEvents(state.activeData().bind(), command)
            }

            is SessionCommand.ResumeSession -> {
                state.withAutoCommit(resumeEvents(state.pausedData().bind(), command))
            }

            is SessionCommand.SubmitProxyDecision -> {
                state.withAutoCommit(proxyDecisionEvents(state.openData().bind(), command))
            }

            is SessionCommand.SetCommitMode -> {
                state.withAutoCommit(setCommitModeEvents(state.openData().bind(), command))
            }
        }
    }
