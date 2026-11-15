package beergame.domain

import io.kotest.core.spec.style.FunSpec
import io.kotest.matchers.shouldBe

private val settings = gameSettings()

/** 作成の直後: 進行役の資格だけが有効（参加者はいない）。 */
private val emptyData =
    GameData(gid, settings, emptyMap(), mapOf(facilitatorSubject to CredentialValidity(facilitatorExpiry, false)))

private val participantCredential = CredentialValidity(credentialExpiry, false)

/** 再発行・復帰で、新しい期限になった資格。 */
private val renewedCredential = CredentialValidity(renewedExpiry, false)

private val allGameEvents: List<GameEvent> =
    listOf(
        gameCreated(),
        participantJoined(1),
        roleAssigned(1, Role.FACTORY),
        roleUnassigned(1, Role.FACTORY),
        gameStarted(),
        credentialRevoked(participantSubject(1)),
        credentialReissued(participantSubject(1)),
        participationRecovered(participantSubject(1)),
    )

private val allGameStates: List<GameState> =
    listOf(
        GameState.NotCreated,
        gameOf(gameCreated(), participantJoined(1)),
        gameOf(gameCreated(), participantJoined(1), gameStarted()),
        gameOf(gameCreated(), participantJoined(1), credentialRevoked(participantSubject(1))),
    )

class GameEvolveSpec :
    FunSpec({
        context("evolveGame は、イベントを状態へ畳み込む（計算はせず、事実を採用するだけ）") {
            test("GameCreated は準備中の状態（版 1、参加者なし）にする") {
                evolveGame(GameState.NotCreated, gameCreated()) shouldBe GameState.Preparing(emptyData, sv(1))
            }
            test("ParticipantJoined は、役割なしの参加者と、有効な資格を加える（表示名は状態に無い）") {
                val state = gameOf(gameCreated(), participantJoined(1))
                val expected =
                    emptyData.copy(
                        participants = mapOf(pid(1) to ParticipantEntry(null)),
                        credentials = emptyData.credentials + (participantSubject(1) to participantCredential),
                    )
                state shouldBe GameState.Preparing(expected, sv(2))
            }
            test("GameCreated は、進行役の資格（作成時の期限、未失効）を持たせる") {
                gameDataOf(gameOf(gameCreated())).credentials shouldBe
                    mapOf(facilitatorSubject to CredentialValidity(facilitatorExpiry, false))
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
            test("開始済みへの ParticipantJoined・RoleUnassigned・GameStarted・GameCreated は、状態を変えない") {
                val state = gameOf(gameCreated(), participantJoined(1), gameStarted())
                val events =
                    listOf(participantJoined(2), roleUnassigned(1, Role.FACTORY), gameStarted(), gameCreated())
                events.forEach { event -> evolveGame(state, event) shouldBe state }
            }
            test("[B5/H4] 開始済みへの RoleAssigned は、役割のない参加者に役割を付ける（入れ替えの新担当者。版が進む）") {
                val state = gameOf(gameCreated(), participantJoined(1), gameStarted())
                val next = evolveGame(state, roleAssigned(1, Role.FACTORY))
                (next is GameState.Started) shouldBe true
                gameDataOf(next).participants[pid(1)] shouldBe ParticipantEntry(Role.FACTORY)
                gameDataOf(next).credentials shouldBe gameDataOf(state).credentials
                next.version shouldBe state.version.next()
            }
            test("[B5/H4] ParticipantReplaced は、開始済みで旧担当者の役割を外す（参加者の行と資格は残す）") {
                val state = gameOf(*(fullyAssignedEvents() + gameStarted()).toTypedArray())
                val next = evolveGame(state, participantReplaced(4, Role.RETAILER, replacedBy = 5))
                val data = gameDataOf(next)
                data.participants[pid(4)] shouldBe ParticipantEntry(null)
                data.credentials shouldBe gameDataOf(state).credentials
                data.participants.filterKeys { it != pid(4) } shouldBe
                    gameDataOf(state).participants.filterKeys { it != pid(4) }
                next.version shouldBe state.version.next()
            }
            test("[B5/H4] ParticipantReplaced は、未知の参加者・準備中・未作成では、状態を変えない") {
                val started = gameOf(gameCreated(), participantJoined(1), gameStarted())
                val preparing = fullyAssignedGame()
                val event = participantReplaced(4, Role.RETAILER, replacedBy = 5)
                evolveGame(started, participantReplaced(9, Role.RETAILER, replacedBy = 1)) shouldBe started
                evolveGame(preparing, event) shouldBe preparing
                evolveGame(GameState.NotCreated, event) shouldBe GameState.NotCreated
            }
            test("同じ参加者の ParticipantJoined が再び来ても、既存の割り当てと資格を消さない") {
                val state = gameOf(gameCreated(), participantJoined(1), roleAssigned(1, Role.FACTORY))
                evolveGame(state, participantJoined(1)) shouldBe state
            }
        }

        context("資格のイベントは、準備中と開始後の両方で、資格の有効性だけを変える") {
            val joined = gameOf(gameCreated(), participantJoined(1), participantJoined(2))
            val startedGame = gameOf(gameCreated(), participantJoined(1), participantJoined(2), gameStarted())

            listOf("準備中" to joined, "開始後" to startedGame).forEach { (phase, state) ->
                test("$phase: CredentialRevoked は対象の資格だけを失効にし、版を 1 つ進める") {
                    val next = evolveGame(state, credentialRevoked(participantSubject(1)))
                    val credentials = gameDataOf(next).credentials
                    credentials[participantSubject(1)] shouldBe CredentialValidity(credentialExpiry, true)
                    credentials[participantSubject(2)] shouldBe participantCredential
                    credentials[facilitatorSubject] shouldBe CredentialValidity(facilitatorExpiry, false)
                    next.version shouldBe state.version.next()
                    gameDataOf(next).participants shouldBe gameDataOf(state).participants
                }
                test("$phase: CredentialReissued は、失効を解いて新しい期限にする") {
                    val revoked = evolveGame(state, credentialRevoked(participantSubject(1)))
                    val next = evolveGame(revoked, credentialReissued(participantSubject(1)))
                    gameDataOf(next).credentials[participantSubject(1)] shouldBe renewedCredential
                    next.version shouldBe revoked.version.next()
                }
                test("$phase: ParticipationRecovered は、期限だけを新しくする") {
                    val next = evolveGame(state, participationRecovered(participantSubject(1)))
                    gameDataOf(next).credentials[participantSubject(1)] shouldBe renewedCredential
                    next.version shouldBe state.version.next()
                }
                test("$phase: decide が作らない資格の列は、状態を変えない（未知の主体、失効済みの再失効、有効な資格の再発行、失効後の復帰）") {
                    val revoked = evolveGame(state, credentialRevoked(participantSubject(1)))
                    evolveGame(state, credentialRevoked(participantSubject(9))) shouldBe state
                    evolveGame(revoked, credentialRevoked(participantSubject(1))) shouldBe revoked
                    evolveGame(state, credentialReissued(participantSubject(1))) shouldBe state
                    evolveGame(state, credentialReissued(participantSubject(9))) shouldBe state
                    evolveGame(revoked, participationRecovered(participantSubject(1))) shouldBe revoked
                    evolveGame(state, participationRecovered(participantSubject(9))) shouldBe state
                }
            }
            test("未作成への資格のイベントは、状態を変えない") {
                listOf(
                    credentialRevoked(participantSubject(1)),
                    credentialReissued(participantSubject(1)),
                    participationRecovered(participantSubject(1)),
                ).forEach { event -> evolveGame(GameState.NotCreated, event) shouldBe GameState.NotCreated }
            }
        }

        context("資格の有効性（CredentialValidity.status）は、時刻に対する純粋関数") {
            val validity = CredentialValidity(credentialExpiry, false)

            test("期限より前は VALID、期限の瞬間から EXPIRED") {
                validity.status(credentialExpiry.minusSeconds(1)) shouldBe CredentialStatus.VALID
                validity.status(credentialExpiry) shouldBe CredentialStatus.EXPIRED
                validity.status(credentialExpiry.plusSeconds(1)) shouldBe CredentialStatus.EXPIRED
            }
            test("失効は期限より優先する（失効済みは、期限の前でも後でも REVOKED）") {
                val revoked = CredentialValidity(credentialExpiry, true)
                revoked.status(credentialExpiry.minusSeconds(1)) shouldBe CredentialStatus.REVOKED
                revoked.status(credentialExpiry.plusSeconds(1)) shouldBe CredentialStatus.REVOKED
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
