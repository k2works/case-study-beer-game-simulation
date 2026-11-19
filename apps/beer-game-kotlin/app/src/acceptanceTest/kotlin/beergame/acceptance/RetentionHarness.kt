package beergame.acceptance

import arrow.core.Either
import beergame.application.AppFailure
import beergame.application.DeletionReceipt
import beergame.application.PersistenceFailure
import beergame.application.RetentionStore
import beergame.application.RetentionSweeper
import beergame.application.SweepReport
import beergame.domain.GameId
import beergame.persistence.retentionStore
import kotlinx.coroutines.runBlocking
import java.time.Duration
import java.time.Instant
import java.util.UUID
import java.util.concurrent.atomic.AtomicInteger
import javax.sql.DataSource

private const val KEY_BYTES = 32
private const val RECEIPT_KEY_SEED = 9

/** 削除の処理の差し込み口。残りの回数だけ、`game_roots` の削除の前に失敗する（失敗した試行は、何も消さない）。 */
private class FlakyStore(
    private val inner: RetentionStore,
    private val failures: AtomicInteger,
) : RetentionStore by inner {
    override suspend fun delete(
        gameId: GameId,
        receipt: DeletionReceipt,
    ): Either<AppFailure, Unit> =
        if (failures.getAndUpdate { if (it > 0) it - 1 else 0 } > 0) {
            Either.Left(AppFailure.Persistence(PersistenceFailure("retention.delete", "障害の注入")))
        } else {
            inner.delete(gameId, receipt)
        }
}

/**
 * 保持削除の掃引（B11）の試験用の窓口。本番の `retention` モードと同じ掃引（[RetentionSweeper]）を、同じ永続化の実装
 * （[retentionStore]）に対して行う。時計は、実時間に、進めた分を足した値（[advance]。実際には待たない）。
 * 揺らぎは 0（試験の再現のため）。
 */
class RetentionHarness(
    dataSource: DataSource,
) {
    private val failures = AtomicInteger(0)
    private var elapsed: Duration = Duration.ZERO
    private val sweeper =
        RetentionSweeper(
            store = FlakyStore(retentionStore(dataSource), failures),
            clock = { Instant.now().plus(elapsed) },
            newId = { UUID.randomUUID() },
            jitter = { Duration.ZERO },
            receiptKey = ByteArray(KEY_BYTES) { (it + RECEIPT_KEY_SEED).toByte() },
        )
    private val reports = mutableListOf<SweepReport>()

    val last: SweepReport get() = reports.last()

    /** 通知された（再試行をやめた）ゲームの数。全掃引の合計。 */
    val abandonedCount: Int get() = reports.sumOf { it.abandoned.size }

    fun advance(by: Duration) {
        elapsed = elapsed.plus(by)
    }

    /** 次の [times] 回の削除（`game_roots` の削除）が、失敗する。 */
    fun failNext(times: Int) = failures.set(times)

    fun sweep(): SweepReport {
        val report = runBlocking { sweeper.sweep() }.fold({ error("掃引できない: $it") }, { it })
        reports += report
        return report
    }
}
