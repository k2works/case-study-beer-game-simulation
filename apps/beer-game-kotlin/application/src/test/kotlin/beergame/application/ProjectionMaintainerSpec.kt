package beergame.application

import arrow.core.Either
import arrow.core.getOrElse
import arrow.core.left
import arrow.core.right
import beergame.domain.GameId
import beergame.domain.StreamType
import io.kotest.core.spec.style.FunSpec
import io.kotest.matchers.shouldBe
import java.time.Duration
import java.time.Instant
import java.util.UUID

private fun <A> Either<AppFailure, A>.ok(): A = getOrElse { error("Left だった: $it") }

private fun game(n: Int) = GameId(UUID(0L, n.toLong()))

private val A = game(1)
private val B = game(2)
private val C = game(3)
private val DRIFT = Inconsistency.RowDrift("game_overview", 1, 1)

/** 時計は呼ぶたびに 1 秒進む（開始と終了の差が所要になる）。 */
private fun steppingClock(): Now {
    var at = Instant.parse("2026-11-17T00:00:00Z")
    return {
        at.also { at = at.plusSeconds(1) }
    }
}

private fun port(
    games: Either<AppFailure, List<GameId>> = listOf(A, B, C).right(),
    rebuild: (GameId) -> Either<AppFailure, RebuildOutcome> = { RebuildOutcome(it, 4, 9, 0).right() },
    verify: (GameId) -> Either<AppFailure, List<Inconsistency>> = { emptyList<Inconsistency>().right() },
) = ProjectionMaintenance({ games }, { rebuild(it) }, { verify(it) })

/** 投影の保守のサービス（B12）。1 ゲームの失敗が、他のゲームに波及しないこと。 */
class ProjectionMaintainerSpec :
    FunSpec({
        test("[B12/NF-R15] Given 対象を指定しない When 再構築する Then 全ゲームを順に再構築し、変わったゲームを数える") {
            val maintainer =
                ProjectionMaintainer(
                    port(rebuild = { RebuildOutcome(it, 4, 9, if (it == B) 2 else 0).right() }),
                    steppingClock(),
                )

            val report = maintainer.rebuild(emptyList()).ok()

            report.rebuilt.map { it.gameId } shouldBe listOf(A, B, C)
            report.changedGames.map { it.gameId } shouldBe listOf(B)
            report.failed shouldBe emptyList()
            report.elapsed shouldBe Duration.ofSeconds(1)
        }

        test("[B12] Given 1 ゲームの再構築が失敗する When 再構築する Then 他のゲームは再構築され、失敗は報告に残る") {
            val maintainer =
                ProjectionMaintainer(
                    port(rebuild = {
                        if (it ==
                            B
                        ) {
                            AppFailure.RetryExhausted.left()
                        } else {
                            RebuildOutcome(it, 1, 1, 0).right()
                        }
                    }),
                    steppingClock(),
                )

            val report = maintainer.rebuild(listOf(A, B, C)).ok()

            report.rebuilt.map { it.gameId } shouldBe listOf(A, C)
            report.failed shouldBe listOf(GameFailure(B, AppFailure.RetryExhausted))
        }

        test("[B12] Given 対象を指定した When 再構築する Then 一覧を読まず、指定したゲームだけを再構築する") {
            val maintainer = ProjectionMaintainer(port(games = AppFailure.ConcurrencyConflict.left()), steppingClock())

            maintainer
                .rebuild(listOf(B))
                .ok()
                .rebuilt
                .map { it.gameId } shouldBe listOf(B)
        }

        test("[B12] Given 一覧を読めない When 再構築・検査する Then Left（何も実行しない）") {
            val maintainer = ProjectionMaintainer(port(games = AppFailure.ConcurrencyConflict.left()), steppingClock())

            maintainer.rebuild(emptyList()) shouldBe Either.Left(AppFailure.ConcurrencyConflict)
            maintainer.verify() shouldBe Either.Left(AppFailure.ConcurrencyConflict)
        }

        test("[B12/NF-R15] Given 不一致・ロック待ち・失敗が混ざる When 検査する Then 不一致、検査できず、失敗を分けて数える") {
            val maintainer =
                ProjectionMaintainer(
                    port(
                        verify = {
                            when (it) {
                                A -> listOf(DRIFT, Inconsistency.CheckpointDrift(StreamType.GAME, null, 2)).right()
                                B -> AppFailure.RetryExhausted.left()
                                else -> AppFailure.ConcurrencyConflict.left()
                            }
                        },
                    ),
                    steppingClock(),
                )

            val report = maintainer.verify().ok()

            report.checked shouldBe 1
            report.inconsistent.map { it.gameId } shouldBe listOf(A)
            report.inconsistent
                .single()
                .findings.size shouldBe 2
            report.skipped shouldBe listOf(B)
            report.failed shouldBe listOf(GameFailure(C, AppFailure.ConcurrencyConflict))
        }

        test("[B12/NF-R15] Given すべて一致 When 検査する Then 不一致 0 件で、全ゲームを検査したと数える") {
            val report = ProjectionMaintainer(port(), steppingClock()).verify(listOf(A, B)).ok()

            report.checked shouldBe 2
            report.inconsistent shouldBe emptyList()
            report.skipped shouldBe emptyList()
        }
    })
