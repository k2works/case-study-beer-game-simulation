package beergame.domain

import arrow.core.left
import arrow.core.right
import io.kotest.core.spec.style.FunSpec
import io.kotest.matchers.shouldBe
import java.util.UUID

private val settings = gameSettings(listOf(4, 8, 4))
private val fresh: SessionState = sessionOf(sessionStarted(settings))
private val paused: SessionState = sessionOf(sessionStarted(settings), SessionEvent.SessionPaused)
private val otherFacilitator: Actor = Actor.Facilitator(GameId(UUID(0L, 99L)))

/** 小売店・二次卸・一次卸が入力済みで、工場だけが未入力の週（版はすべて 1）。 */
private val threeSaved: List<SessionEvent> =
    listOf(
        decisionSaved(Role.RETAILER, 4, submittedRoleCount = 1),
        decisionSaved(Role.WHOLESALER, 4, submittedRoleCount = 2),
        decisionSaved(Role.DISTRIBUTOR, 4, submittedRoleCount = 3),
    )

private fun ended(): SessionState = sessionPlayed(3, settings = settings).first

class SessionPauseProxySpec :
    FunSpec({
        context("[US3.1/AC3.1.1] PauseSession（進行役が、進行中のセッションを一時停止する）") {
            test("Given 進行中 When 進行役が一時停止 Then SessionPaused") {
                decideSession(fresh, pauseSession()) shouldBe listOf<SessionEvent>(SessionEvent.SessionPaused).right()
            }
            test("When 参加者・匿名・別のゲームの進行役が一時停止 Then Forbidden") {
                listOf(participantActor(1), anonymousActor, otherFacilitator).forEach { actor ->
                    decideSession(fresh, pauseSession(actor)).leftOrNull() shouldBe
                        SessionError.Forbidden("一時停止は進行役だけができる")
                }
            }
            test("Given すでに一時停止中 When 一時停止 Then Paused（二重の停止）") {
                decideSession(paused, pauseSession()) shouldBe SessionError.Paused.left()
            }
            test("Given 未開始 When 一時停止 Then NotActive") {
                decideSession(SessionState.NotStarted, pauseSession()) shouldBe SessionError.NotActive.left()
            }
            test("Given 終了 When 一時停止 Then AlreadyEnded") {
                decideSession(ended(), pauseSession()) shouldBe SessionError.AlreadyEnded.left()
            }
        }

        context("[US3.1/AC3.1.3] ResumeSession（進行役が、一時停止中のセッションを再開する）") {
            test("Given 一時停止中 When 進行役が再開 Then SessionResumed") {
                decideSession(paused, resumeSession()) shouldBe
                    listOf<SessionEvent>(SessionEvent.SessionResumed).right()
            }
            test("When 参加者・匿名・別のゲームの進行役が再開 Then Forbidden") {
                listOf(participantActor(1), anonymousActor, otherFacilitator).forEach { actor ->
                    decideSession(paused, resumeSession(actor)).leftOrNull() shouldBe
                        SessionError.Forbidden("再開は進行役だけができる")
                }
            }
            test("Given 進行中（停止中でない） When 再開 Then NotPaused") {
                decideSession(fresh, resumeSession()) shouldBe SessionError.NotPaused.left()
            }
            test("Given 未開始 When 再開 Then NotActive") {
                decideSession(SessionState.NotStarted, resumeSession()) shouldBe SessionError.NotActive.left()
            }
            test("Given 終了 When 再開 Then AlreadyEnded") {
                decideSession(ended(), resumeSession()) shouldBe SessionError.AlreadyEnded.left()
            }
        }

        context("[US3.1/AC3.1.1] 一時停止中は、参加者の保存と進行役の確定を拒否する（既存の入力は失わない）") {
            val savedThenPaused =
                sessionOf(sessionStarted(settings), *threeSaved.toTypedArray(), SessionEvent.SessionPaused)

            test("Given 一時停止中 When 工場の参加者が保存 Then Paused（NotActive とは別の code）") {
                decideSession(savedThenPaused, saveDecision(Role.FACTORY, 6)) shouldBe SessionError.Paused.left()
            }
            test("Given 4 役割が入力済みで一時停止中 When 進行役が確定 Then Paused") {
                val complete =
                    sessionOf(
                        sessionStarted(settings),
                        *allSavedEvents(same(4)).toTypedArray(),
                        SessionEvent.SessionPaused,
                    )
                decideSession(complete, commitWeek()) shouldBe SessionError.Paused.left()
            }
            test("拒否された後も、入力と週は一時停止の前と同じ（状態は decide で変わらない）") {
                decideSession(savedThenPaused, saveDecision(Role.FACTORY, 6))
                sessionDataOf(savedThenPaused).decisions.keys shouldBe
                    setOf(Role.RETAILER, Role.WHOLESALER, Role.DISTRIBUTOR)
                sessionDataOf(savedThenPaused).week shouldBe w(1)
            }
            test("エラーの code と分類") {
                SessionError.Paused.code shouldBe "session.paused"
                SessionError.Paused.category shouldBe ErrorCategory.InvalidState
                SessionError.NotPaused.code shouldBe "session.not_paused"
                SessionError.NotPaused.category shouldBe ErrorCategory.InvalidState
                SessionError.SaveLimitReached.code shouldBe "session.save_limit_reached"
                SessionError.SaveLimitReached.category shouldBe ErrorCategory.InvalidState
            }
        }

        context("[US3.1/AC3.1.2] SubmitProxyDecision（進行役が、不在の役割へ代わりに入力する）") {
            test("Given 進行中 When 進行役が工場の代理入力 6 Then ProxyDecisionSubmitted（値と進行役の入力者を残す）") {
                decideSession(fresh, submitProxy(Role.FACTORY, 6)) shouldBe
                    listOf<SessionEvent>(proxyDecisionSubmitted(Role.FACTORY, 6)).right()
            }
            test("Given 3 役割が入力済みで一時停止中 When 工場の代理入力 Then 受け付け、週は確定しない（イベントは 1 件）") {
                val state = sessionOf(sessionStarted(settings), *threeSaved.toTypedArray(), SessionEvent.SessionPaused)
                decideSession(state, submitProxy(Role.FACTORY, 6)) shouldBe
                    listOf<SessionEvent>(
                        proxyDecisionSubmitted(Role.FACTORY, 6, version = 1, submittedRoleCount = 4),
                    ).right()
            }
            test("Given 参加者が保存済み（版 1） When 代理入力 Then 版を 1 増やして上書きし、入力済みの数は増えない") {
                val state = sessionOf(sessionStarted(settings), decisionSaved(Role.RETAILER, 4))
                decideSession(state, submitProxy(Role.RETAILER, 9)) shouldBe
                    listOf<SessionEvent>(
                        proxyDecisionSubmitted(Role.RETAILER, 9, version = 2, submittedRoleCount = 1),
                    ).right()
            }
            test("代理入力のあと、古い版（0）を持つ参加者の保存は DecisionConflict（最新値と進行役の入力者を返す）") {
                val state = sessionOf(sessionStarted(settings), proxyDecisionSubmitted(Role.RETAILER, 9))
                decideSession(state, saveDecision(Role.RETAILER, 5, expectedVersion = 0)) shouldBe
                    SessionError.DecisionConflict(Role.RETAILER, DecisionEntry(q(9), dv(1), facilitatorEditor)).left()
            }
            test("When 参加者（その役割の担当者を含む）・匿名・別のゲームの進行役が代理入力 Then Forbidden") {
                listOf(participantActor(1), anonymousActor, otherFacilitator).forEach { actor ->
                    decideSession(fresh, submitProxy(Role.FACTORY, 6, actor = actor)).leftOrNull() shouldBe
                        SessionError.Forbidden("代理入力は進行役だけができる")
                }
            }
            test("Given 週が進んだ後 When 前の週（1）の画面から代理入力 Then WeekAdvanced（進行中でも一時停止中でも）") {
                val (afterWeek1, _) = sessionPlayed(1, settings = settings)
                val pausedAfterWeek1 = evolveSession(afterWeek1, SessionEvent.SessionPaused)
                listOf(afterWeek1, pausedAfterWeek1).forEach { state ->
                    decideSession(state, submitProxy(Role.FACTORY, 6, week = 1)) shouldBe
                        SessionError.WeekAdvanced(w(1), w(2)).left()
                }
            }
            test("Given 未開始 When 代理入力 Then NotActive") {
                decideSession(SessionState.NotStarted, submitProxy(Role.FACTORY, 6)) shouldBe
                    SessionError.NotActive.left()
            }
            test("Given 終了 When 代理入力 Then AlreadyEnded") {
                decideSession(ended(), submitProxy(Role.FACTORY, 6, week = 3)) shouldBe SessionError.AlreadyEnded.left()
            }
        }

        context("[NF-C8] 1 役割・1 週あたりの保存回数の上限は 9 回（代理入力を含む）") {
            test("Given 8 回保存済み When 9 回目の保存 Then 受け付ける（版 9）") {
                val state = sessionOf(sessionStarted(settings), *savedTimes(Role.RETAILER, 8).toTypedArray())
                decideSession(state, saveDecision(Role.RETAILER, 5, expectedVersion = 8)) shouldBe
                    listOf<SessionEvent>(decisionSaved(Role.RETAILER, 5, version = 9)).right()
            }
            test("Given 9 回保存済み When 10 回目の保存 Then SaveLimitReached") {
                val state = sessionOf(sessionStarted(settings), *savedTimes(Role.RETAILER, 9).toTypedArray())
                decideSession(state, saveDecision(Role.RETAILER, 5, expectedVersion = 9)) shouldBe
                    SessionError.SaveLimitReached.left()
            }
            test("Given 8 回保存済みと代理入力 1 回 When 参加者が保存 Then SaveLimitReached（代理入力も数える）") {
                val state =
                    sessionOf(
                        sessionStarted(settings),
                        *savedTimes(Role.RETAILER, 8).toTypedArray(),
                        proxyDecisionSubmitted(Role.RETAILER, 5, version = 9),
                    )
                decideSession(state, saveDecision(Role.RETAILER, 5, expectedVersion = 9)) shouldBe
                    SessionError.SaveLimitReached.left()
            }
            test("Given 9 回保存済み When 代理入力 Then SaveLimitReached（進行役も超えられない）") {
                val state = sessionOf(sessionStarted(settings), *savedTimes(Role.RETAILER, 9).toTypedArray())
                decideSession(state, submitProxy(Role.RETAILER, 5)) shouldBe SessionError.SaveLimitReached.left()
            }
            test("上限は役割ごと: 小売店が 9 回でも、工場は保存できる") {
                val state = sessionOf(sessionStarted(settings), *savedTimes(Role.RETAILER, 9).toTypedArray())
                decideSession(state, saveDecision(Role.FACTORY, 5)) shouldBe
                    listOf<SessionEvent>(decisionSaved(Role.FACTORY, 5, version = 1, submittedRoleCount = 2)).right()
            }
            test("上限は週ごと: 確定で数え直し、次週の最初の保存を受け付ける") {
                val before =
                    sessionOf(
                        sessionStarted(settings),
                        *savedTimes(Role.RETAILER, 9).toTypedArray(),
                        decisionSaved(Role.FACTORY, 4, submittedRoleCount = 2),
                        decisionSaved(Role.DISTRIBUTOR, 4, submittedRoleCount = 3),
                        decisionSaved(Role.WHOLESALER, 4, submittedRoleCount = 4),
                    )
                val committed = committedWeekEvents(before, decisions(4, 4, 4, 9))
                val nextWeek = committed.fold(before, ::evolveSession)
                decideSession(nextWeek, saveDecision(Role.RETAILER, 5, week = 2)) shouldBe
                    listOf<SessionEvent>(decisionSaved(Role.RETAILER, 5, version = 1, week = 2)).right()
            }
            test("判定順: 週が古ければ WeekAdvanced、版が古ければ DecisionConflict を、上限より先に返す") {
                val state = sessionOf(sessionStarted(settings), *savedTimes(Role.RETAILER, 9).toTypedArray())
                decideSession(state, saveDecision(Role.RETAILER, 5, week = 2, expectedVersion = 9)) shouldBe
                    SessionError.WeekAdvanced(w(2), w(1)).left()
                decideSession(state, saveDecision(Role.RETAILER, 5, expectedVersion = 3)).leftOrNull() shouldBe
                    SessionError.DecisionConflict(
                        Role.RETAILER,
                        DecisionEntry(q(9), dv(9), Editor.ByParticipant(pid(4))),
                    )
            }
        }

        context("decideSession は純粋（同じ Given と When は、何度でも同じ Then）") {
            test("停止・再開・代理入力も、同じ結果を返す") {
                listOf(pauseSession(), resumeSession(), submitProxy(Role.FACTORY, 6)).forEach { command ->
                    decideSession(paused, command) shouldBe decideSession(paused, command)
                }
            }
        }
    })
