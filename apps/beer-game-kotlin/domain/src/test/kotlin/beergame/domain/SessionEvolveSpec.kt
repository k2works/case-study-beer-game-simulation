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
    ) + allSavedEvents(fours).take(1) +
        listOf(
            SessionEvent.SessionPaused,
            SessionEvent.SessionResumed,
            proxyDecisionSubmitted(Role.FACTORY, 6),
            committedWithDifferentNextStates(),
            roleHolderReplaced(Role.RETAILER, removed = setOf(4), added = 5),
        )

private fun activeAtStart(): SessionState = sessionOf(sessionStarted(settings))

private fun pausedAtStart(): SessionState = sessionOf(sessionStarted(settings), SessionEvent.SessionPaused)

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

        context("[US3.1] 停止・再開・代理入力の畳み込み") {
            test("SessionPaused は、進行中を一時停止（データはそのまま、版は 1 進む）にする") {
                val active = sessionOf(sessionStarted(settings), decisionSaved(Role.RETAILER, 4))
                evolveSession(active, SessionEvent.SessionPaused) shouldBe
                    SessionState.Paused(sessionDataOf(active), sv(3))
            }
            test("SessionResumed は、一時停止中を進行中（データはそのまま、版は 1 進む）にする") {
                val pausedWithInput =
                    sessionOf(sessionStarted(settings), decisionSaved(Role.RETAILER, 4), SessionEvent.SessionPaused)
                evolveSession(pausedWithInput, SessionEvent.SessionResumed) shouldBe
                    SessionState.Active(sessionDataOf(pausedWithInput), sv(4))
            }
            test("停止して再開しても、週・入力・版は変わらない") {
                val active = sessionOf(sessionStarted(settings), decisionSaved(Role.RETAILER, 4))
                val resumed =
                    evolveSession(evolveSession(active, SessionEvent.SessionPaused), SessionEvent.SessionResumed)
                sessionDataOf(resumed) shouldBe sessionDataOf(active)
            }
            test("ProxyDecisionSubmitted は、進行中でも一時停止中でも、進行役の入力として保存し、状態の種類を変えない") {
                val event = proxyDecisionSubmitted(Role.FACTORY, 6, version = 1, submittedRoleCount = 1)
                val entry = DecisionEntry(q(6), dv(1), facilitatorEditor)
                val fromActive = evolveSession(activeAtStart(), event)
                val fromPaused = evolveSession(pausedAtStart(), event)
                (fromActive is SessionState.Active) shouldBe true
                (fromPaused is SessionState.Paused) shouldBe true
                listOf(fromActive, fromPaused).forEach { state ->
                    sessionDataOf(state).decisions shouldBe mapOf(Role.FACTORY to entry)
                    sessionDataOf(state).decisionVersions shouldBe RoleMap(dv(1), dv(0), dv(0), dv(0))
                }
                fromActive.version shouldBe sv(2)
                fromPaused.version shouldBe sv(3)
            }
            test("一時停止中でも、SessionEnded は終了にする（一時停止から終了への遷移）") {
                evolveSession(pausedAtStart(), SessionEvent.SessionEnded(EndReason.FINAL_WEEK)) shouldBe
                    SessionState.Ended(sessionDataOf(pausedAtStart()), sv(3))
            }
            test("SessionPaused は進行中だけ、SessionResumed は一時停止中だけに効く（それ以外は状態を変えない）") {
                val (ended, _) = sessionPlayed(3, settings = settings)
                listOf(SessionState.NotStarted, pausedAtStart(), ended).forEach { state ->
                    evolveSession(state, SessionEvent.SessionPaused) shouldBe state
                }
                listOf(SessionState.NotStarted, activeAtStart(), ended).forEach { state ->
                    evolveSession(state, SessionEvent.SessionResumed) shouldBe state
                }
            }
            test("未開始・終了後への ProxyDecisionSubmitted、一時停止中への SessionStarted は、状態を変えない") {
                val (ended, _) = sessionPlayed(3, settings = settings)
                val proxy = proxyDecisionSubmitted(Role.FACTORY, 6)
                listOf(SessionState.NotStarted, ended).forEach { state -> evolveSession(state, proxy) shouldBe state }
                evolveSession(pausedAtStart(), sessionStarted(settings)) shouldBe pausedAtStart()
            }
        }

        context("[B5/H4] RoleHolderReplaced（役割の入れ替えでの、役割の写しの更新）") {
            val replaced = roleHolderReplaced(Role.RETAILER, removed = setOf(4), added = 5)

            test("進行中・一時停止中のどちらも、その役割の担当者を入れ替え、ほかの役割・入力・版は変えない（版は 1 進む）") {
                listOf(
                    activeAtStart() to SessionState.Active::class,
                    pausedAtStart() to SessionState.Paused::class,
                ).forEach { (state, kind) ->
                    val next = evolveSession(state, replaced)
                    next::class shouldBe kind
                    val before = sessionDataOf(state)
                    val after = sessionDataOf(next)
                    after.assignments shouldBe before.assignments.copy(retailer = setOf(pid(5)))
                    after.copy(assignments = before.assignments) shouldBe before
                    next.version shouldBe state.version.next()
                }
            }
            test("共同担当は、外す集合の全員が外れ、ほかの担当者は残る") {
                val shared = assignedParticipants.copy(retailer = setOf(pid(4), pid(6), pid(7)))
                val state = sessionOf(sessionStarted(settings).copy(assignments = shared))
                val next = evolveSession(state, roleHolderReplaced(Role.RETAILER, removed = setOf(4, 6), added = 5))
                sessionDataOf(next).assignments.retailer shouldBe setOf(pid(7), pid(5))
            }
            test("当週に保存済みの入力と版は、入れ替えの後も残る（新担当者が引き継ぐ）") {
                val state = sessionOf(sessionStarted(settings), decisionSaved(Role.RETAILER, 4))
                val after = sessionDataOf(evolveSession(state, replaced))
                after.decisions shouldBe sessionDataOf(state).decisions
                after.decisionVersions shouldBe sessionDataOf(state).decisionVersions
            }
            test("未開始・終了後には効かない（状態を変えない）") {
                val (ended, _) = sessionPlayed(3, settings = settings)
                listOf(SessionState.NotStarted, ended).forEach { state ->
                    evolveSession(state, replaced) shouldBe state
                }
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
                listOf(SessionState.NotStarted, activeAtStart(), pausedAtStart(), ended).forEach { state ->
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
            test("停止・再開・代理入力を含む正しい列は、検知 0 件。停止していない再開などは検知する") {
                val valid =
                    replaySession(
                        listOf(
                            sessionStarted(settings),
                            SessionEvent.SessionPaused,
                            proxyDecisionSubmitted(Role.FACTORY, 6),
                            SessionEvent.SessionResumed,
                        ),
                    )
                valid.invalid shouldBe emptyList()
                valid.state shouldBe
                    sessionOf(
                        sessionStarted(settings),
                        SessionEvent.SessionPaused,
                        proxyDecisionSubmitted(Role.FACTORY, 6),
                        SessionEvent.SessionResumed,
                    )
                replaySession(listOf(sessionStarted(settings), SessionEvent.SessionResumed)).invalid shouldBe
                    listOf(InvalidTransition(StreamType.SESSION, "Active", "SessionResumed"))
                replaySession(listOf(proxyDecisionSubmitted(Role.FACTORY, 6))).invalid shouldBe
                    listOf(InvalidTransition(StreamType.SESSION, "NotStarted", "ProxyDecisionSubmitted"))
            }
        }
    })
