package beergame.application

import beergame.domain.GameError
import beergame.domain.GameId
import beergame.domain.Role
import beergame.domain.StreamVersion
import io.kotest.core.spec.style.FunSpec
import io.kotest.matchers.collections.shouldContainExactly
import io.kotest.matchers.shouldBe
import java.util.UUID

private const val FINAL_WEEK = 3

private fun result(
    week: Int,
    role: Role,
) = ProjectedWeekResult(week, role, 4, 4, 4, 10 + week, 0, 100L, 100L * week)

private fun projected(status: GameStatus) =
    ProjectedGame(
        gameId = GameId(UUID.randomUUID()),
        status = status,
        finalWeek = FINAL_WEEK,
        joinCode = "JOINCODE0001",
        participants = emptyList(),
        session = null,
        roleStates = emptyMap(),
        decisions = emptyMap(),
        // 週と役割の順をわざと崩して渡す
        results = (FINAL_WEEK downTo 1).flatMap { week -> Role.entries.reversed().map { result(week, it) } },
        versions = Versions(StreamVersion.of(9L).ok(), null),
    )

/** 振り返りの開示の規則（B4。AC4.2.1・AC4.2.2）。純粋関数として確かめる。 */
class ReviewSpec :
    FunSpec({
        test("[B4/AC4.2.1] Given 終了したゲーム When 振り返りを作る Then 全役割の全週の結果が、週・役割の順で返る") {
            val review = Disclosure.forReview(projected(GameStatus.ENDED)).ok()

            review.results.map { it.week to it.role } shouldContainExactly
                (1..FINAL_WEEK).flatMap { week -> Role.entries.map { week to it } }
            review.finalWeek shouldBe FINAL_WEEK
        }

        test("[B4/AC4.2.2] Given 準備中・進行中のゲーム When 振り返りを作る Then 値を持たず game.not_ended") {
            listOf(GameStatus.PREPARING, GameStatus.STARTED).forEach { status ->
                Disclosure.forReview(projected(status)) shouldBe arrow.core.Either.Left(GameError.NotEnded)
            }
        }
    })
