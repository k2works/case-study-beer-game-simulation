package beergame.domain

import io.kotest.core.spec.style.FunSpec
import io.kotest.matchers.shouldBe
import io.kotest.property.Arb
import io.kotest.property.arbitrary.list
import io.kotest.property.checkAll

private const val ITERATIONS = 100
private const val WEEKS = 3

/** 作成から最終週の確定まで、decide と evolve だけで通した記録。 */
private data class Run(
    val gameEvents: List<GameEvent>,
    val sessionEvents: List<SessionEvent>,
    val session: SessionState,
)

private fun runGame(weekly: List<RoleMap<Quantity>>): Run {
    val settings = gameSettings(List(weekly.size) { 4 })
    val prepared = fullyAssignedEvents(settings)
    val game = gameOf(*prepared.toTypedArray())
    val start = startGame(game, SessionState.NotStarted, StartGame(facilitatorActor, t0)).valid("開始")
    val started = start.session.fold<SessionEvent, SessionState>(SessionState.NotStarted, ::evolveSession)
    val (session, events) =
        weekly.foldIndexed(started to start.session) { index, (state, history), decisions ->
            val week = index + 1
            val (saved, afterSave) =
                Role.entries.fold(state to emptyList<SessionEvent>()) { (s, acc), role ->
                    val e = decideSession(s, saveDecision(role, decisions[role].value, week)).valid("保存")
                    e.fold(s, ::evolveSession) to (acc + e)
                }
            val committed = decideSession(saved, commitWeek(week)).valid("確定")
            committed.fold(saved, ::evolveSession) to (history + afterSave + committed)
        }
    return Run(prepared + start.game, events, session)
}

class GameFlowSpec :
    FunSpec({
        test("[US2.3/AC2.3.1] 作成から最終週の確定まで通すと、セッションは終了し、全役割の費用が確定する（定常: 3 週で 1800）") {
            val run = runGame(List(WEEKS) { same(4) })
            val data = sessionDataOf(run.session)
            (run.session is SessionState.Ended) shouldBe true
            data.week shouldBe w(WEEKS)
            Role.entries.forEach { data.roleStates[it].cumulativeCost shouldBe m(1800) }
        }

        test("[US2.3/AC2.3.4] 計算と事実の一致: 再生した状態は、simulateWeek を直接回した結果と一致する") {
            checkAll(ITERATIONS, Arb.list(roleDecisions, WEEKS..WEEKS)) { weekly ->
                val run = runGame(weekly)
                val direct = play(gameSettings(List(WEEKS) { 4 }).simulation(), weekly)
                sessionDataOf(run.session).roleStates shouldBe direct.outcomes.last().nextStates
            }
        }

        test("[US2.3/AC2.3.4] 決定論: 同じ入力は、同じイベント列と同じ状態を返す") {
            checkAll(ITERATIONS, Arb.list(roleDecisions, WEEKS..WEEKS)) { weekly ->
                runGame(weekly) shouldBe runGame(weekly)
            }
        }

        test("[設計 M13] decide が作る列だけが evolve に来る: 再生で InvalidTransition は 1 件も出ない") {
            checkAll(ITERATIONS, Arb.list(roleDecisions, WEEKS..WEEKS)) { weekly ->
                val run = runGame(weekly)
                replayGame(run.gameEvents).invalid shouldBe emptyList()
                replaySession(run.sessionEvents).invalid shouldBe emptyList()
                replaySession(run.sessionEvents).state shouldBe run.session
            }
        }

        test("[US2.3/AC2.3.5] 確定のたびに WeekCommitted は 1 件、最終週だけ SessionEnded が続く") {
            val run = runGame(List(WEEKS) { same(4) })
            run.sessionEvents.filterIsInstance<SessionEvent.WeekCommitted>().map { it.week.value } shouldBe
                listOf(1, 2, 3)
            run.sessionEvents.filterIsInstance<SessionEvent.SessionEnded>().size shouldBe 1
            run.sessionEvents.last() shouldBe SessionEvent.SessionEnded(EndReason.FINAL_WEEK)
        }
    })
