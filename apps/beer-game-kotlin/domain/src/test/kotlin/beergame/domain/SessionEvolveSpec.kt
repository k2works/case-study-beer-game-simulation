package beergame.domain

import io.kotest.core.spec.style.FunSpec
import io.kotest.matchers.shouldBe
import io.kotest.matchers.shouldNotBe

private val settings = gameSettings(listOf(4, 8, 4))
private val fours = same(4)

private val allSessionEvents: List<SessionEvent> =
    listOf(
        sessionStarted(settings),
        decisionSaved(Role.FACTORY, 4),
        SessionEvent.SessionEnded(EndReason.FINAL_WEEK),
    ) + allSavedEvents(fours).take(1)

private fun activeAtStart(): SessionState = sessionOf(sessionStarted(settings))

/** 週次計算の結果とは違う `nextStates`（小売店の在庫を 999 にした）を持つ、第 1 週の確定。 */
private fun committedWithDifferentNextStates(): SessionEvent.WeekCommitted {
    val before = sessionOf(sessionStarted(settings), *allSavedEvents(fours).toTypedArray())
    val honest = committedOf(committedWeekEvents(before, fours))
    val tampered = honest.nextStates.copy(retailer = honest.nextStates.retailer.copy(inventory = u(999)))
    return honest.copy(nextStates = tampered)
}

class SessionEvolveSpec :
    FunSpec({
        context("evolveSession は、イベントを状態へ畳み込む") {
            test("SessionStarted は進行中（版 1、第 1 週）にし、設定・割り当て・初期状態・確定方式の写しを持つ") {
                activeAtStart() shouldBe
                    SessionState.Active(
                        SessionData(
                            gameId = gid,
                            settings = settings,
                            assignments = assignedParticipants,
                            week = w(1),
                            roleStates = KitPreset.initialStates(settings.demand),
                            decisions = emptyMap(),
                            decisionVersions = RoleMap.all(DecisionVersion.ZERO),
                            commitMode = CommitMode.MANUAL,
                        ),
                        sv(1),
                    )
            }
            test("DecisionSaved は、その役割の入力と版を保存する（他の役割は変えない）") {
                val state = evolveSession(activeAtStart(), decisionSaved(Role.RETAILER, 9, version = 1))
                val data = sessionDataOf(state)
                data.decisions shouldBe
                    mapOf(Role.RETAILER to DecisionEntry(q(9), dv(1), Editor.ByParticipant(pid(4))))
                data.decisionVersions shouldBe RoleMap(dv(0), dv(0), dv(0), dv(1))
                state.version shouldBe sv(2)
            }
            test("WeekCommitted（最終週でない）は、週を 1 つ進め、入力と版をクリアし、状態を nextStates にする") {
                val before = sessionOf(sessionStarted(settings), *allSavedEvents(fours).toTypedArray())
                val committed = committedOf(committedWeekEvents(before, fours))
                val data = sessionDataOf(evolveSession(before, committed))
                data.week shouldBe w(2)
                data.decisions shouldBe emptyMap()
                data.decisionVersions shouldBe RoleMap.all(DecisionVersion.ZERO)
                data.roleStates shouldBe committed.nextStates
            }
            test("WeekCommitted（最終週）は、週を進めない（直後の SessionEnded で終了する）") {
                val (week3, _) = sessionPlayed(2, settings = settings)
                val saved = allSavedEvents(fours, 3).fold(week3) { s, e -> evolveSession(s, e) }
                val committed = committedOf(committedWeekEvents(saved, fours))
                sessionDataOf(evolveSession(saved, committed)).week shouldBe w(3)
            }
            test("SessionEnded は、データを変えずに終了にする") {
                val active = activeAtStart()
                evolveSession(active, SessionEvent.SessionEnded(EndReason.FINAL_WEEK)) shouldBe
                    SessionState.Ended(sessionDataOf(active), sv(2))
            }
        }

        context("[設計 D5] WeekCommitted の nextStates は事実。evolve は採用するだけで、simulateWeek を呼び直さない") {
            test("simulateWeek の結果と違う nextStates を持つイベントを Given にすると、状態はイベントの値になる") {
                val before = sessionOf(sessionStarted(settings), *allSavedEvents(fours).toTypedArray())
                val tampered = committedWithDifferentNextStates()
                val recomputed =
                    simulateWeek(settings.simulation(), w(1), sessionDataOf(before).roleStates, fours).nextStates

                val data = sessionDataOf(evolveSession(before, tampered))
                data.roleStates shouldBe tampered.nextStates
                data.roleStates.retailer.inventory shouldBe u(999)
                data.roleStates shouldNotBe recomputed
            }
            test("決められた nextStates を採用するので、状態は計算規則でなくイベントだけで決まる（再生の一致）") {
                val (state, history) = sessionPlayed(2, settings = settings)
                history.fold<SessionEvent, SessionState>(SessionState.NotStarted, ::evolveSession) shouldBe state
            }
        }

        context("evolveSession は全域: decide が作らない列は、状態を変えずに返す（InvalidTransition）") {
            test("未開始への DecisionSaved・WeekCommitted・SessionEnded は、状態を変えない") {
                val committed = committedWithDifferentNextStates()
                listOf(decisionSaved(Role.FACTORY, 4), committed, SessionEvent.SessionEnded(EndReason.FINAL_WEEK))
                    .forEach { event -> evolveSession(SessionState.NotStarted, event) shouldBe SessionState.NotStarted }
            }
            test("進行中への SessionStarted は、状態を変えない") {
                val active = activeAtStart()
                evolveSession(active, sessionStarted(gameSettings())) shouldBe active
            }
            test("終了後への SessionStarted・DecisionSaved・WeekCommitted・SessionEnded は、状態を変えない") {
                val (ended, _) = sessionPlayed(3, settings = settings)
                listOf(
                    sessionStarted(settings),
                    decisionSaved(Role.FACTORY, 4, week = 3),
                    committedWithDifferentNextStates(),
                    SessionEvent.SessionEnded(EndReason.FINAL_WEEK),
                ).forEach { event -> evolveSession(ended, event) shouldBe ended }
            }
            test("すべての状態 × すべてのイベントで、例外を投げず、版は変わらないか 1 だけ進む") {
                val (ended, _) = sessionPlayed(3, settings = settings)
                listOf(SessionState.NotStarted, activeAtStart(), ended).forEach { state ->
                    allSessionEvents.forEach { event ->
                        val next = evolveSession(state, event)
                        (next.version == state.version || next.version == state.version.next()) shouldBe true
                    }
                }
            }
        }

        context("replaySession は、不正な遷移を InvalidTransition として検知する") {
            test("正しい列は、状態を再生し、検知は 0 件") {
                val (state, history) = sessionPlayed(3, settings = settings)
                val replayed = replaySession(history)
                replayed.state shouldBe state
                replayed.invalid shouldBe emptyList()
            }
            test("不正な列は、状態を変えず、状態名とイベント名を持つ InvalidTransition を記録する") {
                val replayed =
                    replaySession(
                        listOf(decisionSaved(Role.FACTORY, 4), sessionStarted(settings), sessionStarted(settings)),
                    )
                replayed.state shouldBe activeAtStart()
                replayed.invalid shouldBe
                    listOf(
                        InvalidTransition(StreamType.SESSION, "NotStarted", "DecisionSaved"),
                        InvalidTransition(StreamType.SESSION, "Active", "SessionStarted"),
                    )
            }
        }
    })
