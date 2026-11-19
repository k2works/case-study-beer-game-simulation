package beergame.domain

import arrow.core.left
import arrow.core.right
import io.kotest.core.spec.style.FunSpec
import io.kotest.matchers.shouldBe
import io.kotest.property.Arb
import io.kotest.property.arbitrary.int
import io.kotest.property.checkAll
import java.time.Duration
import java.time.Instant

private val NOW: Instant = Instant.parse("2027-01-01T00:00:00Z")
private val NO_JITTER: Duration = Duration.ZERO
private val LEASE_END: Instant = NOW.plus(RetentionSaga.LEASE)

private fun days(n: Int): RetentionDays = RetentionDays.of(n).getOrNull() ?: error("日数が不正: $n")

private fun start(
    state: RetentionState,
    now: Instant = NOW,
) = RetentionSaga.decide(state, RetentionCommand.StartDeletion(now))

private fun failure(
    state: RetentionState,
    jitter: Duration = NO_JITTER,
) = RetentionSaga.decide(state, RetentionCommand.RecordFailure("persistence.timeout", NOW, jitter))

/** 試行 [attempt] 回目が始まった状態へ、決定と発展で進める。 */
private fun inProgress(attempt: Int): RetentionState =
    (1..attempt).fold(RetentionState.Pending as RetentionState) { state, n ->
        val at = NOW.plus(Duration.ofDays(n.toLong()))
        val started = start(state, at).getOrNull() ?: error("開始できない: $state")
        val next = RetentionSaga.evolve(started)
        if (n == attempt) {
            next
        } else {
            val failed = failure(next).getOrNull() ?: error("失敗を記録できない")
            RetentionSaga.evolve(failed)
        }
    }

class RetentionSagaSpec :
    FunSpec({
        context("保持方針（RetentionPolicy）") {
            test("[AC5.1.1] Given 保持日数と起点 When 方針を作る Then 削除期限は、起点の日数後になる") {
                val policy = RetentionPolicy.starting(days(30), NOW)

                policy.startsAt shouldBe NOW
                policy.deleteAfter shouldBe Instant.parse("2027-01-31T00:00:00Z")
            }

            test("[AC5.1.2] Given 方針 When 期限の前後で判定する Then 期限ちょうどから期限に達している") {
                val policy = RetentionPolicy.starting(days(1), NOW)

                policy.isDue(policy.deleteAfter.minusSeconds(1)) shouldBe false
                policy.isDue(policy.deleteAfter) shouldBe true
                policy.isDue(policy.deleteAfter.plusSeconds(1)) shouldBe true
            }

            test("[AC5.1.1] Given 保持日数 1〜3650 の任意の値 When 方針を作る Then 期限は起点より後になる") {
                checkAll(Arb.int(RetentionDays.MIN..RetentionDays.MAX)) { n ->
                    val policy = RetentionPolicy.starting(days(n), NOW)

                    policy.deleteAfter.isAfter(policy.startsAt) shouldBe true
                }
            }
        }

        context("開始（StartDeletion）") {
            test("[AC5.1.2] Given 未着手 When 開始する Then 1 回目の試行が始まり、貸出の期限が付く") {
                start(RetentionState.Pending) shouldBe RetentionEvent.DeletionStarted(1, NOW, LEASE_END).right()
            }

            test("[AC5.1.3] Given 完了済み When 開始する Then 一度だけなので、拒否する") {
                start(RetentionState.Completed) shouldBe RetentionRejection.AlreadyCompleted.left()
            }

            test("[AC5.1.3] Given 再試行をやめた状態 When 開始する Then 拒否する") {
                start(RetentionState.Abandoned(5, "x")) shouldBe RetentionRejection.RetriesExhausted.left()
            }

            test("[AC5.1.3] Given 失敗の後 When 次の試行の時刻の前に開始する Then まだ早いと拒否し、時刻になれば次の試行を始める") {
                val failed = RetentionState.Failed(2, NOW, "x")

                start(failed, NOW.minusSeconds(1)) shouldBe RetentionRejection.NotYetDue(NOW).left()
                start(failed, NOW) shouldBe RetentionEvent.DeletionStarted(3, NOW, LEASE_END).right()
            }

            test("[NF-R12] Given 試行中 When 貸出の期限の前に開始する Then 別の掃引が動いているので拒否する") {
                val running = RetentionState.InProgress(1, NOW)

                start(running, NOW.minusSeconds(1)) shouldBe RetentionRejection.NotYetDue(NOW).left()
            }

            test("[NF-R12] Given 停止で取り残された試行 When 貸出の期限を過ぎて開始する Then 次の試行として再開する") {
                start(RetentionState.InProgress(2, NOW), NOW) shouldBe
                    RetentionEvent.DeletionStarted(3, NOW, LEASE_END).right()
            }

            test("[AC5.1.3] Given 5 回目の試行で停止した状態 When 貸出の期限を過ぎて開始する Then 6 回目は行わない") {
                start(RetentionState.InProgress(RetentionSaga.MAX_ATTEMPTS, NOW), NOW) shouldBe
                    RetentionRejection.RetriesExhausted.left()
            }
        }

        context("失敗の記録（RecordFailure）") {
            test("[AC5.1.3] Given 1 回目の試行 When 失敗を記録する Then 5 分後に再試行する") {
                failure(RetentionState.InProgress(1, LEASE_END)) shouldBe
                    RetentionEvent.DeletionFailed(1, "persistence.timeout", NOW.plus(Duration.ofMinutes(5))).right()
            }

            test("[AC5.1.3] Given 1〜4 回目の試行 When 失敗を記録する Then 待ち時間は 2 倍ずつ増え、揺らぎが足される") {
                val waits =
                    (1 until RetentionSaga.MAX_ATTEMPTS).map { attempt ->
                        val event = failure(inProgress(attempt), Duration.ofSeconds(7)).getOrNull()
                        (event as RetentionEvent.DeletionFailed).nextAttemptAt
                    }

                waits.map { checkNotNull(it) } shouldBe
                    listOf(5L, 10L, 20L, 40L).map { NOW.plus(Duration.ofMinutes(it)).plusSeconds(7) }
            }

            test("[AC5.1.3] Given 5 回目の試行 When 失敗を記録する Then 次の試行は無く、再試行をやめる") {
                failure(RetentionState.InProgress(RetentionSaga.MAX_ATTEMPTS, LEASE_END)) shouldBe
                    RetentionEvent.DeletionFailed(RetentionSaga.MAX_ATTEMPTS, "persistence.timeout", null).right()
            }

            test("[AC5.1.3] Given 試行中でない When 失敗を記録する Then 拒否する") {
                listOf(RetentionState.Pending, RetentionState.Completed, RetentionState.Failed(1, NOW, "x"))
                    .forEach { failure(it) shouldBe RetentionRejection.NotInProgress.left() }
            }
        }

        context("完了の記録（RecordCompletion）") {
            test("[AC5.1.2] Given 試行中 When 完了を記録する Then 削除は完了する") {
                RetentionSaga.decide(
                    RetentionState.InProgress(1, LEASE_END),
                    RetentionCommand.RecordCompletion,
                ) shouldBe
                    RetentionEvent.DeletionCompleted.right()
            }

            test("[AC5.1.3] Given 試行中でない When 完了を記録する Then 半分の状態を完了としないよう、拒否する") {
                listOf(RetentionState.Pending, RetentionState.Completed, RetentionState.Abandoned(5, "x"))
                    .forEach {
                        RetentionSaga.decide(it, RetentionCommand.RecordCompletion) shouldBe
                            RetentionRejection.NotInProgress.left()
                    }
            }
        }

        context("状態の発展（evolve）") {
            test("開始は試行中に、次の試行の時刻のある失敗は再試行待ちに、無い失敗は放棄に、完了は完了になる") {
                RetentionSaga.evolve(RetentionEvent.DeletionStarted(1, NOW, LEASE_END)) shouldBe
                    RetentionState.InProgress(1, LEASE_END)
                RetentionSaga.evolve(RetentionEvent.DeletionFailed(1, "x", NOW)) shouldBe
                    RetentionState.Failed(1, NOW, "x")
                RetentionSaga.evolve(RetentionEvent.DeletionFailed(5, "x", null)) shouldBe
                    RetentionState.Abandoned(5, "x")
                RetentionSaga.evolve(RetentionEvent.DeletionCompleted) shouldBe RetentionState.Completed
            }

            test("[AC5.1.3] Given 5 回続けて失敗する When 順に決定して発展させる Then 5 回目の失敗で放棄に至る") {
                val final =
                    (1..RetentionSaga.MAX_ATTEMPTS).fold(RetentionState.Pending as RetentionState) { state, n ->
                        val at = NOW.plus(Duration.ofDays(n.toLong()))
                        val running = RetentionSaga.evolve(start(state, at).getOrNull() ?: error("開始できない"))
                        val failed = RetentionCommand.RecordFailure("x", at, NO_JITTER)
                        RetentionSaga.evolve(RetentionSaga.decide(running, failed).getOrNull() ?: error("記録できない"))
                    }

                final shouldBe RetentionState.Abandoned(RetentionSaga.MAX_ATTEMPTS, "x")
            }
        }
    })
