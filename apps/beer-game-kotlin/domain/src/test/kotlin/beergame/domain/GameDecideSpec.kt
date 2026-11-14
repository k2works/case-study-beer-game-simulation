package beergame.domain

import arrow.core.left
import arrow.core.right
import io.kotest.core.spec.style.FunSpec
import io.kotest.matchers.shouldBe
import java.util.UUID

private val preparing: GameState = gameOf(gameCreated())
private val started: GameState = gameOf(*(fullyAssignedEvents() + gameStarted()).toTypedArray())

class GameDecideSpec :
    FunSpec({
        context("[US1.1/AC1.1.1] CreateGame（キット準拠。参加コード付きの準備中のゲームが一度だけ作られる）") {
            test("Given なし When 匿名がゲームを作成 Then GameCreated を 1 件返す") {
                decideGame(GameState.NotCreated, createGame()) shouldBe listOf(gameCreated()).right()
            }
            test("Given 作成済み When 再び作成 Then AlreadyCreated（一回性）") {
                decideGame(preparing, createGame()) shouldBe GameError.AlreadyCreated.left()
            }
            test("Given 開始済み When 作成 Then AlreadyCreated") {
                decideGame(started, createGame()) shouldBe GameError.AlreadyCreated.left()
            }
            test("Given なし When 進行役・参加者が作成 Then Forbidden（作成は匿名の操作者だけ）") {
                listOf(facilitatorActor, participantActor(1)).forEach { actor ->
                    decideGame(GameState.NotCreated, createGame(actor)).leftOrNull().shouldBeForbidden()
                }
            }
        }

        context("[US1.2/AC1.2.1] JoinGame（準備中の間だけ参加できる）") {
            test("Given 準備中 When 参加 Then ParticipantJoined（ID と資格の期限だけ。表示名は含めない）") {
                decideGame(preparing, joinGame(1)) shouldBe listOf(participantJoined(1)).right()
            }
            test("[US1.2/AC1.2.2] Given 開始済み When 参加 Then NotPreparing（受付が終了している）") {
                decideGame(started, joinGame(5)) shouldBe GameError.NotPreparing.left()
            }
            test("Given 未作成 When 参加 Then NotPreparing") {
                decideGame(GameState.NotCreated, joinGame(1)) shouldBe GameError.NotPreparing.left()
            }
        }

        context("[US1.2/AC1.2.5] AssignRole（1 人は同時に 2 つの役割を持たない。D9: 付け替えは 2 イベント）") {
            val joined = gameOf(gameCreated(), participantJoined(1), participantJoined(2))

            test("Given 役割なしの参加者 When 割り当て Then RoleAssigned") {
                decideGame(joined, assignRole(1, Role.RETAILER)) shouldBe
                    listOf(roleAssigned(1, Role.RETAILER)).right()
            }
            test("Given 小売店にいる参加者 When 二次卸に割り当て Then RoleUnassigned(小売店) の後に RoleAssigned(二次卸)") {
                val onRetailer = gameOf(gameCreated(), participantJoined(1), roleAssigned(1, Role.RETAILER))
                decideGame(onRetailer, assignRole(1, Role.WHOLESALER)) shouldBe
                    listOf(roleUnassigned(1, Role.RETAILER), roleAssigned(1, Role.WHOLESALER)).right()
            }
            test("Given 小売店にいる参加者 When 同じ小売店に割り当て Then イベントなし（履歴に足さない）") {
                val onRetailer = gameOf(gameCreated(), participantJoined(1), roleAssigned(1, Role.RETAILER))
                decideGame(onRetailer, assignRole(1, Role.RETAILER)) shouldBe emptyList<GameEvent>().right()
            }
            test("[設計 D9・AC1.2.4] 同じ役割に別の参加者を割り当てても拒否しない（共同担当の扱いは B6 で決める。未決）") {
                val onRetailer =
                    gameOf(gameCreated(), participantJoined(1), participantJoined(2), roleAssigned(1, Role.RETAILER))
                decideGame(onRetailer, assignRole(2, Role.RETAILER)) shouldBe
                    listOf(roleAssigned(2, Role.RETAILER)).right()
            }
            test("When 進行役以外（参加者・匿名）が割り当て Then Forbidden") {
                listOf(participantActor(1), anonymousActor, Actor.Facilitator(GameId(UUID(9L, 9L)))).forEach { actor ->
                    decideGame(joined, assignRole(1, Role.RETAILER, actor)).leftOrNull().shouldBeForbidden()
                }
            }
            test("Given 未知の参加者 When 割り当て Then ParticipantNotFound") {
                decideGame(joined, assignRole(9, Role.RETAILER)) shouldBe GameError.ParticipantNotFound(pid(9)).left()
            }
            test("Given 開始済み When 割り当て Then NotPreparing（開始後は割り当てを固定）") {
                decideGame(started, assignRole(1, Role.RETAILER)) shouldBe GameError.NotPreparing.left()
            }
            test("Given 未作成 When 割り当て Then NotPreparing") {
                decideGame(GameState.NotCreated, assignRole(1, Role.RETAILER)) shouldBe GameError.NotPreparing.left()
            }
        }

        context("decideGame は純粋（同じ Given と When は、何度でも同じ Then）") {
            test("同じ状態とコマンドは、同じ結果を返す") {
                val state = gameOf(gameCreated(), participantJoined(1))
                decideGame(state, assignRole(1, Role.FACTORY)) shouldBe decideGame(state, assignRole(1, Role.FACTORY))
            }
        }
    })

private fun GameError?.shouldBeForbidden() {
    (this is GameError.Forbidden) shouldBe true
}
