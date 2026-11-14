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
 * Session 集約（進行。ストリーム `session`）。B1 の範囲: 入力の保存、手動の確定、最終週での終了。
 * 停止・再開・代理入力・確定方式の変更・自動確定は後続の Bolt（B5、B8）。
 * 開始（SessionStarted）は startGame が作る。
 */

/** 確定の方式（イベントに残す）。B1 は手動だけ。 */
enum class CommitKind {
    MANUAL,
}

/** 終了の理由。B1 は最終週の確定だけ（進行役による終了は B5）。 */
enum class EndReason {
    FINAL_WEEK,
}

/** 入力した人。B1 は参加者だけ（進行役の代理入力は B5）。 */
sealed interface Editor {
    data class ByParticipant(
        val id: ParticipantId,
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

    internal fun withDecision(event: SessionEvent.DecisionSaved): SessionData {
        val saved = DecisionEntry(event.quantity, event.decisionVersion, event.editor)
        val versions =
            decisionVersions.map { role, version ->
                if (role ==
                    event.role
                ) {
                    event.decisionVersion
                } else {
                    version
                }
            }
        return copy(decisions = decisions + (event.role to saved), decisionVersions = versions)
    }

    /** 確定の事実（結果と次週の状態）を採用する。計算し直さない（D5）。最終週は週を進めない。 */
    internal fun afterCommit(event: SessionEvent.WeekCommitted): SessionData =
        copy(
            roleStates = event.nextStates,
            week = if (week == settings.finalWeek) week else week.next() ?: week,
            decisions = emptyMap(),
            decisionVersions = RoleMap.all(DecisionVersion.ZERO),
        )
}

sealed interface SessionState {
    val version: StreamVersion

    data object NotStarted : SessionState {
        override val version: StreamVersion = StreamVersion.ZERO
    }

    data class Active(
        val data: SessionData,
        override val version: StreamVersion,
    ) : SessionState

    data class Ended(
        val data: SessionData,
        override val version: StreamVersion,
    ) : SessionState
}

sealed interface SessionCommand : Command {
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

sealed interface SessionEvent : DomainEvent {
    /** 設定と役割の割り当ての写しを運ぶ。以後 session は game を読まない（D4）。[gameId] は session の識別子でもある。 */
    data class SessionStarted(
        val gameId: GameId,
        val settings: GameSettings,
        val assignments: RoleMap<Set<ParticipantId>>,
        val initialStates: RoleMap<RoleState>,
        val commitMode: CommitMode,
    ) : SessionEvent

    data class DecisionSaved(
        val week: Week,
        val role: Role,
        val quantity: Quantity,
        val decisionVersion: DecisionVersion,
        val editor: Editor,
        val submittedRoleCount: Int,
    ) : SessionEvent

    /** 1 週の事実のすべて。結果と次週の状態を含み、evolve はそれを採用するだけ（D5）。 */
    data class WeekCommitted(
        val week: Week,
        val commitKind: CommitKind,
        val decisions: RoleMap<Quantity>,
        val results: RoleMap<RoleWeekResult>,
        val nextStates: RoleMap<RoleState>,
        val contributors: Int,
    ) : SessionEvent

    data class SessionEnded(
        val reason: EndReason,
    ) : SessionEvent
}

sealed interface SessionError : DomainError {
    /** 進行中でない（未開始）。一時停止中も含む（停止は B5）。 */
    data object NotActive : SessionError {
        override val code: String = "session.not_active"
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

private fun SessionState.activeData(): Either<SessionError, SessionData> =
    when (this) {
        is SessionState.Active -> data.right()
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

        is Actor.Facilitator, is Actor.Anonymous -> {
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
    val submitted = (data.decisions.keys + command.role).size
    return listOf(
        SessionEvent.DecisionSaved(data.week, command.role, command.quantity, current.next(), editor, submitted),
    )
}

private fun Raise<SessionError>.commitWeekEvents(
    data: SessionData,
    command: SessionCommand.CommitWeek,
): List<SessionEvent> {
    ensure(command.actor.isFacilitatorOf(data.gameId)) { SessionError.Forbidden("確定は進行役だけができる") }
    // 判定順 1: 週が違えば WeekAdvanced
    ensure(command.requestedWeek == data.week) { SessionError.WeekAdvanced(command.requestedWeek, data.week) }
    // 判定順 2: 週は同じで、確定の根拠にした入力の版が現在と違えば DecisionsChanged
    ensure(command.basis == data.decisionVersions) { SessionError.DecisionsChanged(data.week, data.decisions) }
    val decisions = data.completeDecisions() ?: raise(SessionError.IncompleteDecisions(data.missingRoles()))
    val outcome = simulateWeek(data.settings.simulation(), data.week, data.roleStates, decisions)
    val committed =
        SessionEvent.WeekCommitted(
            data.week,
            CommitKind.MANUAL,
            decisions,
            outcome.results,
            outcome.nextStates,
            Role.entries.size,
        )
    return if (data.week == data.settings.finalWeek) {
        listOf(committed, SessionEvent.SessionEnded(EndReason.FINAL_WEEK))
    } else {
        listOf(committed)
    }
}

/**
 * 入力の保存と手動の確定の規則は、すべてここに集まる。`simulateWeek`（純粋）は確定のときだけ呼び、
 * 結果と次週の状態を `WeekCommitted` に事実として固定する。最終週の確定は `SessionEnded` も返す。
 */
fun decideSession(
    state: SessionState,
    command: SessionCommand,
): Either<SessionError, List<SessionEvent>> =
    either {
        val data = state.activeData().bind()
        when (command) {
            is SessionCommand.SaveDecision -> saveDecisionEvents(data, command)
            is SessionCommand.CommitWeek -> commitWeekEvents(data, command)
        }
    }

/** 進行中のときだけデータを更新して版を進める。decide が作らない列は、状態を変えずに返す。 */
private fun SessionState.updateActive(update: (SessionData) -> SessionData): SessionState =
    when (this) {
        is SessionState.Active -> SessionState.Active(update(data), version.next())
        is SessionState.NotStarted, is SessionState.Ended -> this
    }

/**
 * イベントを状態へ畳み込む。全域（例外を投げない。強制キャストを使わない）。
 * `WeekCommitted` の `nextStates` はそのまま採用し、`simulateWeek` を呼ばない（D5）。
 * decide が作らない列は、状態を変えずに返す（版も増えない。検知は [replaySession]）。
 */
fun evolveSession(
    state: SessionState,
    event: SessionEvent,
): SessionState =
    when (event) {
        is SessionEvent.SessionStarted -> {
            when (state) {
                is SessionState.NotStarted -> {
                    SessionState.Active(
                        SessionData(
                            gameId = event.gameId,
                            settings = event.settings,
                            assignments = event.assignments,
                            week = Week.FIRST,
                            roleStates = event.initialStates,
                            decisions = emptyMap(),
                            decisionVersions = RoleMap.all(DecisionVersion.ZERO),
                            commitMode = event.commitMode,
                        ),
                        state.version.next(),
                    )
                }

                is SessionState.Active, is SessionState.Ended -> {
                    state
                }
            }
        }

        is SessionEvent.DecisionSaved -> {
            state.updateActive { it.withDecision(event) }
        }

        is SessionEvent.WeekCommitted -> {
            state.updateActive { it.afterCommit(event) }
        }

        is SessionEvent.SessionEnded -> {
            when (state) {
                is SessionState.Active -> SessionState.Ended(state.data, state.version.next())
                is SessionState.NotStarted, is SessionState.Ended -> state
            }
        }
    }
