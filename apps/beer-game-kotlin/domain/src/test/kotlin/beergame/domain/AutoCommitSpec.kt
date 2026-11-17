package beergame.domain

import arrow.core.left
import arrow.core.right
import io.kotest.core.spec.style.FunSpec
import io.kotest.matchers.collections.shouldContainExactly
import io.kotest.matchers.shouldBe
import java.util.UUID

private val manualSettings = gameSettings(listOf(4, 8, 4))
private val autoSettings = manualSettings.copy(commitMode = CommitMode.AUTO)
private val otherFacilitator: Actor = Actor.Facilitator(GameId(UUID(0L, 99L)))

/** 小売店・二次卸・一次卸が入力済みで、工場だけが未入力の週（版はすべて 1）。 */
private val threeSaved: Array<SessionEvent> =
    arrayOf(
        decisionSaved(Role.RETAILER, 4, submittedRoleCount = 1),
        decisionSaved(Role.WHOLESALER, 4, submittedRoleCount = 2),
        decisionSaved(Role.DISTRIBUTOR, 4, submittedRoleCount = 3),
    )

private fun autoWithThree(): SessionState = sessionOf(sessionStarted(autoSettings), *threeSaved)

private fun committedAuto(
    state: SessionState,
    decisions: RoleMap<Quantity>,
): List<SessionEvent> =
    committedWeekEvents(state, decisions).map { event ->
        if (event is SessionEvent.WeekCommitted) event.copy(commitKind = CommitKind.AUTO) else event
    }

private val allFour: RoleMap<Quantity> = same(4)

/** B8（US2.4。AC1.1.6、AC2.4.1〜2.4.5）: 自動確定。最後の入力と同じ追記で、週を確定する。 */
class AutoCommitSpec :
    FunSpec({
        context("[US2.4/AC2.4.1] 自動確定が有効で、最後の入力で 4 役割がそろうと、同じ追記で確定する") {
            test("参加者の保存: 保存と確定（AUTO）が同じ決定で返り、結果は手動確定と同じ計算") {
                val state = autoWithThree()
                val saved = decisionSaved(Role.FACTORY, 4, submittedRoleCount = 4)

                val events = decideSession(state, saveDecision(Role.FACTORY, 4)).getOrNull().orEmpty()

                events.take(1) shouldBe listOf<SessionEvent>(saved)
                events.drop(1) shouldBe
                    committedAuto(sessionOf(sessionStarted(autoSettings), *threeSaved, saved), allFour)
            }

            test("代理入力: 保存と確定（AUTO）が同じ決定で返る") {
                val state = autoWithThree()
                val proxy = proxyDecisionSubmitted(Role.FACTORY, 4, submittedRoleCount = 4)

                val events = decideSession(state, submitProxy(Role.FACTORY, 4)).getOrNull().orEmpty()

                events.take(1) shouldBe listOf<SessionEvent>(proxy)
                events.drop(1) shouldBe
                    committedAuto(sessionOf(sessionStarted(autoSettings), *threeSaved, proxy), allFour)
            }

            test("そろっていない保存では、確定しない") {
                val state = sessionOf(sessionStarted(autoSettings), threeSaved[0])

                decideSession(state, saveDecision(Role.FACTORY, 4)).getOrNull().orEmpty().size shouldBe 1
            }

            test("最終週の自動確定は、SessionEnded も同じ追記で返る") {
                val oneWeek = gameSettings(listOf(4)).copy(commitMode = CommitMode.AUTO)
                val state = sessionOf(sessionStarted(oneWeek), *threeSaved)

                val events = decideSession(state, saveDecision(Role.FACTORY, 4)).getOrNull().orEmpty()

                events.map { it::class } shouldContainExactly
                    listOf(
                        SessionEvent.DecisionSaved::class,
                        SessionEvent.WeekCommitted::class,
                        SessionEvent.SessionEnded::class,
                    )
            }

            test("確定したあとの状態は次の週で、入力は空（同じ週は、もう一度確定できない）") {
                val state = autoWithThree()
                val events = decideSession(state, saveDecision(Role.FACTORY, 4)).getOrNull().orEmpty()

                val after = events.fold(state, ::evolveSession)

                sessionDataOf(after).week shouldBe w(2)
                sessionDataOf(after).decisions shouldBe emptyMap()
                decideSession(after, commitWeek(week = 1)).leftOrNull() shouldBe SessionError.WeekAdvanced(w(1), w(2))
            }
        }

        context("[US2.4/AC2.4.2] 自動確定が無効なら、入力がそろっても確定しない") {
            test("手動確定のゲームの最後の保存は、保存だけ") {
                val state = sessionOf(sessionStarted(manualSettings), *threeSaved)

                decideSession(state, saveDecision(Role.FACTORY, 4)) shouldBe
                    listOf<SessionEvent>(decisionSaved(Role.FACTORY, 4, submittedRoleCount = 4)).right()
            }
        }

        context("[US2.4/AC2.4.3] 一時停止中は確定せず、再開のときにそろっていれば確定する") {
            test("停止中の代理入力でそろっても、代理入力だけ") {
                val state = sessionOf(sessionStarted(autoSettings), *threeSaved, SessionEvent.SessionPaused)

                decideSession(state, submitProxy(Role.FACTORY, 4)) shouldBe
                    listOf<SessionEvent>(proxyDecisionSubmitted(Role.FACTORY, 4, submittedRoleCount = 4)).right()
            }

            test("再開: SessionResumed と同じ追記で、確定（AUTO）が返る") {
                val proxy = proxyDecisionSubmitted(Role.FACTORY, 4, submittedRoleCount = 4)
                val state = sessionOf(sessionStarted(autoSettings), *threeSaved, SessionEvent.SessionPaused, proxy)

                val events = decideSession(state, resumeSession()).getOrNull().orEmpty()

                events.take(1) shouldBe listOf<SessionEvent>(SessionEvent.SessionResumed)
                events.drop(1) shouldBe
                    committedAuto(sessionOf(sessionStarted(autoSettings), *threeSaved, proxy), allFour)
            }

            test("再開しても、そろっていなければ確定しない") {
                val state = sessionOf(sessionStarted(autoSettings), *threeSaved, SessionEvent.SessionPaused)

                decideSession(state, resumeSession()) shouldBe listOf<SessionEvent>(SessionEvent.SessionResumed).right()
            }
        }

        context("[US2.4/AC2.4.5] SetCommitMode（進行役が、いつでも確定方式を変える）") {
            test("進行役は、無効にできる。そのあとの最後の保存は、確定しない") {
                val state = autoWithThree()

                decideSession(state, setCommitMode(CommitMode.MANUAL)) shouldBe
                    listOf<SessionEvent>(SessionEvent.CommitModeChanged(CommitMode.MANUAL)).right()
                val manual = evolveSession(state, SessionEvent.CommitModeChanged(CommitMode.MANUAL))
                decideSession(manual, saveDecision(Role.FACTORY, 4)).getOrNull().orEmpty().size shouldBe 1
            }

            test("停止中でも変えられる") {
                val state = evolveSession(autoWithThree(), SessionEvent.SessionPaused)

                decideSession(state, setCommitMode(CommitMode.MANUAL)) shouldBe
                    listOf<SessionEvent>(SessionEvent.CommitModeChanged(CommitMode.MANUAL)).right()
            }

            test("すでにそろっている進行中に有効にすると、変更と同じ追記で確定（AUTO）が返る") {
                val state =
                    sessionOf(
                        sessionStarted(manualSettings),
                        *threeSaved,
                        decisionSaved(Role.FACTORY, 4, submittedRoleCount = 4),
                    )

                val events = decideSession(state, setCommitMode(CommitMode.AUTO)).getOrNull().orEmpty()

                events.take(1) shouldBe listOf<SessionEvent>(SessionEvent.CommitModeChanged(CommitMode.AUTO))
                events.drop(1).map { it::class } shouldBe listOf(SessionEvent.WeekCommitted::class)
            }

            test("停止中に有効にしても、確定しない") {
                val state =
                    sessionOf(
                        sessionStarted(manualSettings),
                        *threeSaved,
                        decisionSaved(Role.FACTORY, 4, submittedRoleCount = 4),
                        SessionEvent.SessionPaused,
                    )

                decideSession(state, setCommitMode(CommitMode.AUTO)) shouldBe
                    listOf<SessionEvent>(SessionEvent.CommitModeChanged(CommitMode.AUTO)).right()
            }

            test("参加者・匿名・別のゲームの進行役は変えられない（Forbidden）") {
                listOf(participantActor(1), anonymousActor, otherFacilitator).forEach { actor ->
                    decideSession(autoWithThree(), setCommitMode(CommitMode.MANUAL, actor)).leftOrNull() shouldBe
                        SessionError.Forbidden("確定方式の変更は進行役だけができる")
                }
            }

            test("未開始は NotActive、終了後は AlreadyEnded") {
                decideSession(SessionState.NotStarted, setCommitMode(CommitMode.AUTO)) shouldBe
                    SessionError.NotActive.left()
                val ended = sessionPlayed(3, settings = manualSettings).first
                decideSession(ended, setCommitMode(CommitMode.AUTO)) shouldBe SessionError.AlreadyEnded.left()
            }

            test("evolve: CommitModeChanged は、確定方式だけを変える") {
                val after = evolveSession(autoWithThree(), SessionEvent.CommitModeChanged(CommitMode.MANUAL))

                sessionDataOf(after).commitMode shouldBe CommitMode.MANUAL
                sessionDataOf(after).decisions.size shouldBe 3
            }
        }
    })

private fun setCommitMode(
    mode: CommitMode,
    actor: Actor = facilitatorActor,
): SessionCommand.SetCommitMode = SessionCommand.SetCommitMode(actor, t0, mode)
