package beergame.domain

/*
 * Session 集約の evolve（イベントを状態へ畳み込む）。decide は Session.kt。
 * 状態は NotStarted → Active ⇄ Paused → Ended。decide が作らない列は、状態を変えずに返す。
 */

/** 進行中・一時停止中のときだけデータを更新して版を進める（種類は変えない）。decide が作らない列は、状態を変えずに返す。 */
private fun SessionState.updateData(update: (SessionData) -> SessionData): SessionState =
    when (this) {
        is SessionState.Active -> SessionState.Active(update(data), version.next())
        is SessionState.Paused -> SessionState.Paused(update(data), version.next())
        is SessionState.NotStarted, is SessionState.Ended -> this
    }

private fun SessionState.started(event: SessionEvent.SessionStarted): SessionState =
    when (this) {
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
                version.next(),
            )
        }

        is SessionState.Active, is SessionState.Paused, is SessionState.Ended -> {
            this
        }
    }

/** 進行中だけが一時停止になる。 */
private fun SessionState.paused(): SessionState =
    when (this) {
        is SessionState.Active -> SessionState.Paused(data, version.next())
        is SessionState.NotStarted, is SessionState.Paused, is SessionState.Ended -> this
    }

/** 一時停止中だけが進行中に戻る（データは変えない）。 */
private fun SessionState.resumed(): SessionState =
    when (this) {
        is SessionState.Paused -> SessionState.Active(data, version.next())
        is SessionState.NotStarted, is SessionState.Active, is SessionState.Ended -> this
    }

/** 確定方式の変更（進行中・一時停止中。データの確定方式だけを変える）。 */
private fun SessionState.commitModeChanged(event: SessionEvent.CommitModeChanged): SessionState =
    updateData { it.copy(commitMode = event.commitMode) }

/** 進行中・一時停止中のどちらからも終了になる。 */
private fun SessionState.ended(): SessionState =
    when (this) {
        is SessionState.Active -> SessionState.Ended(data, version.next())
        is SessionState.Paused -> SessionState.Ended(data, version.next())
        is SessionState.NotStarted, is SessionState.Ended -> this
    }

/**
 * イベントを状態へ畳み込む。全域（例外を投げない。強制キャストを使わない）。
 * `WeekCommitted` の `nextStates` はそのまま採用し、`simulateWeek` を呼ばない（D5）。
 * decide が作らない列は、状態を変えずに返す（版も増えない。検知は [replaySession]）。
 */
@GuidedTour(
    name = "イベントソーシング（事実が状態の正本）",
    rank = 8,
    stage = "状態を取り戻す",
    description = "事実を 1 つずつ状態へ畳み込む。規則は持たず、確定済みの結果を採用するだけなので、再生しても同じ状態に戻る",
)
@CoreConcept(
    "進行（プレイ）",
    "事実（イベント）を状態へ畳み込む。規則を持たず、確定済みの結果を採用するだけなので、あとから再生しても同じ状態に戻る（イベントソーシングの土台）",
)
fun evolveSession(
    state: SessionState,
    event: SessionEvent,
): SessionState =
    when (event) {
        is SessionEvent.SessionStarted -> {
            state.started(event)
        }

        is SessionEvent.SessionPaused -> {
            state.paused()
        }

        is SessionEvent.SessionResumed -> {
            state.resumed()
        }

        is SessionEvent.DecisionSaved -> {
            state.updateData {
                it.withDecision(
                    event.role,
                    DecisionEntry(event.quantity, event.decisionVersion, event.editor),
                )
            }
        }

        is SessionEvent.ProxyDecisionSubmitted -> {
            state.updateData {
                it.withDecision(
                    event.role,
                    DecisionEntry(event.quantity, event.decisionVersion, event.editor),
                )
            }
        }

        is SessionEvent.WeekCommitted -> {
            state.updateData { it.afterCommit(event) }
        }

        is SessionEvent.CommitModeChanged -> {
            state.commitModeChanged(event)
        }

        is SessionEvent.SessionEnded -> {
            state.ended()
        }

        is SessionEvent.RoleHolderReplaced -> {
            state.updateData { it.withHolderReplaced(event.role, event.removed, event.added) }
        }
    }
