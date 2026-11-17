package beergame.application

import beergame.domain.DisclosurePolicy
import beergame.domain.GameId
import beergame.domain.StreamVersion
import io.kotest.core.spec.style.FunSpec
import io.kotest.matchers.collections.shouldContainExactly
import io.kotest.matchers.shouldBe
import java.util.UUID

/*
 * 観察の開示の規則（B9。AC4.1.1・AC4.1.3）。純粋関数として確かめる。
 * 確定の寄与者が常に 4 役割のため、寄与者が 2 未満の週（AC4.1.3 の前半）は、受入では作れない。ここで、投影の行を直接与えて確かめる。
 */

private val GAME = GameId(UUID(5L, 5L))
private val VERSIONS = Versions(StreamVersion.of(7L).ok(), StreamVersion.of(9L).ok())

private fun total(
    week: Int,
    contributors: Int = 4,
) = ProjectedTeamTotal(week, ordered = 16 + week, inventory = 40 + week, backlog = week, contributors = contributors)

private fun rows(vararg totals: ProjectedTeamTotal) =
    ProjectedObservation(
        status = GameStatus.STARTED,
        finalWeek = 5,
        session = ProjectedSession(SessionStatus.ACTIVE, 3, 2),
        teamTotals = totals.toList(),
    )

private fun observe(
    policy: DisclosurePolicy,
    observation: ProjectedObservation,
): Observation = Disclosure.forObservation(GAME, policy, observation, VERSIONS)

class ObservationSpec :
    FunSpec({
        test("[B9/AC4.1.1] Given 公開範囲がチーム合計 When 観察を作る Then 現在週・入力済みの役割数・確定した週の合計が、週の順で返る") {
            val observation = observe(DisclosurePolicy.TEAM_TOTAL, rows(total(2), total(1)))

            observation.session shouldBe SessionSummary(SessionStatus.ACTIVE, 3, 2)
            observation.status shouldBe GameStatus.STARTED
            observation.finalWeek shouldBe 5
            observation.versions shouldBe VERSIONS
            observation.totals.hiddenReason shouldBe null
            observation.totals.weeks shouldContainExactly
                listOf(ObservationWeek.Visible(1, 17, 41, 1), ObservationWeek.Visible(2, 18, 42, 2))
        }

        test("[B9/AC4.1.3] Given 公開範囲が「なし」 When 観察を作る Then 合計は返さず、理由 DISCLOSURE_NONE を示す（現在週と完了状況は返す）") {
            val observation = observe(DisclosurePolicy.NONE, rows(total(1), total(2)))

            observation.totals shouldBe
                ObservationTotals(DisclosurePolicy.NONE, HiddenReason.DISCLOSURE_NONE, emptyList())
            observation.session shouldBe SessionSummary(SessionStatus.ACTIVE, 3, 2)
        }

        test("[B9/AC4.1.3] Given 寄与者が 2 未満の週 When 観察を作る Then その週は値を出さず、理由を示す。2 以上の週は出す（境界）") {
            val observation = observe(DisclosurePolicy.TEAM_TOTAL, rows(total(1, 1), total(2, 2), total(3, 0)))

            observation.totals.weeks shouldContainExactly
                listOf(
                    ObservationWeek.Hidden(1, HiddenReason.CONTRIBUTORS_BELOW_MINIMUM),
                    ObservationWeek.Visible(2, 18, 42, 2),
                    ObservationWeek.Hidden(3, HiddenReason.CONTRIBUTORS_BELOW_MINIMUM),
                )
        }

        test("[B9] Given セッションがまだ無い（準備中） When 観察を作る Then セッションの項目は無く、合計は空") {
            val observation =
                observe(DisclosurePolicy.TEAM_TOTAL, ProjectedObservation(GameStatus.PREPARING, 5, null, emptyList()))

            observation.session shouldBe null
            observation.totals.weeks shouldBe emptyList()
        }

        test("[B9] 主の読み取りから、観察者が読める項目だけを取り出す") {
            val game =
                ProjectedGame(
                    gameId = GAME,
                    status = GameStatus.STARTED,
                    finalWeek = 5,
                    joinCode = "JOINCODE0001",
                    participants = emptyList(),
                    session = ProjectedSession(SessionStatus.ACTIVE, 1, 0),
                    roleStates = emptyMap(),
                    decisions = emptyMap(),
                    results = emptyList(),
                    versions = VERSIONS,
                    teamTotals = listOf(total(1)),
                )

            game.toObservation() shouldBe
                ProjectedObservation(
                    GameStatus.STARTED,
                    5,
                    ProjectedSession(SessionStatus.ACTIVE, 1, 0),
                    listOf(total(1)),
                )
        }
    })
