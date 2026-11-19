package beergame.domain

import arrow.core.left
import arrow.core.right
import io.kotest.core.spec.style.FunSpec
import io.kotest.matchers.shouldBe
import java.util.UUID

/*
 * 役割の入れ替え（開始後の AssignRole。H4。B5 Step 3.5）。担当者のいる役割へ、参加済み・未割り当ての参加者を割り当てる。
 * 旧担当者の資格は同じ追記で失効し、session の役割の写し（D4）も同じ追記で更新する。準備中の付け替え（D9）は変えない。
 * 参加者 1〜4 が工場〜小売店、参加者 5 が「役割なしで参加している人」（シナリオの「佐藤」）。
 */

private val otherFacilitator: Actor = Actor.Facilitator(GameId(UUID(0L, 99L)))

private fun startedGame(vararg extra: GameEvent): GameState =
    gameOf(*(fullyAssignedEvents() + participantJoined(5) + extra + gameStarted()).toTypedArray())

private val started: GameState = startedGame()
private val active: SessionState = sessionOf(sessionStarted())
private val paused: SessionState = sessionOf(sessionStarted(), SessionEvent.SessionPaused)
private val ended: SessionState = sessionPlayed(3).first

private fun replace(
    game: GameState = started,
    session: SessionState = active,
    command: GameCommand.AssignRole = assignRole(5, Role.RETAILER),
) = assignRoleAfterStart(game, session, command)

/** 小売店の担当者（参加者 4）が、参加者 5 に入れ替えられたときの、2 ストリームのイベント。 */
private val retailerReplaced =
    ReplaceDecision(
        game =
            listOf(
                participantReplaced(4, Role.RETAILER, replacedBy = 5),
                credentialRevoked(participantSubject(4)),
                roleAssigned(5, Role.RETAILER),
            ),
        session = listOf(roleHolderReplaced(Role.RETAILER, removed = setOf(4), added = 5)),
    )

class ReplaceRoleSpec :
    FunSpec({
        context("[US3.2/AC3.2.5] assignRoleAfterStart（入れ替え。旧担当者の資格を同じ追記で失効し、新担当者が引き継ぐ）") {
            test("Given 開始後・役割なしの参加者 5 When 進行役が小売店へ割り当て Then 外れた事実・失効・割り当て・写しの更新を返す") {
                replace() shouldBe retailerReplaced.right()
            }
            test("Given 一時停止中 When 入れ替え Then 進行中と同じく受け付ける") {
                replace(session = paused) shouldBe retailerReplaced.right()
            }
            test("Given 共同担当（小売店に参加者 4 と 6） When 入れ替え Then 担当者全員が外れ、失効する（参加者の識別子の順）") {
                val game = startedGame(participantJoined(6), roleAssigned(6, Role.RETAILER))
                val session = sessionOf(sessionStartedWithRetailers(setOf(4, 6)))
                replace(game, session) shouldBe
                    ReplaceDecision(
                        game =
                            listOf(
                                participantReplaced(4, Role.RETAILER, replacedBy = 5),
                                credentialRevoked(participantSubject(4)),
                                participantReplaced(6, Role.RETAILER, replacedBy = 5),
                                credentialRevoked(participantSubject(6)),
                                roleAssigned(5, Role.RETAILER),
                            ),
                        session = listOf(roleHolderReplaced(Role.RETAILER, removed = setOf(4, 6), added = 5)),
                    ).right()
            }
            test("Given 工場の入れ替え When 実行 Then 工場だけが対象で、ほかの役割の担当者は変わらない") {
                replace(command = assignRole(5, Role.FACTORY)) shouldBe
                    ReplaceDecision(
                        game =
                            listOf(
                                participantReplaced(1, Role.FACTORY, replacedBy = 5),
                                credentialRevoked(participantSubject(1)),
                                roleAssigned(5, Role.FACTORY),
                            ),
                        session = listOf(roleHolderReplaced(Role.FACTORY, removed = setOf(1), added = 5)),
                    ).right()
            }
        }

        context("[US3.2/AC3.2.5] 返したイベントを evolve すると、役割・資格・写しが入れ替わる") {
            val decision = replace().valid("入れ替え")
            val game = decision.game.fold(started, ::evolveGame)
            val data = gameDataOf(game)

            test("新担当者が役割を持ち、旧担当者は役割がなく、資格が失効している。参加者の行は残る") {
                data.participants[pid(5)] shouldBe ParticipantEntry(Role.RETAILER)
                data.participants[pid(4)] shouldBe ParticipantEntry(null)
                data.credentials[participantSubject(4)]?.revoked shouldBe true
                data.credentials[participantSubject(5)]?.revoked shouldBe false
            }
            test("ほかの参加者の役割と資格は変わらない。ゲームは開始済みのまま、版は追記したイベントの数だけ進む") {
                (1..3).forEach { n ->
                    data.participants[pid(n)] shouldBe ParticipantEntry(roleOfParticipant(n))
                    data.credentials[participantSubject(n)]?.revoked shouldBe false
                }
                (game is GameState.Started) shouldBe true
                game.version shouldBe sv(started.version.value + decision.game.size)
            }
            test("session の写しは、小売店だけが旧担当者から新担当者へ変わる") {
                val session = decision.session.fold(active, ::evolveSession)
                val assignments = sessionDataOf(session).assignments
                assignments.retailer shouldBe setOf(pid(5))
                assignments.factory shouldBe setOf(pid(1))
                (session is SessionState.Active) shouldBe true
            }
            test("当週に保存済みの意思決定と版は、新担当者が引き継ぐ（変えない）") {
                val saved = sessionOf(sessionStarted(), decisionSaved(Role.RETAILER, 4))
                val session = decision.session.fold(saved, ::evolveSession)
                sessionDataOf(session).decisions shouldBe sessionDataOf(saved).decisions
                sessionDataOf(session).decisionVersions shouldBe sessionDataOf(saved).decisionVersions
            }
            test("新担当者は、写しの更新後に自分の役割の数量を保存でき、旧担当者はできない") {
                val session = decision.session.fold(active, ::evolveSession)
                val byNew = saveDecision(Role.RETAILER, 5, actor = participantActor(5))
                val byOld = saveDecision(Role.RETAILER, 5, actor = participantActor(4))
                decideSession(session, byNew).isRight() shouldBe true
                decideSession(session, byOld).leftOrNull() shouldBe
                    SessionError.Forbidden("その役割の参加者だけが入力できる")
            }
        }

        context("[US3.2/AC3.2.5] 何も変わらない割り当て直しは、履歴に足さない（D9 の開始後への延長）") {
            test("Given 参加者 4 が小売店 When 小売店へ割り当て直し Then イベントなし（資格も失効させない）") {
                replace(command = assignRole(4, Role.RETAILER)) shouldBe
                    ReplaceDecision(emptyList(), emptyList()).right()
            }
            test("変化なしの判定は、終了の判定より先（終了後でも、何も変わらない要求は拒否しない）") {
                replace(session = ended, command = assignRole(4, Role.RETAILER)) shouldBe
                    ReplaceDecision(emptyList(), emptyList()).right()
            }
        }

        context("[US3.2/AC3.2.5] 拒否（判定順: 権限 → 参加者の存在 → 変化なし → 別の役割 → 資格の失効 → 終了）") {
            test("進行役以外（参加者・匿名・別のゲームの進行役）は Forbidden") {
                listOf(participantActor(4), anonymousActor, otherFacilitator).forEach { actor ->
                    replace(command = assignRole(5, Role.RETAILER, actor)).leftOrNull() shouldBe
                        GameError.Forbidden("割り当ては進行役だけができる")
                }
            }
            test("権限の判定が先: 進行役以外が未知の参加者を指しても、存在を知らせず Forbidden") {
                replace(command = assignRole(9, Role.RETAILER, participantActor(4))).leftOrNull() shouldBe
                    GameError.Forbidden("割り当ては進行役だけができる")
            }
            test("未知の参加者は ParticipantNotFound") {
                replace(command = assignRole(9, Role.RETAILER)) shouldBe GameError.ParticipantNotFound(pid(9)).left()
            }
            test("別の役割にいる参加者の付け替えは、開始後は NotPreparing（従来どおり拒否。資格は失効させない）") {
                replace(command = assignRole(3, Role.RETAILER)) shouldBe GameError.NotPreparing.left()
            }
            test("別の役割の判定が先: 別の役割にいて資格も失効している人は NotPreparing") {
                val game = startedGame(credentialRevoked(participantSubject(3)))
                replace(game, command = assignRole(3, Role.RETAILER)) shouldBe GameError.NotPreparing.left()
            }
            test("資格が失効している参加者（手動の失効）は、新担当者になれず CredentialAlreadyRevoked") {
                val game = startedGame(credentialRevoked(participantSubject(5)))
                replace(game) shouldBe GameError.CredentialAlreadyRevoked.left()
            }
            test("以前に入れ替えられた旧担当者（役割なし・失効済み）も、新担当者になれない") {
                val game = fold(started, retailerReplaced.game)
                replace(game, command = assignRole(4, Role.FACTORY)) shouldBe GameError.CredentialAlreadyRevoked.left()
            }
            test("終了後は AlreadyEnded（セッションが終わっている）") {
                replace(session = ended) shouldBe SessionError.AlreadyEnded.left()
            }
            test("資格の失効の判定が先: 失効済みの参加者は、終了後でも CredentialAlreadyRevoked") {
                val game = startedGame(credentialRevoked(participantSubject(5)))
                replace(game, ended) shouldBe GameError.CredentialAlreadyRevoked.left()
            }
            test("セッションが未開始（開始済みのゲームとは通常ありえない列）は NotActive") {
                replace(session = SessionState.NotStarted) shouldBe SessionError.NotActive.left()
            }
            test("準備中・未作成のゲームは NotPreparing（準備中の付け替えは decideGame の担当）") {
                val preparing = gameOf(*(fullyAssignedEvents() + participantJoined(5)).toTypedArray())
                replace(preparing) shouldBe GameError.NotPreparing.left()
                replace(GameState.NotCreated) shouldBe GameError.NotPreparing.left()
            }
        }

        context("[US1.2/AC1.2.5] 準備中の付け替え（B1 の D9）は変えない（回帰）") {
            val preparing = gameOf(*(fullyAssignedEvents() + participantJoined(5)).toTypedArray())

            test("準備中: 役割なしの参加者を、担当者のいる役割へ割り当てると、RoleAssigned だけ（誰も外れず、失効しない）") {
                decideGame(preparing, assignRole(5, Role.RETAILER)) shouldBe
                    listOf<GameEvent>(roleAssigned(5, Role.RETAILER)).right()
            }
            test("準備中: 別の役割へ付け替えると RoleUnassigned と RoleAssigned の 2 イベント") {
                decideGame(preparing, assignRole(3, Role.RETAILER)) shouldBe
                    listOf(roleUnassigned(3, Role.WHOLESALER), roleAssigned(3, Role.RETAILER)).right()
            }
            test("準備中: 同じ役割への割り当て直しは、何も返さない") {
                decideGame(preparing, assignRole(4, Role.RETAILER)) shouldBe emptyList<GameEvent>().right()
            }
            test("開始後に decideGame へ届いた AssignRole は、従来どおり NotPreparing（入れ替えは assignRoleAfterStart の担当）") {
                decideGame(started, assignRole(5, Role.RETAILER)) shouldBe GameError.NotPreparing.left()
            }
        }
    })

private fun fold(
    state: GameState,
    events: List<GameEvent>,
): GameState = events.fold(state, ::evolveGame)

/** 小売店に [retailers]（参加者の番号）がいる、開始時の写し（ほかの役割は 1 人ずつ）。 */
private fun sessionStartedWithRetailers(retailers: Set<Int>): SessionEvent.SessionStarted =
    sessionStarted().copy(
        assignments = assignedParticipants.copy(retailer = retailers.map(::pid).toSet()),
    )
