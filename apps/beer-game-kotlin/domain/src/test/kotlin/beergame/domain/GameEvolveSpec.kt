package beergame.domain

import io.kotest.core.spec.style.FunSpec
import io.kotest.matchers.shouldBe

private val settings = gameSettings()
private val emptyData = GameData(gid, settings, emptyMap())

private val allGameEvents: List<GameEvent> =
    listOf(
        gameCreated(),
        participantJoined(1),
        roleAssigned(1, Role.FACTORY),
        roleUnassigned(1, Role.FACTORY),
        gameStarted(),
    )

private val allGameStates: List<GameState> =
    listOf(
        GameState.NotCreated,
        gameOf(gameCreated(), participantJoined(1)),
        gameOf(gameCreated(), participantJoined(1), gameStarted()),
    )

class GameEvolveSpec :
    FunSpec({
        context("evolveGame は、イベントを状態へ畳み込む（計算はせず、事実を採用するだけ）") {
            test("GameCreated は準備中の状態（版 1、参加者なし）にする") {
                evolveGame(GameState.NotCreated, gameCreated()) shouldBe GameState.Preparing(emptyData, sv(1))
            }
            test("ParticipantJoined は、役割なしの参加者を加える（表示名は状態に無い）") {
                val state = gameOf(gameCreated(), participantJoined(1))
                state shouldBe
                    GameState.Preparing(emptyData.copy(participants = mapOf(pid(1) to ParticipantEntry(null))), sv(2))
            }
            test("RoleAssigned は役割を付け、RoleUnassigned は外す") {
                val assigned = gameOf(gameCreated(), participantJoined(1), roleAssigned(1, Role.RETAILER))
                gameDataOf(assigned).participants[pid(1)] shouldBe ParticipantEntry(Role.RETAILER)
                val unassigned = evolveGame(assigned, roleUnassigned(1, Role.RETAILER))
                gameDataOf(unassigned).participants[pid(1)] shouldBe ParticipantEntry(null)
            }
            test("[US1.2/AC1.2.5] 付け替え（RoleUnassigned の後に RoleAssigned）の結果、役割は新しい 1 つだけになる") {
                val moved =
                    gameOf(
                        gameCreated(),
                        participantJoined(1),
                        roleAssigned(1, Role.RETAILER),
                        roleUnassigned(1, Role.RETAILER),
                        roleAssigned(1, Role.WHOLESALER),
                    )
                gameDataOf(moved).participants shouldBe mapOf(pid(1) to ParticipantEntry(Role.WHOLESALER))
            }
            test("GameStarted は開始済みにし、設定と参加者を固定する（データは変えない）") {
                val preparing = gameOf(gameCreated(), participantJoined(1))
                val state = evolveGame(preparing, gameStarted())
                state shouldBe GameState.Started(gameDataOf(preparing), sv(3))
            }
            test("すべてのイベントが、状態の版を 1 つ進める") {
                val events = fullyAssignedEvents() + gameStarted()
                events.indices.forEach { i ->
                    gameOf(*events.take(i + 1).toTypedArray()).version shouldBe sv((i + 1).toLong())
                }
            }
        }

        context("evolveGame は全域: decide が作らない列は、状態を変えずに返す（InvalidTransition）") {
            test("すべての状態 × すべてのイベントで、例外を投げず、版は変わらないか 1 だけ進む") {
                allGameStates.forEach { state ->
                    allGameEvents.forEach { event ->
                        val next = evolveGame(state, event)
                        (next.version == state.version || next.version == state.version.next()) shouldBe true
                    }
                }
            }
            test("未作成への ParticipantJoined・RoleAssigned・GameStarted は、状態を変えない") {
                listOf(participantJoined(1), roleAssigned(1, Role.FACTORY), gameStarted()).forEach { event ->
                    evolveGame(GameState.NotCreated, event) shouldBe GameState.NotCreated
                }
            }
            test("準備中への GameCreated は、状態を変えない") {
                val state = gameOf(gameCreated(), participantJoined(1))
                evolveGame(state, gameCreated()) shouldBe state
            }
            test("未知の参加者への RoleAssigned・RoleUnassigned は、状態を変えない") {
                val state = gameOf(gameCreated())
                evolveGame(state, roleAssigned(9, Role.FACTORY)) shouldBe state
                evolveGame(state, roleUnassigned(9, Role.FACTORY)) shouldBe state
            }
            test("開始済みへの ParticipantJoined・RoleAssigned・GameStarted・GameCreated は、状態を変えない") {
                val state = gameOf(gameCreated(), participantJoined(1), gameStarted())
                val events = listOf(participantJoined(2), roleAssigned(1, Role.FACTORY), gameStarted(), gameCreated())
                events.forEach { event -> evolveGame(state, event) shouldBe state }
            }
            test("同じ参加者の ParticipantJoined が再び来ても、既存の割り当てを消さない") {
                val state = gameOf(gameCreated(), participantJoined(1), roleAssigned(1, Role.FACTORY))
                evolveGame(state, participantJoined(1)) shouldBe state
            }
        }

        context("replayGame は、不正な遷移を InvalidTransition として検知する（evolve の前後で版が増えない）") {
            test("正しい列は、状態を再生し、検知は 0 件") {
                val events = fullyAssignedEvents() + gameStarted()
                val replayed = replayGame(events)
                replayed.state shouldBe gameOf(*events.toTypedArray())
                replayed.invalid shouldBe emptyList()
            }
            test("不正な列は、状態を変えず、状態名とイベント名を持つ InvalidTransition を記録する") {
                val replayed = replayGame(listOf(participantJoined(1), gameCreated(), gameCreated()))
                replayed.state shouldBe GameState.Preparing(emptyData, sv(1))
                replayed.invalid shouldBe
                    listOf(
                        InvalidTransition(StreamType.GAME, "NotCreated", "ParticipantJoined"),
                        InvalidTransition(StreamType.GAME, "Preparing", "GameCreated"),
                    )
            }
        }
    })
