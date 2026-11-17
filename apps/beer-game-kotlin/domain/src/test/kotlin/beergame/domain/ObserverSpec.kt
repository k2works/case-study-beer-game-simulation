package beergame.domain

import arrow.core.left
import arrow.core.right
import io.kotest.core.spec.style.FunSpec
import io.kotest.matchers.shouldBe
import java.time.Instant
import java.util.UUID

/*
 * Game の観察者（US1.3 / AC1.3.1〜1.3.4。US4.1 / AC4.1.5）。観察用の招待の発行・失効と、観察者の参加。
 * 招待は準備中と開始後の両方で受け付ける。不明・失効・期限切れの招待は、区別しない同じ InvitationInvalid（列挙の防止）。
 */

private val joined: GameState = gameOf(gameCreated(), participantJoined(1))
private val started: GameState = gameOf(*(fullyAssignedEvents() + gameStarted()).toTypedArray())
private val phases: List<Pair<String, GameState>> = listOf("準備中" to joined, "開始後" to started)

private fun GameState.after(vararg events: GameEvent): GameState = events.fold(this, ::evolveGame)

private val otherGameFacilitator: Actor = Actor.Facilitator(GameId(UUID(9L, 9L)))
private val forbidden = GameError.Forbidden("観察用の招待の発行と失効は進行役だけができる")
private val facilitatorOnly = SessionError.Forbidden("確定は進行役だけができる")

class ObserverSpec :
    FunSpec({
        context("[US1.3/AC1.3.1] InviteObserver（進行役が、観察用の招待を発行する）") {
            phases.forEach { (phase, state) ->
                test("Given $phase When 進行役が招待を求める Then ObserverInvited を 1 件返す") {
                    decideGame(state, inviteObserver(1)) shouldBe listOf(observerInvited(1)).right()
                }
                test("[AC1.3.2] Given $phase When 進行役以外（参加者・観察者・匿名・別のゲームの進行役）が求める Then Forbidden") {
                    val outsiders = listOf(participantActor(1), observerActor(1), anonymousActor, otherGameFacilitator)
                    outsiders.forEach { actor ->
                        decideGame(state, inviteObserver(1, actor)) shouldBe forbidden.left()
                    }
                }
            }
            test("Given 未作成 When 招待を求める Then Forbidden（進行役になれる人がいない）") {
                decideGame(GameState.NotCreated, inviteObserver(1)) shouldBe forbidden.left()
            }
            test("Given 招待済み When 招待を足す Then 招待は 2 件、それぞれの有効期限を持つ") {
                val state = started.after(observerInvited(1), observerInvited(2, invitationExpiry.plusSeconds(60)))
                gameDataOf(state).invitations shouldBe
                    mapOf(
                        iid(1) to InvitationEntry(invitationExpiry, false),
                        iid(2) to InvitationEntry(invitationExpiry.plusSeconds(60), false),
                    )
            }
        }

        context("[US1.3/AC1.3.4] RevokeObserverInvitation（進行役が、招待を失効させる）") {
            phases.forEach { (phase, state) ->
                val invited = state.after(observerInvited(1))
                test("Given $phase の招待 When 進行役が失効 Then ObserverInvitationRevoked") {
                    decideGame(invited, revokeInvitation(1)) shouldBe listOf(observerInvitationRevoked(1)).right()
                }
                test("Given $phase で失効済み When もう一度失効 Then CredentialAlreadyRevoked") {
                    val revoked = invited.after(observerInvitationRevoked(1))
                    decideGame(revoked, revokeInvitation(1)) shouldBe GameError.CredentialAlreadyRevoked.left()
                }
                test("Given $phase When 知らない招待を失効 Then InvitationNotFound") {
                    decideGame(invited, revokeInvitation(9)) shouldBe GameError.InvitationNotFound.left()
                }
                test("Given $phase When 進行役以外が失効 Then Forbidden") {
                    listOf(participantActor(1), observerActor(1), anonymousActor).forEach { actor ->
                        decideGame(invited, revokeInvitation(1, actor)) shouldBe forbidden.left()
                    }
                }
            }
            test("Given 期限切れで未失効の招待 When 失効 Then ObserverInvitationRevoked（期限切れでも失効できる）") {
                val expired = started.after(observerInvited(1, t0.minusSeconds(1)))
                decideGame(expired, revokeInvitation(1)) shouldBe listOf(observerInvitationRevoked(1)).right()
            }
        }

        context("[US1.3/AC1.3.3] JoinAsObserver（招待で、観察者として参加する）") {
            phases.forEach { (phase, state) ->
                val invited = state.after(observerInvited(1))
                test("Given $phase の有効な招待 When 参加 Then ObserverJoined（役割は持たない）") {
                    decideGame(invited, joinAsObserver(1, 1)) shouldBe listOf(observerJoined(1, 1)).right()
                }
            }
            test("Given 有効な招待 When 期限の 1 秒前に参加 Then ObserverJoined") {
                val state = started.after(observerInvited(1))
                decideGame(state, joinAsObserver(1, 1, invitationExpiry.minusSeconds(1))) shouldBe
                    listOf(observerJoined(1, 1)).right()
            }
            test("[AC1.3.4] 失効・期限（期限の瞬間から）・不明な招待・未作成は、区別しない同じ InvitationInvalid") {
                val invited = started.after(observerInvited(1))
                val revoked = invited.after(observerInvitationRevoked(1))
                listOf(
                    decideGame(revoked, joinAsObserver(1, 1)),
                    decideGame(invited, joinAsObserver(1, 1, invitationExpiry)),
                    decideGame(invited, joinAsObserver(1, 9)),
                    decideGame(GameState.NotCreated, joinAsObserver(1, 1)),
                ).forEach { it shouldBe GameError.InvitationInvalid.left() }
            }
            test("招待を失効させても、すでに参加した観察者は残る") {
                val state = started.after(observerInvited(1), observerJoined(1, 1), observerInvitationRevoked(1))
                gameDataOf(state).observers shouldBe mapOf(oid(1) to iid(1))
            }
        }

        context("観察者は、役割を持たず、状態を変更できない（AC1.3.3・AC4.1.5）") {
            val withObserver = started.after(observerInvited(1), observerJoined(1, 1))
            val data = gameDataOf(withObserver)
            test("参加した観察者は、観察者の資格を持ち、参加者の一覧と役割の割り当てには現れない") {
                data.credentials[CredentialSubject.Observer(oid(1))] shouldBe
                    CredentialValidity(credentialExpiry, false)
                data.participants.size shouldBe 4
                data.roleAssignments()[Role.RETAILER] shouldBe setOf(pid(4))
            }
            test("観察者の資格は、失効・再発行の対象ではない（Forbidden）") {
                val subject = CredentialSubject.Observer(oid(1))
                listOf(
                    decideGame(withObserver, revokeCredential(subject)),
                    decideGame(withObserver, reissueCredential(subject)),
                ).forEach { it shouldBe GameError.Forbidden("進行役自身の資格は失効・再発行の対象外").left() }
            }
            test("観察者は、入力の保存・確定・停止・代理入力ができない") {
                val session = sessionOf(sessionStarted(gameSettings(listOf(4, 8, 4))))
                val observer = observerActor(1)
                decideSession(session, saveDecision(Role.RETAILER, 4, actor = observer)) shouldBe
                    SessionError.Forbidden("その役割の参加者だけが入力できる").left()
                decideSession(session, commitWeek(actor = observer)) shouldBe facilitatorOnly.left()
                decideSession(session, pauseSession(observer)).isLeft() shouldBe true
                decideSession(session, submitProxy(Role.RETAILER, 4, actor = observer)).isLeft() shouldBe true
            }
            test("観察者の復帰は、受け付けない（復帰できるのは、進行役と参加者の復帰資格の持ち主）") {
                decideGame(withObserver, recoverParticipation(CredentialSubject.Observer(oid(1)))) shouldBe
                    GameError.Forbidden("復帰できない").left()
                // 観察者が、参加者の復帰資格で復帰しようとしても、別の主体として拒否される
                decideGame(withObserver, recoverParticipation(participantSubject(1), actor = observerActor(1))) shouldBe
                    GameError.Forbidden("復帰できない").left()
            }
        }

        context("evolve は、decide が作らない列を、状態を変えずに返す（版は増えない）") {
            val base = started.after(observerInvited(1), observerJoined(1, 1))
            test("同じ招待の再発行・知らない招待の失効・参加済みの観察者の再参加・知らない招待での参加") {
                listOf<GameEvent>(
                    observerInvited(1),
                    observerInvitationRevoked(9),
                    observerJoined(1, 1),
                    observerJoined(2, 9),
                ).forEach { event -> evolveGame(base, event).version shouldBe base.version }
            }
            test("失効済みの招待の再失効は、状態を変えない") {
                val revoked = base.after(observerInvitationRevoked(1))
                evolveGame(revoked, observerInvitationRevoked(1)).version shouldBe revoked.version
            }
            test("未作成のストリームへの観察者のイベントは、状態を変えない") {
                evolveGame(GameState.NotCreated, observerInvited(1)) shouldBe GameState.NotCreated
            }
            test("InvitationEntry は、失効または期限で使えない（期限の瞬間から）") {
                val entry = InvitationEntry(invitationExpiry, false)
                entry.isUsable(invitationExpiry.minusNanos(1)) shouldBe true
                entry.isUsable(invitationExpiry) shouldBe false
                entry.copy(revoked = true).isUsable(Instant.EPOCH) shouldBe false
            }
        }
    })
