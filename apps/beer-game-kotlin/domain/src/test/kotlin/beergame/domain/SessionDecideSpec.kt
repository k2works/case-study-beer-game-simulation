package beergame.domain

import arrow.core.left
import arrow.core.right
import io.kotest.core.spec.style.FunSpec
import io.kotest.matchers.shouldBe

private val settings = gameSettings(listOf(4, 8, 4))
private val fresh: SessionState = sessionOf(sessionStarted(settings))
private val fours = same(4)

private fun entry(
    role: Role,
    quantity: Int,
    version: Long,
): DecisionEntry = DecisionEntry(q(quantity), dv(version), Editor.ByParticipant(pid(role.ordinal + 1)))

class SessionDecideSpec :
    FunSpec({
        context("[US2.2/AC2.2.1] SaveDecision（進行中、その役割の参加者が、当週の数量を保存する）") {
            test("Given 進行中 When 流通役（一次卸）が 8 を保存 Then DecisionSaved（版 1、入力済み 1）") {
                decideSession(fresh, saveDecision(Role.DISTRIBUTOR, 8)) shouldBe
                    listOf(decisionSaved(Role.DISTRIBUTOR, 8, version = 1, submittedRoleCount = 1)).right()
            }
            test("Given 進行中 When 生産役（工場）が 6 を保存 Then DecisionSaved（生産要請として同じ形で保存）") {
                decideSession(fresh, saveDecision(Role.FACTORY, 6)) shouldBe
                    listOf(decisionSaved(Role.FACTORY, 6, version = 1, submittedRoleCount = 1)).right()
            }
            test("[US2.2/AC2.2.2] 数量の境界 0 と 1000 は保存できる") {
                listOf(0, 1000).forEach { n ->
                    decideSession(fresh, saveDecision(Role.RETAILER, n)) shouldBe
                        listOf(decisionSaved(Role.RETAILER, n, version = 1, submittedRoleCount = 1)).right()
                }
            }
            test("Given 2 役割が保存済み When 3 つ目の役割が保存 Then 入力済みの役割数は 3") {
                val state =
                    sessionOf(
                        sessionStarted(settings),
                        decisionSaved(Role.FACTORY, 4),
                        decisionSaved(Role.DISTRIBUTOR, 4, submittedRoleCount = 2),
                    )
                decideSession(state, saveDecision(Role.WHOLESALER, 4)) shouldBe
                    listOf(decisionSaved(Role.WHOLESALER, 4, version = 1, submittedRoleCount = 3)).right()
            }
            test("Given 保存済み（版 1） When 版 1 を期待して保存し直す Then 版 2 で上書きし、入力済みの数は増えない") {
                val state = sessionOf(sessionStarted(settings), decisionSaved(Role.RETAILER, 4))
                decideSession(state, saveDecision(Role.RETAILER, 9, expectedVersion = 1)) shouldBe
                    listOf(decisionSaved(Role.RETAILER, 9, version = 2, submittedRoleCount = 1)).right()
            }
            test("Given 保存済み（版 1） When 古い版 0 を期待して保存 Then DecisionConflict（最新値と保存者を返す）") {
                val state = sessionOf(sessionStarted(settings), decisionSaved(Role.RETAILER, 4))
                decideSession(state, saveDecision(Role.RETAILER, 9, expectedVersion = 0)) shouldBe
                    SessionError.DecisionConflict(Role.RETAILER, entry(Role.RETAILER, 4, 1)).left()
            }
            test("Given 週が進んだ後 When 前の週（1）の画面から保存 Then WeekAdvanced（要求した週と現在の週）") {
                val (afterWeek1, _) = sessionPlayed(1, settings = settings)
                decideSession(afterWeek1, saveDecision(Role.RETAILER, 4, week = 1)) shouldBe
                    SessionError.WeekAdvanced(w(1), w(2)).left()
            }
            test("週も版も古い保存は、共同入力の競合（DecisionConflict）でなく WeekAdvanced を優先して返す") {
                val state = sessionOf(sessionStarted(settings), decisionSaved(Role.RETAILER, 4))
                decideSession(state, saveDecision(Role.RETAILER, 9, week = 2, expectedVersion = 0)) shouldBe
                    SessionError.WeekAdvanced(w(2), w(1)).left()
            }
        }

        context("[US2.1/AC2.1.2] SaveDecision の権限（その役割の参加者だけ）") {
            test("When 別の役割の参加者が保存 Then Forbidden") {
                decideSession(fresh, saveDecision(Role.RETAILER, 4, actor = participantActor(1)))
                    .leftOrNull()
                    .shouldBeForbidden()
            }
            test("When 進行役・匿名が保存 Then Forbidden（B1 では代理入力は無い）") {
                listOf(facilitatorActor, anonymousActor).forEach { actor ->
                    decideSession(fresh, saveDecision(Role.RETAILER, 4, actor = actor)).leftOrNull().shouldBeForbidden()
                }
            }
            test("Given 未開始 When 保存 Then NotActive") {
                decideSession(SessionState.NotStarted, saveDecision(Role.RETAILER, 4)) shouldBe
                    SessionError.NotActive.left()
            }
            test("Given 終了 When 保存 Then AlreadyEnded") {
                val (ended, _) = sessionPlayed(3, settings = settings)
                decideSession(ended, saveDecision(Role.RETAILER, 4, week = 3)) shouldBe SessionError.AlreadyEnded.left()
            }
        }

        context("[US2.3/AC2.3.1] CommitWeek（進行役が、4 役割の入力がそろった週を手動で確定する）") {
            val saved = sessionOf(sessionStarted(settings), *allSavedEvents(fours).toTypedArray())

            test("Given 4 役割が入力済み When 進行役が第 1 週を確定 Then WeekCommitted 1 件（結果は simulateWeek の値）") {
                val states = sessionDataOf(saved).roleStates
                val outcome = simulateWeek(settings.simulation(), w(1), states, fours)
                decideSession(saved, commitWeek()) shouldBe
                    listOf(
                        SessionEvent.WeekCommitted(
                            w(1),
                            CommitKind.MANUAL,
                            fours,
                            outcome.results,
                            outcome.nextStates,
                            4,
                        ),
                    ).right()
            }
            test("[US2.3/AC2.3.5] 確定の結果は、役割別の注文・在庫・受注残・出荷・費用を持つ（定常: 在庫 12、費用 600）") {
                val committed = committedOf(decideSession(saved, commitWeek()).valid("確定"))
                Role.entries.forEach { role ->
                    val r = committed.results[role]
                    r.ordered shouldBe q(4)
                    r.shipped shouldBe u(4)
                    r.endingInventory shouldBe u(12)
                    r.endingBacklog shouldBe u(0)
                    r.weeklyCost shouldBe m(600)
                    r.cumulativeCost shouldBe m(600)
                }
            }
            test("[US2.1/AC2.1.3] 次週の状態の小売店の受注は、次週（第 2 週）の顧客需要 8") {
                val committed = committedOf(decideSession(saved, commitWeek()).valid("確定"))
                committed.nextStates.retailer.orders shouldBe u(8)
                committed.nextStates.wholesaler.orders shouldBe u(4)
            }
            test("[US2.3/AC2.3.2] Given 確定後（第 2 週） When 同じ第 1 週を別の要求で確定 Then WeekAdvanced（結果は増えない）") {
                val (afterWeek1, _) = sessionPlayed(1, settings = settings)
                decideSession(afterWeek1, commitWeek(week = 1)) shouldBe SessionError.WeekAdvanced(w(1), w(2)).left()
            }
            test("Given 最終週（第 3 週）に 4 役割が入力済み When 確定 Then WeekCommitted の後に SessionEnded（最終週）") {
                val (week3, _) = sessionPlayed(2, settings = settings)
                val withInputs = allSavedEvents(fours, 3).fold(week3) { s, e -> evolveSession(s, e) }
                val result = decideSession(withInputs, commitWeek(week = 3)).valid("最終週の確定")
                result.size shouldBe 2
                committedOf(result).week shouldBe w(3)
                result[1] shouldBe SessionEvent.SessionEnded(EndReason.FINAL_WEEK)
            }
            test("Given 最終週が確定済みで終了 When 確定 Then AlreadyEnded") {
                val (ended, _) = sessionPlayed(3, settings = settings)
                decideSession(ended, commitWeek(week = 3)) shouldBe SessionError.AlreadyEnded.left()
            }
            test("Given 未開始 When 確定 Then NotActive") {
                decideSession(SessionState.NotStarted, commitWeek()) shouldBe SessionError.NotActive.left()
            }
        }

        context("[US2.3] CommitWeek が拒否される場合（週・根拠の入力・権限・入力の不足）") {
            val saved = sessionOf(sessionStarted(settings), *allSavedEvents(fours).toTypedArray())

            test("Given 4 役割のうち工場が未入力 When 確定 Then IncompleteDecisions（不足している役割を示す）") {
                val state = sessionOf(sessionStarted(settings), *allSavedEvents(fours).drop(1).toTypedArray())
                val basis = RoleMap(dv(0), dv(1), dv(1), dv(1))
                decideSession(state, commitWeek(basis = basis)) shouldBe
                    SessionError.IncompleteDecisions(listOf(Role.FACTORY)).left()
            }
            test("Given 1 役割も未入力 When 確定 Then 4 役割すべてが不足") {
                decideSession(fresh, commitWeek(basis = RoleMap.all(dv(0)))) shouldBe
                    SessionError.IncompleteDecisions(Role.entries).left()
            }
            test("Given 入力済み When 確定の根拠にした版と現在の版が違う Then DecisionsChanged（現在の値と保存者を返す）") {
                val staleBasis = RoleMap(dv(1), dv(1), dv(1), dv(0))
                val expected = Role.entries.associateWith { entry(it, 4, 1) }
                decideSession(saved, commitWeek(basis = staleBasis)) shouldBe
                    SessionError.DecisionsChanged(w(1), expected).left()
            }
            test("週も根拠も違う確定は、WeekAdvanced を先に返す（判定順 1: 週）") {
                decideSession(saved, commitWeek(week = 2, basis = RoleMap.all(dv(0)))) shouldBe
                    SessionError.WeekAdvanced(w(2), w(1)).left()
            }
            test("When 進行役以外（参加者・匿名）が確定 Then Forbidden") {
                listOf(participantActor(4), anonymousActor).forEach { actor ->
                    decideSession(saved, commitWeek(actor = actor)).leftOrNull().shouldBeForbidden()
                }
            }
        }

        context("decideSession は純粋（同じ Given と When は、何度でも同じ Then）") {
            test("同じ状態とコマンドは、同じ結果を返す") {
                val saved = sessionOf(sessionStarted(settings), *allSavedEvents(fours).toTypedArray())
                decideSession(saved, commitWeek()) shouldBe decideSession(saved, commitWeek())
            }
        }
    })

private fun SessionError?.shouldBeForbidden() {
    (this is SessionError.Forbidden) shouldBe true
}
