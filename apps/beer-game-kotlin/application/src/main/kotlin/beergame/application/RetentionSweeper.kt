package beergame.application

import arrow.core.Either
import arrow.core.raise.either
import beergame.domain.GameId
import beergame.domain.RetentionCommand
import beergame.domain.RetentionEvent
import beergame.domain.RetentionSaga
import beergame.domain.RetentionState
import java.time.Duration
import java.time.Instant
import java.util.UUID

/*
 * 保持削除の実行（B11。US5.1）。期限に達したゲームを検出し、RetentionSaga（純粋な decide / evolve）に従って、
 * 1 ゲームずつ削除する。完了は、`game_roots` の連鎖削除が成功したときだけ（半分の削除を完了としない）。
 * 失敗は、試行の履歴に記録して、次の試行の時刻まで待つ。最大 5 回で再試行をやめ、報告に載せる（通知は、呼び出し側の責務）。
 * このクラスは、`retention` モード（定期のタスク）だけが使う。API のプロセスは使わない。
 */

/** 削除の対象のゲームと、手続きの現在の状態。まだ試行していなければ、[deletionId] は null で、[state] は [RetentionState.Pending]。 */
data class DueDeletion(
    val gameId: GameId,
    val deletionId: UUID?,
    val state: RetentionState,
)

/** 削除の受領記録。ゲームを特定しない（[gameReferenceDigest] は、ゲームの ID の鍵付き HMAC）。 */
data class DeletionReceipt(
    val deletionId: UUID,
    val gameReferenceDigest: String,
    val recordedAt: Instant,
    val expiresAt: Instant,
)

/**
 * 削除の永続化（`deletion_*`、`game_roots`）。**削除用のロール**で動く接続だけが使う。
 * [delete] は、`game_roots` の削除（連鎖で全表の行が消える）、`deletion_runs`・`deletion_attempts` の削除、受領記録の挿入を、
 * 1 つのトランザクションで行う。失敗したら、何も消えない。
 */
interface RetentionStore {
    /** 期限に達し、まだ削除が終わっていないゲーム。次の試行の時刻に達していない、または再試行をやめたものは含めない。 */
    suspend fun due(
        now: Instant,
        limit: Int,
    ): Either<AppFailure, List<DueDeletion>>

    /** 試行の開始を記録する（進行を `IN_PROGRESS` にし、試行の履歴を足す）。 */
    suspend fun begin(
        gameId: GameId,
        deletionId: UUID,
        started: RetentionEvent.DeletionStarted,
    ): Either<AppFailure, Unit>

    suspend fun delete(
        gameId: GameId,
        receipt: DeletionReceipt,
    ): Either<AppFailure, Unit>

    /** 失敗を記録する。[RetentionEvent.DeletionFailed.nextAttemptAt] が無ければ、再試行をやめた。 */
    suspend fun fail(
        deletionId: UUID,
        failed: RetentionEvent.DeletionFailed,
    ): Either<AppFailure, Unit>

    /** 期限（`expires_at`）を過ぎた受領記録を消す。消した件数を返す。 */
    suspend fun purgeReceipts(now: Instant): Either<AppFailure, Int>
}

/** 失敗した試行。[nextAttemptAt] が無ければ、再試行の上限に達して、やめた。 */
data class DeletionFailure(
    val gameId: GameId,
    val attempt: Int,
    val failureCode: String,
    val nextAttemptAt: Instant?,
)

/** 1 回の掃引の結果。 */
data class SweepReport(
    val completed: List<GameId>,
    val failures: List<DeletionFailure>,
    val purgedReceipts: Int,
) {
    /** 再試行をやめたゲーム（通知の対象）。 */
    val abandoned: List<DeletionFailure> get() = failures.filter { it.nextAttemptAt == null }
}

class RetentionSweeper(
    private val store: RetentionStore,
    private val clock: Now,
    private val newId: NewId,
    /** バックオフに足す揺らぎ（0 以上）。乱数は、ここで引く（ドメインは乱数を読まない）。 */
    private val jitter: suspend () -> Duration,
    /** 受領記録のダイジェストの鍵（32 バイト）。 */
    private val receiptKey: ByteArray,
    private val batchSize: Int = DEFAULT_BATCH_SIZE,
) {
    suspend fun sweep(): Either<AppFailure, SweepReport> =
        either {
            val due = store.due(clock(), batchSize).bind()
            val outcomes = due.map { delete(it).bind() }
            SweepReport(
                completed = outcomes.filterIsInstance<Outcome.Completed>().map { it.gameId },
                failures = outcomes.filterIsInstance<Outcome.Failed>().map { it.failure },
                purgedReceipts = store.purgeReceipts(clock()).bind(),
            )
        }

    private sealed interface Outcome {
        data class Completed(
            val gameId: GameId,
        ) : Outcome

        data class Failed(
            val failure: DeletionFailure,
        ) : Outcome

        data object Skipped : Outcome
    }

    /** 削除の失敗（`delete` の Left）は、記録して次へ進む。記録そのものの失敗（`begin`・`fail`）は、掃引の失敗にする。 */
    private suspend fun delete(game: DueDeletion): Either<AppFailure, Outcome> =
        either {
            val at = clock()
            val started =
                RetentionSaga.decide(game.state, RetentionCommand.StartDeletion(at)).getOrNull()
                    as? RetentionEvent.DeletionStarted
            if (started == null) {
                Outcome.Skipped
            } else {
                val deletionId = game.deletionId ?: newId()
                store.begin(game.gameId, deletionId, started).bind()
                val receipt = receipt(game.gameId, deletionId, at)
                val deleted = store.delete(game.gameId, receipt)
                deleted.fold(
                    { failure -> failed(game.gameId, deletionId, started, failure, at).bind() },
                    { Outcome.Completed(game.gameId) },
                )
            }
        }

    private suspend fun failed(
        gameId: GameId,
        deletionId: UUID,
        started: RetentionEvent.DeletionStarted,
        cause: AppFailure,
        at: Instant,
    ): Either<AppFailure, Outcome> =
        either {
            val state = RetentionSaga.evolve(started)
            val command = RetentionCommand.RecordFailure(failureCodeOf(cause), at, jitter())
            val event = RetentionSaga.decide(state, command).getOrNull() as? RetentionEvent.DeletionFailed
            if (event == null) {
                Outcome.Skipped
            } else {
                store.fail(deletionId, event).bind()
                Outcome.Failed(DeletionFailure(gameId, event.attempt, event.failureCode, event.nextAttemptAt))
            }
        }

    private fun receipt(
        gameId: GameId,
        deletionId: UUID,
        at: Instant,
    ): DeletionReceipt =
        DeletionReceipt(
            deletionId,
            Hmac.hex(receiptKey, listOf(RECEIPT_PURPOSE, gameId.value.toString())),
            at,
            at.plus(RECEIPT_RETENTION),
        )

    companion object {
        const val DEFAULT_BATCH_SIZE = 100
        private const val RECEIPT_PURPOSE = "retention-receipt"
        private val RECEIPT_RETENTION: Duration = Duration.ofDays(365)
    }
}

/** 失敗の分類（`deletion_runs.last_failure_code`）。値（ゲームの ID・SQL の内容など）を含めない。 */
internal fun failureCodeOf(failure: AppFailure): String =
    when (failure) {
        is AppFailure.Persistence -> "persistence.${failure.failure.operation}"
        else -> "app.${failure::class.simpleName.orEmpty().lowercase()}"
    }
