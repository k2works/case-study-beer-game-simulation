package beergame.application

import arrow.core.Either
import arrow.core.left
import arrow.core.right
import beergame.domain.GameId
import beergame.domain.RetentionEvent
import beergame.domain.RetentionSaga
import beergame.domain.RetentionState
import beergame.domain.Role
import beergame.domain.StreamVersion
import io.kotest.core.spec.style.FunSpec
import io.kotest.matchers.shouldBe
import io.kotest.matchers.string.shouldNotContain
import kotlinx.coroutines.runBlocking
import java.time.Duration
import java.time.Instant
import java.util.UUID

/*
 * 保持と削除（B11。US5.1）。保持状態の問い合わせ（進行役だけ）と、削除の掃引（RetentionSweeper）。
 * 掃引は、メモリ上の削除の永続化（[MemoryRetentionStore]）に対して動かし、状態遷移（再試行・放棄・一度だけ）を確かめる。
 * 実際の連鎖削除と全表の検査は、adapter-persistence の統合テストと受入（@api）が確かめる。
 */

private val DELETE_AFTER: Instant = T0.plus(Duration.ofDays(90))
private val RECEIPT_KEY = ByteArray(32) { (it + 5).toByte() }

private fun game(n: Int) = GameId(UUID(1L, n.toLong()))

private fun World.projectedWith(
    game: Prepared,
    retention: ProjectedRetention?,
) {
    projectedGame =
        ProjectedGame(
            gameId = game.gameId,
            status = GameStatus.STARTED,
            finalWeek = 3,
            joinCode = game.created.joinCode,
            participants = emptyList(),
            session = null,
            roleStates = emptyMap(),
            decisions = emptyMap(),
            results = emptyList(),
            versions = Versions(StreamVersion.of(5L).ok(), StreamVersion.of(8L).ok()),
            retention = retention,
        )
}

private fun policy(run: ProjectedDeletionRun? = null) = ProjectedRetention(90, T0, DELETE_AFTER, run)

private fun World.retention(
    game: Prepared,
    credential: String?,
) = runBlocking { ports.retention(game.gameId, credential) }

/** メモリ上の削除の永続化。削除の進行を持ち、失敗を注入できる。 */
private class MemoryRetentionStore(
    var due: List<DueDeletion> = emptyList(),
) : RetentionStore {
    var failDeletes = 0
    var failBegin = false
    val started = mutableListOf<RetentionEvent.DeletionStarted>()
    val failed = mutableListOf<RetentionEvent.DeletionFailed>()
    val deleted = mutableListOf<GameId>()
    val receipts = mutableListOf<DeletionReceipt>()
    var purged = 0

    override suspend fun due(
        now: Instant,
        limit: Int,
    ): Either<AppFailure, List<DueDeletion>> = due.take(limit).right()

    override suspend fun begin(
        gameId: GameId,
        deletionId: UUID,
        started: RetentionEvent.DeletionStarted,
    ): Either<AppFailure, Unit> =
        if (failBegin) {
            persistenceFailure("retention.begin").left()
        } else {
            this.started += started
            Unit.right()
        }

    override suspend fun delete(
        gameId: GameId,
        receipt: DeletionReceipt,
    ): Either<AppFailure, Unit> =
        if (failDeletes > 0) {
            failDeletes--
            persistenceFailure("retention.delete").left()
        } else {
            deleted += gameId
            receipts += receipt
            Unit.right()
        }

    override suspend fun fail(
        deletionId: UUID,
        failed: RetentionEvent.DeletionFailed,
    ): Either<AppFailure, Unit> {
        this.failed += failed
        return Unit.right()
    }

    override suspend fun purgeReceipts(now: Instant): Either<AppFailure, Int> = purged.right()
}

private fun persistenceFailure(operation: String): AppFailure =
    AppFailure.Persistence(PersistenceFailure(operation, "障害の注入"))

private fun sweeper(
    store: RetentionStore,
    at: Instant = DELETE_AFTER,
    jitter: Duration = Duration.ZERO,
) = RetentionSweeper(
    store = store,
    clock = { at },
    newId = { UUID(2L, 2L) },
    jitter = { jitter },
    receiptKey = RECEIPT_KEY,
    batchSize = 10,
)

private fun sweep(sweeper: RetentionSweeper): SweepReport = runBlocking { sweeper.sweep() }.ok()

class RetentionSpec :
    FunSpec({
        context("保持状態の問い合わせ") {
            test("[B11/AC5.1.1] Given 方針の行がある When 進行役が取得する Then 保持日数・削除予定日・予定の状態・バックアップの残存日数が返る") {
                val world = World()
                val game = world.started()
                world.projectedWith(game, policy())

                val view = world.retention(game, game.facilitator).ok()

                view.retentionDays shouldBe 90
                view.startsAt shouldBe T0
                view.deleteAfter shouldBe DELETE_AFTER
                view.status shouldBe RetentionStatus.SCHEDULED
                view.attempt shouldBe 0
                view.nextAttemptAt shouldBe null
                view.backupRetentionDays shouldBe 7
            }

            test("[B11/AC5.1.3] Given 削除の進行の行がある When 取得する Then 状態が、削除中・再試行待ち・再試行をやめた、に写る") {
                val world = World()
                val game = world.started()
                val next = T0.plusSeconds(300)
                val runs =
                    listOf(
                        ProjectedDeletionRun("PENDING", 0, null, null) to RetentionStatus.SCHEDULED,
                        ProjectedDeletionRun("IN_PROGRESS", 2, next, null) to RetentionStatus.IN_PROGRESS,
                        ProjectedDeletionRun("FAILED", 1, next, "persistence.retention.delete") to
                            RetentionStatus.RETRY_PENDING,
                        ProjectedDeletionRun("FAILED", 5, null, "persistence.retention.delete") to
                            RetentionStatus.ABANDONED,
                    )

                runs.forEach { (run, status) ->
                    world.projectedWith(game, policy(run))

                    val view = world.retention(game, game.facilitator).ok()

                    view.status shouldBe status
                    view.attempt shouldBe run.attempt
                    view.lastFailureCode shouldBe run.lastFailureCode
                    // 次の試行の時刻は、再試行待ちのときだけ返す（削除中の値は、貸出の期限）
                    view.nextAttemptAt shouldBe if (status == RetentionStatus.RETRY_PENDING) next else null
                }
            }

            test("[B11/AC5.1.1] Given 保持方針 When 参加者・無資格・別のゲームの進行役が取得する Then すべて同じ Unauthorized") {
                val world = World()
                val game = world.started()
                val other = world.started(tag = "other")
                world.projectedWith(game, policy())

                listOf(
                    world.retention(game, game.seats[Role.RETAILER].credential),
                    world.retention(game, null),
                    world.retention(game, "v1.no-such-credential"),
                    world.retention(game, other.facilitator),
                ).forEach { it.leftOrNull() shouldBe AppFailure.Unauthorized }
            }

            test("[B11] Given 投影が無いゲーム When 取得する Then Unauthorized（存在を明かさない）") {
                val world = World()
                val game = world.started()
                world.projectedGame = null

                world.retention(game, game.facilitator).leftOrNull() shouldBe AppFailure.Unauthorized
            }

            test("[B11] Given 方針の行が無いゲーム When 取得する Then 投影の欠けとして失敗する") {
                val world = World()
                val game = world.started()
                world.projectedWith(game, null)

                val failure = world.retention(game, game.facilitator).leftOrNull()

                (failure as AppFailure.Persistence).failure.operation shouldBe "retention.missing"
            }
        }

        context("削除の掃引") {
            test("[B11/AC5.1.2] Given 期限に達したゲーム When 掃引する Then 削除して、ゲームを特定しない受領記録を残す") {
                val store = MemoryRetentionStore(listOf(DueDeletion(game(1), null, RetentionState.Pending)))

                val report = sweep(sweeper(store))

                report.completed shouldBe listOf(game(1))
                report.failures shouldBe emptyList()
                store.started.single().attempt shouldBe 1
                val receipt = store.receipts.single()
                receipt.gameReferenceDigest.length shouldBe 64
                receipt.gameReferenceDigest shouldNotContain game(1).value.toString()
                receipt.expiresAt shouldBe DELETE_AFTER.plus(Duration.ofDays(365))
            }

            test("[B11/AC5.1.2] Given 2 つのゲーム When 掃引する Then 受領記録のダイジェストはゲームごとに違う（同じゲームなら同じ）") {
                val store =
                    MemoryRetentionStore(
                        listOf(
                            DueDeletion(game(1), null, RetentionState.Pending),
                            DueDeletion(game(2), null, RetentionState.Pending),
                        ),
                    )

                sweep(sweeper(store)).completed shouldBe listOf(game(1), game(2))

                store.receipts
                    .map { it.gameReferenceDigest }
                    .toSet()
                    .size shouldBe 2
            }

            test("[B11/AC5.1.3] Given 削除が失敗する When 掃引する Then 完了とせず、失敗を、次の試行の時刻つきで記録する") {
                val store = MemoryRetentionStore(listOf(DueDeletion(game(1), null, RetentionState.Pending)))
                store.failDeletes = 1

                val report = sweep(sweeper(store, jitter = Duration.ofSeconds(3)))

                report.completed shouldBe emptyList()
                store.deleted shouldBe emptyList()
                val failure = report.failures.single()
                failure.attempt shouldBe 1
                failure.failureCode shouldBe "persistence.retention.delete"
                failure.nextAttemptAt shouldBe DELETE_AFTER.plus(Duration.ofMinutes(5)).plusSeconds(3)
                report.abandoned shouldBe emptyList()
                store.failed.single().nextAttemptAt shouldBe failure.nextAttemptAt
            }

            test("[B11/AC5.1.3] Given 5 回目の試行 When 失敗する Then 再試行をやめ、通知の対象（abandoned）になる") {
                val store =
                    MemoryRetentionStore(
                        listOf(DueDeletion(game(1), UUID(3L, 3L), RetentionState.Failed(4, DELETE_AFTER, "x"))),
                    )
                store.failDeletes = 1

                val report = sweep(sweeper(store))

                store.started.single().attempt shouldBe RetentionSaga.MAX_ATTEMPTS
                report.abandoned.map { it.gameId } shouldBe listOf(game(1))
                report.abandoned.single().nextAttemptAt shouldBe null
            }

            test("[B11/AC5.1.3] Given 再試行をやめた状態・完了済み・次の試行の時刻の前 When 掃引する Then 何も始めない") {
                val store =
                    MemoryRetentionStore(
                        listOf(
                            DueDeletion(game(1), UUID(3L, 1L), RetentionState.Abandoned(5, "x")),
                            DueDeletion(game(2), UUID(3L, 2L), RetentionState.Completed),
                            DueDeletion(
                                game(3),
                                UUID(3L, 3L),
                                RetentionState.Failed(1, DELETE_AFTER.plusSeconds(1), "x"),
                            ),
                        ),
                    )

                val report = sweep(sweeper(store))

                report.completed shouldBe emptyList()
                report.failures shouldBe emptyList()
                store.started shouldBe emptyList()
            }

            test("[B11/NF-R12] Given 停止で取り残された試行 When 貸出の期限を過ぎて掃引する Then 次の試行として再開し、完了する") {
                val store =
                    MemoryRetentionStore(
                        listOf(DueDeletion(game(1), UUID(3L, 3L), RetentionState.InProgress(1, DELETE_AFTER))),
                    )

                val report = sweep(sweeper(store))

                store.started.single().attempt shouldBe 2
                report.completed shouldBe listOf(game(1))
            }

            test("[B11] Given 試行の開始を記録できない When 掃引する Then 削除せず、掃引が失敗する") {
                val store = MemoryRetentionStore(listOf(DueDeletion(game(1), null, RetentionState.Pending)))
                store.failBegin = true

                runBlocking { sweeper(store).sweep() }.leftOrNull() shouldBe persistenceFailure("retention.begin")
                store.deleted shouldBe emptyList()
            }

            test("[B11] Given 期限切れの受領記録 When 掃引する Then 消した件数を報告する") {
                val store = MemoryRetentionStore()
                store.purged = 3

                sweep(sweeper(store)).purgedReceipts shouldBe 3
            }

            test("[B11] Given 失敗の分類 When 値に変える Then 操作名だけで、値を含まない") {
                failureCodeOf(persistenceFailure("retention.delete")) shouldBe "persistence.retention.delete"
                failureCodeOf(AppFailure.Unauthorized) shouldBe "app.unauthorized"
            }
        }
    })
