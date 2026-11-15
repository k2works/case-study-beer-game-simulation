package beergame.domain

import arrow.core.left
import arrow.core.right
import io.kotest.core.spec.style.FunSpec
import io.kotest.matchers.shouldBe
import java.time.Instant
import java.util.UUID

/*
 * Game の資格（US3.2 / AC3.2.1・AC3.2.2・AC3.2.5）。失効・再発行・復帰。準備中と開始後の両方で受け付ける。
 * 進行役自身の資格は失効・再発行の対象外（ゲート 1 の決定）。復帰の失敗は、失効・期限切れ・不明で同じ形（NF-S12）。
 */

private val joined: GameState = gameOf(gameCreated(), participantJoined(1), participantJoined(2))
private val started: GameState = gameOf(*(fullyAssignedEvents() + gameStarted()).toTypedArray())

/** 準備中と開始後の両方（ドメインモデル: 資格のコマンドは両方で受け付ける）。 */
private val phases: List<Pair<String, GameState>> = listOf("準備中" to joined, "開始後" to started)

private fun GameState.after(vararg events: GameEvent): GameState = events.fold(this, ::evolveGame)

/** 参加者 1 の資格の再発行（新しい期限）。 */
private val reissued1: GameEvent = credentialReissued(participantSubject(1))

private val otherGameFacilitator: Actor = Actor.Facilitator(GameId(UUID(9L, 9L)))

/** 復帰の失敗は、理由を区別しない同じ値で返る（存在・期限・失効を漏らさない）。 */
private val recoveryRefused: GameError = GameError.Forbidden("復帰できない")

class GameCredentialSpec :
    FunSpec({
        context("[US3.2/AC3.2.5] RevokeCredential（進行役が、参加者の資格を失効させる）") {
            phases.forEach { (phase, state) ->
                test("Given $phase When 進行役が参加者 1 の資格を失効 Then CredentialRevoked を 1 件返す") {
                    decideGame(state, revokeCredential(participantSubject(1))) shouldBe
                        listOf(credentialRevoked(participantSubject(1))).right()
                }
                test("Given $phase で失効済み When もう一度失効 Then CredentialAlreadyRevoked") {
                    val revoked = state.after(credentialRevoked(participantSubject(1)))
                    decideGame(revoked, revokeCredential(participantSubject(1))) shouldBe
                        GameError.CredentialAlreadyRevoked.left()
                }
                test("Given $phase When 進行役以外（参加者・匿名・別のゲームの進行役）が失効 Then Forbidden") {
                    listOf(participantActor(2), anonymousActor, otherGameFacilitator).forEach { actor ->
                        decideGame(state, revokeCredential(participantSubject(1), actor)).leftOrNull() shouldBe
                            GameError.Forbidden("失効と再発行は進行役だけができる")
                    }
                }
                test("Given $phase When 進行役自身の資格を失効 Then Forbidden（対象外。自分の資格を失うと戻れない）") {
                    decideGame(state, revokeCredential(facilitatorSubject)) shouldBe
                        GameError.Forbidden("進行役自身の資格は失効・再発行の対象外").left()
                }
                test("Given $phase When 未知の参加者の資格を失効 Then ParticipantNotFound") {
                    decideGame(state, revokeCredential(participantSubject(9))) shouldBe
                        GameError.ParticipantNotFound(pid(9)).left()
                }
            }
            test("Given 期限切れで未失効の資格 When 失効 Then CredentialRevoked（失効してから再発行できる）") {
                val expired = revokeCredential(participantSubject(1)).copy(at = credentialExpiry)
                decideGame(joined, expired) shouldBe listOf(credentialRevoked(participantSubject(1))).right()
            }
            test("Given 未作成 When 失効 Then Forbidden（進行役になれる人がいない）") {
                decideGame(GameState.NotCreated, revokeCredential(participantSubject(1))).leftOrNull() shouldBe
                    GameError.Forbidden("失効と再発行は進行役だけができる")
            }
        }

        context("[US3.2/AC3.2.5] ReissueCredential（失効した資格を、新しい有効期限で再発行する）") {
            phases.forEach { (phase, state) ->
                test("Given $phase で失効済み When 再発行 Then CredentialReissued（新しい有効期限つき）") {
                    val revoked = state.after(credentialRevoked(participantSubject(1)))
                    decideGame(revoked, reissueCredential(participantSubject(1))) shouldBe
                        listOf(credentialReissued(participantSubject(1))).right()
                }
                test("Given $phase で有効な資格 When 再発行 Then CredentialNotRevoked（有効な資格は置き換えない）") {
                    decideGame(state, reissueCredential(participantSubject(1))) shouldBe
                        GameError.CredentialNotRevoked.left()
                }
                test("Given $phase で期限切れの未失効の資格 When 再発行 Then CredentialNotRevoked（先に失効させる）") {
                    val atExpiry = reissueCredential(participantSubject(1)).copy(at = credentialExpiry)
                    decideGame(state, atExpiry) shouldBe GameError.CredentialNotRevoked.left()
                }
                test("Given $phase で失効済み When 進行役以外が再発行 Then Forbidden") {
                    val revoked = state.after(credentialRevoked(participantSubject(1)))
                    listOf(participantActor(1), anonymousActor, otherGameFacilitator).forEach { actor ->
                        decideGame(revoked, reissueCredential(participantSubject(1), actor)).leftOrNull() shouldBe
                            GameError.Forbidden("失効と再発行は進行役だけができる")
                    }
                }
                test("Given $phase When 進行役自身の資格を再発行 Then Forbidden（対象外）") {
                    decideGame(state, reissueCredential(facilitatorSubject)) shouldBe
                        GameError.Forbidden("進行役自身の資格は失効・再発行の対象外").left()
                }
                test("Given $phase When 未知の参加者の資格を再発行 Then ParticipantNotFound") {
                    decideGame(state, reissueCredential(participantSubject(9))) shouldBe
                        GameError.ParticipantNotFound(pid(9)).left()
                }
            }
            test("Given 未作成 When 再発行 Then Forbidden") {
                decideGame(GameState.NotCreated, reissueCredential(participantSubject(1))).leftOrNull() shouldBe
                    GameError.Forbidden("失効と再発行は進行役だけができる")
            }
            test("Given 再発行済み When もう一度失効 Then CredentialRevoked（失効と再発行は繰り返せる）") {
                val reissued = joined.after(credentialRevoked(participantSubject(1)), reissued1)
                decideGame(reissued, revokeCredential(participantSubject(1))) shouldBe
                    listOf(credentialRevoked(participantSubject(1))).right()
            }
        }

        context("[US3.2/AC3.2.1,AC3.2.4] RecoverParticipation（有効な復帰資格だけが、同じ主体として復帰できる）") {
            phases.forEach { (phase, state) ->
                test("Given $phase When 有効な復帰資格の参加者が復帰 Then ParticipationRecovered（新しい期限へ更新）") {
                    decideGame(state, recoverParticipation(participantSubject(1))) shouldBe
                        listOf(participationRecovered(participantSubject(1))).right()
                }
                test("Given $phase When 進行役が復帰 Then ParticipationRecovered（進行役の復帰先は進行のコンソール）") {
                    decideGame(state, recoverParticipation(facilitatorSubject)) shouldBe
                        listOf(participationRecovered(facilitatorSubject)).right()
                }
                test("Given $phase で失効した資格 When 復帰 Then Forbidden（存在しない資格と同じ形）") {
                    val revoked = state.after(credentialRevoked(participantSubject(1)))
                    decideGame(revoked, recoverParticipation(participantSubject(1))) shouldBe recoveryRefused.left()
                }
                test("Given $phase で期限切れの資格 When 復帰 Then Forbidden（期限の瞬間から使えない）") {
                    decideGame(state, recoverParticipation(participantSubject(1), at = credentialExpiry)) shouldBe
                        recoveryRefused.left()
                    val later = recoverParticipation(participantSubject(1), at = credentialExpiry.plusSeconds(1))
                    decideGame(state, later) shouldBe recoveryRefused.left()
                }
                test("Given $phase When 期限の 1 秒前に復帰 Then ParticipationRecovered") {
                    val before = credentialExpiry.minusSeconds(1)
                    decideGame(state, recoverParticipation(participantSubject(1), at = before)) shouldBe
                        listOf(participationRecovered(participantSubject(1))).right()
                }
                test("Given $phase When 未知の参加者・別のゲームの進行役が復帰 Then Forbidden（不明と失効・期限切れが同じ形）") {
                    val otherGame = CredentialSubject.Facilitator(GameId(UUID(9L, 9L)))
                    listOf(participantSubject(9), otherGame).forEach { subject ->
                        decideGame(state, recoverParticipation(subject)) shouldBe recoveryRefused.left()
                    }
                }
                test("Given $phase When 別の主体の操作者（他の参加者・匿名）が復帰 Then Forbidden") {
                    listOf(participantActor(2), anonymousActor, facilitatorActor).forEach { actor ->
                        decideGame(state, recoverParticipation(participantSubject(1), actor)) shouldBe
                            recoveryRefused.left()
                    }
                    decideGame(state, recoverParticipation(facilitatorSubject, participantActor(1))) shouldBe
                        recoveryRefused.left()
                }
            }
            test("Given 未作成 When 復帰 Then Forbidden（不明な資格と同じ形）") {
                decideGame(GameState.NotCreated, recoverParticipation(participantSubject(1))) shouldBe
                    recoveryRefused.left()
            }
            test("Given 失効後に再発行した資格 When 復帰 Then ParticipationRecovered（新しい期限の間だけ有効）") {
                val reissued = joined.after(credentialRevoked(participantSubject(1)), reissued1)
                decideGame(reissued, recoverParticipation(participantSubject(1))) shouldBe
                    listOf(participationRecovered(participantSubject(1))).right()
                // 旧い期限の後でも、再発行の新しい期限の前なら使える
                val afterOldExpiry = credentialExpiry.plusSeconds(1)
                decideGame(reissued, recoverParticipation(participantSubject(1), at = afterOldExpiry)) shouldBe
                    listOf(participationRecovered(participantSubject(1))).right()
                decideGame(reissued, recoverParticipation(participantSubject(1), at = renewedExpiry)) shouldBe
                    recoveryRefused.left()
            }
            test("Given 復帰で更新した期限 When 旧い期限の後に復帰 Then ParticipationRecovered（復帰のたびに期限が延びる）") {
                val recovered = joined.after(participationRecovered(participantSubject(1)))
                val afterOldExpiry: Instant = credentialExpiry.plusSeconds(1)
                decideGame(recovered, recoverParticipation(participantSubject(1), at = afterOldExpiry)) shouldBe
                    listOf(participationRecovered(participantSubject(1))).right()
            }
        }

        context("資格のコマンドと、decide・evolve の整合") {
            test("失効 → 再発行 → 復帰の列は、decide が作り、再生で InvalidTransition を 1 件も出さない") {
                val events =
                    fullyAssignedEvents() +
                        gameStarted() +
                        credentialRevoked(participantSubject(1)) +
                        credentialReissued(participantSubject(1)) +
                        participationRecovered(participantSubject(1)) +
                        participationRecovered(facilitatorSubject)
                replayGame(events).invalid shouldBe emptyList()
            }
            test("decideGame は純粋（同じ Given と When は、何度でも同じ Then）") {
                val revoked = joined.after(credentialRevoked(participantSubject(1)))
                decideGame(revoked, reissueCredential(participantSubject(1))) shouldBe
                    decideGame(revoked, reissueCredential(participantSubject(1)))
            }
        }
    })
