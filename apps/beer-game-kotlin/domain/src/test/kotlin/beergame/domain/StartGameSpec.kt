package beergame.domain

import arrow.core.left
import arrow.core.right
import io.kotest.core.spec.style.FunSpec
import io.kotest.matchers.shouldBe

private val settings = gameSettings()

private fun startGameCommand(actor: Actor = facilitatorActor): StartGame = StartGame(actor, t0)

private fun gameWith(vararg assigned: Pair<Int, Role>): GameState {
    val joins = assigned.map { participantJoined(it.first) }
    val assigns = assigned.map { roleAssigned(it.first, it.second) }
    return gameOf(gameCreated(settings), *(joins + assigns).toTypedArray())
}

class StartGameSpec :
    FunSpec({
        context("[US1.2/AC1.2.3] startGame（4 役割がそろっていれば、2 つのストリームのイベントを返す）") {
            test("Given 4 役割に 1 人ずつ When 進行役が開始 Then GameStarted と SessionStarted（設定・割り当ての写し・初期状態）") {
                startGame(fullyAssignedGame(), SessionState.NotStarted, startGameCommand()) shouldBe
                    StartDecision(
                        game = listOf(GameEvent.GameStarted(gid)),
                        session =
                            listOf(
                                SessionEvent.SessionStarted(
                                    gid,
                                    settings,
                                    assignedParticipants,
                                    KitPreset.initialStates(settings.demand),
                                    CommitMode.MANUAL,
                                ),
                            ),
                    ).right()
            }
            test("共同担当（同じ役割に 2 人）の割り当ては、写しに両方を含み、役割のない参加者は含まない") {
                val game =
                    gameOf(
                        *(
                            fullyAssignedEvents() +
                                participantJoined(5) +
                                roleAssigned(5, Role.RETAILER) +
                                participantJoined(6)
                        ).toTypedArray(),
                    )
                val decision = startGame(game, SessionState.NotStarted, startGameCommand()).valid("開始")
                val started = decision.session.filterIsInstance<SessionEvent.SessionStarted>().single()
                started.assignments.retailer shouldBe setOf(pid(4), pid(5))
                started.assignments.factory shouldBe setOf(pid(1))
            }
            test("返したイベントを evolve すると、ゲームは開始済み、セッションは進行中の第 1 週になる") {
                val game = fullyAssignedGame()
                val decision = startGame(game, SessionState.NotStarted, startGameCommand()).valid("開始")
                decision.game.fold(game, ::evolveGame) shouldBe GameState.Started(gameDataOf(game), game.version.next())
                val session =
                    decision.session.fold<SessionEvent, SessionState>(
                        SessionState.NotStarted,
                        ::evolveSession,
                    )
                sessionDataOf(session).week shouldBe w(1)
            }
        }

        context("[US1.2/AC1.2.3] 役割が足りない開始は拒否し、不足している役割を示す") {
            test("一次卸だけがいない（小売店、二次卸、工場）Then StartConditionNotMet(一次卸)") {
                val game = gameWith(1 to Role.FACTORY, 3 to Role.WHOLESALER, 4 to Role.RETAILER)
                startGame(game, SessionState.NotStarted, startGameCommand()) shouldBe
                    GameError.StartConditionNotMet(listOf(Role.DISTRIBUTOR)).left()
            }
            test("複数の役割が不足なら、上流から下流の順にすべて示す") {
                val game = gameWith(3 to Role.WHOLESALER, 4 to Role.RETAILER)
                startGame(game, SessionState.NotStarted, startGameCommand()) shouldBe
                    GameError.StartConditionNotMet(listOf(Role.FACTORY, Role.DISTRIBUTOR)).left()
            }
            test("参加しただけで役割のない人は、数えない（4 役割すべてが不足）") {
                val game = gameOf(gameCreated(settings), participantJoined(1), participantJoined(2))
                startGame(game, SessionState.NotStarted, startGameCommand()) shouldBe
                    GameError.StartConditionNotMet(Role.entries).left()
            }
        }

        context("startGame の権限と状態（Forbidden → AlreadyStarted → 開始条件の順）") {
            test("進行役以外（参加者・匿名）が開始 Then Forbidden（役割が不足していても、先に権限を拒否する）") {
                listOf(participantActor(1), anonymousActor).forEach { actor ->
                    val result =
                        startGame(gameWith(1 to Role.FACTORY), SessionState.NotStarted, startGameCommand(actor))
                    (result.leftOrNull() is GameError.Forbidden) shouldBe true
                }
            }
            test("Given 開始済みのゲーム When 開始 Then AlreadyStarted") {
                val game = gameOf(*(fullyAssignedEvents() + gameStarted()).toTypedArray())
                startGame(game, sessionOf(sessionStarted(settings)), startGameCommand()) shouldBe
                    SessionError.AlreadyStarted.left()
            }
            test("Given セッションが開始済み When 開始 Then AlreadyStarted（2 回目の開始は失敗する）") {
                startGame(fullyAssignedGame(), sessionOf(sessionStarted(settings)), startGameCommand()) shouldBe
                    SessionError.AlreadyStarted.left()
            }
            test("Given 未作成のゲーム When 開始 Then NotPreparing") {
                startGame(GameState.NotCreated, SessionState.NotStarted, startGameCommand()) shouldBe
                    GameError.NotPreparing.left()
            }
        }

        context("startGame は純粋（同じ Given と When は、同じ Then）") {
            test("同じ入力は、同じ結果を返す") {
                startGame(fullyAssignedGame(), SessionState.NotStarted, startGameCommand()) shouldBe
                    startGame(fullyAssignedGame(), SessionState.NotStarted, startGameCommand())
            }
        }
    })
