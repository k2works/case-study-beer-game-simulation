package beergame.domain

import arrow.core.Either
import arrow.core.left
import arrow.core.right
import java.time.Duration
import java.time.Instant

/*
 * 保持削除の手続き（RetentionSaga。B11、US5.1。D8）。ES のストリームにはせず、状態を持つプロセスマネージャーとして扱う。
 * 状態遷移は純粋な decide / evolve で表し、時計も乱数も読まない（時刻と揺らぎは、コマンドの値として受け取る）。
 * 永続化（deletion_runs ほか）と実行（掃引）は、adapter-persistence と application の責務。
 */

/** 保持方針。保持日数・保持開始（暫定で作成時。M5）・削除期限。方針は 1 ゲームにつき 1 つで、作成後に変わらない（版を持たない）。 */
data class RetentionPolicy(
    val retentionDays: RetentionDays,
    val startsAt: Instant,
    val deleteAfter: Instant,
) {
    /** [now] の時点で、削除の期限に達しているか。 */
    fun isDue(now: Instant): Boolean = !now.isBefore(deleteAfter)

    companion object {
        /** 保持の開始時刻と日数から、削除期限（開始 + 日数）を求める。 */
        fun starting(
            days: RetentionDays,
            startsAt: Instant,
        ): RetentionPolicy = RetentionPolicy(days, startsAt, startsAt.plus(Duration.ofDays(days.value.toLong())))
    }
}

/** 削除の手続きの状態。[Abandoned] は、最大の試行回数の失敗の後で、再試行をやめた状態（永続化は `FAILED` で次の試行の時刻が無い）。 */
sealed interface RetentionState {
    data object Pending : RetentionState

    /** 試行中。[leaseUntil] を過ぎても完了も失敗も記録されなければ、プロセスの停止とみなして、次の試行を始められる。 */
    data class InProgress(
        val attempt: Int,
        val leaseUntil: Instant,
    ) : RetentionState

    data class Failed(
        val attempt: Int,
        val nextAttemptAt: Instant,
        val failureCode: String,
    ) : RetentionState

    data class Abandoned(
        val attempt: Int,
        val failureCode: String,
    ) : RetentionState

    data object Completed : RetentionState
}

sealed interface RetentionCommand {
    data class StartDeletion(
        val now: Instant,
    ) : RetentionCommand

    /** [jitter] は、揺らぎ（0 以上。バックオフに足す）。乱数は、ポートの側で引いて渡す。 */
    data class RecordFailure(
        val failureCode: String,
        val now: Instant,
        val jitter: Duration,
    ) : RetentionCommand

    data object RecordCompletion : RetentionCommand
}

sealed interface RetentionEvent {
    data class DeletionStarted(
        val attempt: Int,
        val at: Instant,
        val leaseUntil: Instant,
    ) : RetentionEvent

    /** [nextAttemptAt] が null のとき、再試行をやめた（試行回数の上限）。 */
    data class DeletionFailed(
        val attempt: Int,
        val failureCode: String,
        val nextAttemptAt: Instant?,
    ) : RetentionEvent

    data object DeletionCompleted : RetentionEvent
}

/** 命令を受け付けない理由。 */
sealed interface RetentionRejection {
    /** 完了後は、同じゲームの削除を始められない（一度だけ）。 */
    data object AlreadyCompleted : RetentionRejection

    /** 再試行の上限に達して、やめている。 */
    data object RetriesExhausted : RetentionRejection

    /** 次の試行の時刻（または、試行中の貸出の期限）の前。 */
    data class NotYetDue(
        val at: Instant,
    ) : RetentionRejection

    /** 試行中でないのに、失敗または完了を記録しようとした。 */
    data object NotInProgress : RetentionRejection
}

private const val BASE_BACKOFF_MINUTES = 5L
private const val LEASE_MINUTES = 30L

object RetentionSaga {
    /** 最大の試行回数。5 回続けて失敗したら、再試行をやめて通知する。 */
    const val MAX_ATTEMPTS = 5

    /** バックオフの基準。試行 n 回目の失敗の後は、基準 × 2^(n-1) に揺らぎを足す。 */
    val BASE_BACKOFF: Duration = Duration.ofMinutes(BASE_BACKOFF_MINUTES)

    /** 試行中の貸出の期間。この間に完了も失敗も記録されなければ、停止とみなす。 */
    val LEASE: Duration = Duration.ofMinutes(LEASE_MINUTES)

    fun backoff(
        attempt: Int,
        jitter: Duration,
    ): Duration = BASE_BACKOFF.multipliedBy(1L shl (attempt - 1).coerceIn(0, MAX_ATTEMPTS)).plus(jitter)

    fun decide(
        state: RetentionState,
        command: RetentionCommand,
    ): Either<RetentionRejection, RetentionEvent> =
        when (command) {
            is RetentionCommand.StartDeletion -> start(state, command.now)
            is RetentionCommand.RecordFailure -> fail(state, command)
            RetentionCommand.RecordCompletion -> complete(state)
        }

    private fun start(
        state: RetentionState,
        now: Instant,
    ): Either<RetentionRejection, RetentionEvent> =
        when (state) {
            RetentionState.Pending -> started(1, now)
            RetentionState.Completed -> RetentionRejection.AlreadyCompleted.left()
            is RetentionState.Abandoned -> RetentionRejection.RetriesExhausted.left()
            is RetentionState.Failed -> retryAt(state.nextAttemptAt, state.attempt, now)
            is RetentionState.InProgress -> retryAt(state.leaseUntil, state.attempt, now)
        }

    private fun retryAt(
        at: Instant,
        attempt: Int,
        now: Instant,
    ): Either<RetentionRejection, RetentionEvent> =
        when {
            now.isBefore(at) -> RetentionRejection.NotYetDue(at).left()
            attempt >= MAX_ATTEMPTS -> RetentionRejection.RetriesExhausted.left()
            else -> started(attempt + 1, now)
        }

    private fun started(
        attempt: Int,
        now: Instant,
    ): Either<RetentionRejection, RetentionEvent> =
        RetentionEvent.DeletionStarted(attempt, now, now.plus(LEASE)).right()

    private fun fail(
        state: RetentionState,
        command: RetentionCommand.RecordFailure,
    ): Either<RetentionRejection, RetentionEvent> =
        if (state is RetentionState.InProgress) {
            val next =
                if (state.attempt >= MAX_ATTEMPTS) {
                    null
                } else {
                    command.now.plus(backoff(state.attempt, command.jitter))
                }
            RetentionEvent.DeletionFailed(state.attempt, command.failureCode, next).right()
        } else {
            RetentionRejection.NotInProgress.left()
        }

    private fun complete(state: RetentionState): Either<RetentionRejection, RetentionEvent> =
        if (state is RetentionState.InProgress) {
            RetentionEvent.DeletionCompleted.right()
        } else {
            RetentionRejection.NotInProgress.left()
        }

    /** イベントが、遷移の先の状態を決める（試行の回数・貸出の期限・次の試行の時刻は、イベントが運ぶ。前の状態に依らない）。 */
    fun evolve(event: RetentionEvent): RetentionState =
        when (event) {
            is RetentionEvent.DeletionStarted -> RetentionState.InProgress(event.attempt, event.leaseUntil)
            is RetentionEvent.DeletionFailed -> failed(event)
            RetentionEvent.DeletionCompleted -> RetentionState.Completed
        }

    private fun failed(event: RetentionEvent.DeletionFailed): RetentionState =
        event.nextAttemptAt?.let { RetentionState.Failed(event.attempt, it, event.failureCode) }
            ?: RetentionState.Abandoned(event.attempt, event.failureCode)
}
