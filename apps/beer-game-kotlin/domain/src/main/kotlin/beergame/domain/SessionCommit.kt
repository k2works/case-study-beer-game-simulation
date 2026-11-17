package beergame.domain

import arrow.core.raise.Raise
import arrow.core.raise.ensure

/*
 * 週の確定（手動・自動）と確定方式の変更（B8）。入力の保存・停止・再開は Session.kt。
 * 自動確定は、最後の入力（参加者の保存・代理入力）・再開・確定方式の変更と、**同じ追記**で週を確定する（イベントを足すだけで、
 * 競合の扱いは、セッションのストリームの楽観的排他に任せる。同じ週の確定は、手動と自動のどちらかが一度だけ追記できる）。
 */

/** 4 役割の入力から、週の確定のイベントを作る。最終週なら `SessionEnded` も返す。 */
private fun weekCommitEvents(
    data: SessionData,
    decisions: RoleMap<Quantity>,
    kind: CommitKind,
): List<SessionEvent> {
    val outcome = simulateWeek(data.settings.simulation(), data.week, data.roleStates, decisions)
    val committed =
        SessionEvent.WeekCommitted(data.week, kind, decisions, outcome.results, outcome.nextStates, Role.entries.size)
    return if (data.week == data.settings.finalWeek) {
        listOf(committed, SessionEvent.SessionEnded(EndReason.FINAL_WEEK))
    } else {
        listOf(committed)
    }
}

internal fun Raise<SessionError>.commitWeekEvents(
    data: SessionData,
    command: SessionCommand.CommitWeek,
): List<SessionEvent> {
    ensure(command.actor.isFacilitatorOf(data.gameId)) { SessionError.Forbidden("確定は進行役だけができる") }
    // 判定順 1: 週が違えば WeekAdvanced
    ensure(command.requestedWeek == data.week) { SessionError.WeekAdvanced(command.requestedWeek, data.week) }
    // 判定順 2: 週は同じで、確定の根拠にした入力の版が現在と違えば DecisionsChanged
    ensure(command.basis == data.decisionVersions) { SessionError.DecisionsChanged(data.week, data.decisions) }
    val decisions = data.completeDecisions() ?: raise(SessionError.IncompleteDecisions(data.missingRoles()))
    return weekCommitEvents(data, decisions, CommitKind.MANUAL)
}

internal fun Raise<SessionError>.setCommitModeEvents(
    data: SessionData,
    command: SessionCommand.SetCommitMode,
): List<SessionEvent> {
    ensure(command.actor.isFacilitatorOf(data.gameId)) { SessionError.Forbidden("確定方式の変更は進行役だけができる") }
    return listOf(SessionEvent.CommitModeChanged(command.commitMode))
}

/**
 * [events] を採用した結果、自動確定が有効で、進行中で、4 役割の入力がそろっていれば、同じ追記で確定（AUTO）を足す。
 * 一時停止中は確定しない（再開のイベントを採用したあとの状態で判定するので、再開のときに確定する）。
 */
internal fun SessionState.withAutoCommit(events: List<SessionEvent>): List<SessionEvent> {
    val data = (events.fold(this, ::evolveSession) as? SessionState.Active)?.data
    val decisions = data?.takeIf { it.commitMode == CommitMode.AUTO }?.completeDecisions()
    return if (data == null ||
        decisions == null
    ) {
        events
    } else {
        events + weekCommitEvents(data, decisions, CommitKind.AUTO)
    }
}
