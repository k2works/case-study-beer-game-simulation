package beergame.application

import arrow.core.Either
import beergame.domain.GameError
import beergame.domain.GameEvent
import beergame.domain.InvitationId
import beergame.domain.Role
import beergame.domain.StreamType
import beergame.domain.StreamVersion
import io.kotest.core.spec.style.FunSpec
import io.kotest.matchers.collections.shouldBeEmpty
import io.kotest.matchers.collections.shouldContain
import io.kotest.matchers.collections.shouldHaveSize
import io.kotest.matchers.shouldBe
import io.kotest.matchers.shouldNotBe
import io.kotest.matchers.string.shouldNotContain
import kotlinx.coroutines.runBlocking
import java.time.Duration

/*
 * 観察者（B9。US1.3・US4.1）。招待の発行・失効、観察者の参加、観察、観察者の権限。
 * 招待コードの値は、発行の応答だけが運び、イベントにも世界の行（ダイジェスト）にも、そのままは残らない。
 */

private val SOURCE = AttemptSource.of("203.0.113.7")

private fun World.invite(
    game: Prepared,
    key: String = "invite",
    credential: String? = game.facilitator,
): Either<AppFailure, CommandOutcome> = runBlocking { ports.inviteObserver(game.gameId, meta(key, credential)) }

private fun World.revokeInvitation(
    game: Prepared,
    invitation: InvitationId,
    credential: String? = game.facilitator,
    key: String = "revoke-${invitation.value}",
): Either<AppFailure, CommandOutcome> =
    runBlocking { ports.revokeObserverInvitation(game.gameId, invitation, meta(key, credential)) }

private fun World.joinObserver(
    code: String,
    key: String = "observe",
    source: AttemptSource? = null,
): Either<AppFailure, CommandOutcome> =
    runBlocking { ports.joinAsObserver(JoinObserverInput(code, "見学者"), meta(key, null, source)) }

private fun CommandOutcome.invitationCode(): String = checkNotNull(recovery).raw

private fun CommandOutcome.invitationId(): InvitationId = invitationIdOf(checkNotNull(recovery))

private fun World.observer(game: Prepared): String {
    val code = invite(game).ok().invitationCode()
    return checkNotNull(joinObserver(code).ok().issued).raw
}

private fun World.observation(
    game: Prepared,
    credential: String?,
): Either<AppFailure, Observation> = runBlocking { ports.observe(game.gameId, credential) }

private fun World.gameEvents(game: Prepared) = store.events(game.gameId, StreamType.GAME).map { it.payload }

private fun World.projected(
    game: Prepared,
    status: GameStatus = GameStatus.STARTED,
) {
    projectedGame =
        ProjectedGame(
            gameId = game.gameId,
            status = status,
            finalWeek = 3,
            joinCode = game.created.joinCode,
            participants = emptyList(),
            session = ProjectedSession(SessionStatus.ACTIVE, 2, 1),
            roleStates = emptyMap(),
            decisions = emptyMap(),
            results = emptyList(),
            versions = Versions(StreamVersion.of(5L).ok(), StreamVersion.of(8L).ok()),
            teamTotals = listOf(ProjectedTeamTotal(1, 16, 48, 0, 4)),
        )
}

class ObserverCommandsSpec :
    FunSpec({
        context("[US1.3/AC1.3.1] 観察用の招待の発行") {
            test("Given 開始後のゲーム When 進行役が招待を求める Then 招待コードが応答だけで返り、参加コードとは別の値") {
                val world = World()
                val game = world.started()

                val outcome = world.invite(game).ok()

                val invitation = checkNotNull(outcome.recovery)
                invitation.kind shouldBe CredentialKind.OBSERVER_INVITATION
                invitation.raw shouldNotBe game.created.joinCode
                invitation.expiresAt shouldBe world.clock.plus(Duration.ofDays(7))
                world.gameEvents(game).filterIsInstance<GameEvent.ObserverInvited>() shouldHaveSize 1
            }

            test("Given 発行した招待 When 保存した行とイベントを見る Then 招待コードの値は残らず、ダイジェストの行だけがある") {
                val world = World()
                val game = world.started()

                val outcome = world.invite(game).ok()

                val code = outcome.invitationCode()
                world.gameEvents(game).joinToString { it.toString() } shouldNotContain code
                val rows = world.store.credentials.filterValues { it.kind == CredentialKind.OBSERVER_INVITATION }
                rows.keys.none { it == code } shouldBe true
                rows.values.single().subjectId shouldBe outcome.invitationId().value
            }

            test("Given 同じ冪等キー When 招待を 2 回求める Then 同じ招待コードを返し、招待は 1 件だけ") {
                val world = World()
                val game = world.started()

                val first = world.invite(game, "same-key").ok()
                val second = world.invite(game, "same-key").ok()

                second.invitationCode() shouldBe first.invitationCode()
                world.gameEvents(game).filterIsInstance<GameEvent.ObserverInvited>() shouldHaveSize 1
            }

            test("[AC1.3.2] Given 参加者・匿名 When 招待を求める Then 拒否され、イベントも行も増えない") {
                val world = World()
                val game = world.started()

                world.invite(game, "by-player", game.seats[Role.RETAILER].credential).domainCode() shouldBe
                    "game.forbidden"
                world.invite(game, "by-nobody", null).err() shouldBe AppFailure.Unauthorized
                world.gameEvents(game).filterIsInstance<GameEvent.ObserverInvited>().shouldBeEmpty()
                world.store.credentials.values
                    .none { it.kind == CredentialKind.OBSERVER_INVITATION } shouldBe true
            }
        }

        context("[US1.3/AC1.3.3・AC1.3.4] 観察者の参加と、招待の失効") {
            test("Given 有効な招待 When 招待コードで参加する Then 観察者のブラウザセッションだけが発行され、復帰資格は無い") {
                val world = World()
                val game = world.started()
                val code = world.invite(game).ok().invitationCode()

                val outcome = world.joinObserver(code).ok()

                val session = checkNotNull(outcome.issued)
                session.kind shouldBe CredentialKind.OBSERVER
                outcome.recovery shouldBe null
                world.gameEvents(game).filterIsInstance<GameEvent.ObserverJoined>() shouldHaveSize 1
                world.store.observerNames.values
                    .single() shouldBe "見学者"
                world.store.browserSessions.values
                    .filter { it.kind == CredentialKind.OBSERVER } shouldHaveSize 1
            }

            test("Given 失効した招待・知らないコード・形式の違うコード When 参加する Then 区別せず game.invitation_invalid") {
                val world = World()
                val game = world.started()
                val outcome = world.invite(game).ok()
                world.revokeInvitation(game, outcome.invitationId()).ok()

                listOf(outcome.invitationCode(), "v1.UNKNOWNCODE", "not-a-code").forEachIndexed { i, code ->
                    world.joinObserver(code, "try-$i").domainCode() shouldBe "game.invitation_invalid"
                }
                world.gameEvents(game).filterIsInstance<GameEvent.ObserverJoined>().shouldBeEmpty()
            }

            test("Given 期限切れの招待 When 参加する Then game.invitation_invalid") {
                val world = World()
                val game = world.started()
                val code = world.invite(game).ok().invitationCode()

                world.clock = world.clock.plus(Duration.ofDays(7))

                world.joinObserver(code).domainCode() shouldBe "game.invitation_invalid"
            }

            test("Given 参加コード When 観察者として参加する Then game.invitation_invalid（参加コードは招待コードとして使えない）") {
                val world = World()
                val game = world.started()

                world.joinObserver(game.created.joinCode).domainCode() shouldBe "game.invitation_invalid"
            }

            test("[AC1.3.4] Given 参加済みの観察者 When 招待を失効させる Then 観察者のセッションは残る") {
                val world = World()
                val game = world.started()
                world.projected(game)
                val outcome = world.invite(game).ok()
                val session = checkNotNull(world.joinObserver(outcome.invitationCode()).ok().issued).raw

                world.revokeInvitation(game, outcome.invitationId()).ok()

                world.observation(game, session).ok().gameId shouldBe game.gameId
                world.store.credentials.values
                    .single { it.kind == CredentialKind.OBSERVER_INVITATION }
                    .revoked shouldBe true
            }

            test("Given 失効済み・知らない招待・参加者による失効 When 失効させる Then それぞれ拒否される") {
                val world = World()
                val game = world.started()
                val outcome = world.invite(game).ok()
                val id = outcome.invitationId()

                world.revokeInvitation(game, id, game.seats[Role.FACTORY].credential).domainCode() shouldBe
                    "game.forbidden"
                world.revokeInvitation(game, InvitationId(java.util.UUID(7L, 7L))).domainCode() shouldBe
                    "game.invitation_not_found"
                world.revokeInvitation(game, id).ok()
                world.revokeInvitation(game, id, key = "revoke-again").domainCode() shouldBe
                    "game.credential_already_revoked"
            }

            test("[NF-S11] Given 同じ接続元の無効な招待コードの連続 When 上限を超える Then 正しい招待コードでも RateLimited") {
                val world = World()
                val game = world.started()
                val code = world.invite(game).ok().invitationCode()
                repeat(3) { world.joinObserver("v1.WRONG$it", "wrong-$it", SOURCE).domainCode() }

                world.joinObserver(code, "right", SOURCE).err().shouldBeRateLimited()
            }
        }

        context("[US4.1] 観察と、観察者の権限") {
            test("[AC4.1.1] Given 観察者 When 観察を開く Then 現在週・入力済みの役割数・チーム合計が返る") {
                val world = World()
                val game = world.started()
                world.projected(game)
                val session = world.observer(game)

                val observation = world.observation(game, session).ok()

                observation.session shouldBe SessionSummary(SessionStatus.ACTIVE, 2, 1)
                observation.totals.weeks shouldBe listOf(ObservationWeek.Visible(1, 16, 48, 0))
            }

            test("[AC4.1.4] Given 進行役 When 観察を開く Then 開ける") {
                val world = World()
                val game = world.started()
                world.projected(game)

                world.observation(game, game.facilitator).ok().gameId shouldBe game.gameId
            }

            test("[AC4.1.4] Given 参加者・匿名・別のゲームの観察者・存在しないゲーム When 観察を開く Then すべて同じ app.unauthorized") {
                val world = World()
                val game = world.started()
                world.projected(game)
                val other = world.started(tag = "other")
                val otherObserver = world.observer(other)

                listOf(game.seats[Role.RETAILER].credential, null, otherObserver, "v1.garbage").forEach {
                    world.observation(game, it).err() shouldBe AppFailure.Unauthorized
                }
                world.projectedGame = null
                world.observation(game, game.facilitator).err() shouldBe AppFailure.Unauthorized
            }

            test("[AC4.1.2] Given 観察者 When 状態・役割別の状況・ロビーを取得する Then app.unauthorized で、値を返さない") {
                val world = World()
                val game = world.started()
                world.projected(game)
                val session = world.observer(game)

                runBlocking {
                    world.ports.snapshot(game.gameId, session).err() shouldBe AppFailure.Unauthorized
                    world.ports.snapshot(game.gameId, session, Role.RETAILER).err() shouldBe AppFailure.Unauthorized
                }
            }

            test("[AC4.1.5] Given 観察者 When 入力・確定・停止・招待・割り当てを試みる Then すべて拒否され、イベントは増えない") {
                val world = World()
                val game = world.started()
                val session = world.observer(game)
                val before = world.store.events(game.gameId, StreamType.SESSION).size to world.gameEvents(game).size

                runBlocking {
                    val save =
                        world.ports.saveDecision(
                            game.gameId,
                            SaveDecisionInput(Role.RETAILER, 1, 4, 0),
                            meta("o-save", session),
                        )
                    val commit =
                        world.ports.commitWeek(
                            game.gameId,
                            CommitWeekInput(1, beergame.domain.RoleMap.all(0L)),
                            meta("o-commit", session),
                        )
                    val pause = world.ports.pauseSession(game.gameId, meta("o-pause", session))
                    listOf(save, commit, pause).forEach { it.domainCode().substringAfter('.') shouldBe "forbidden" }
                }
                world.invite(game, "o-invite", session).domainCode() shouldBe "game.forbidden"
                world.store.events(game.gameId, StreamType.SESSION).size to world.gameEvents(game).size shouldBe before
            }

            test("[B9] Given 終了したゲームの観察者 When 振り返りを取得する Then 取得できる。終了前は game.not_ended") {
                val world = World()
                val game = world.started()
                val session = world.observer(game)

                world.projected(game, GameStatus.STARTED)
                runBlocking { world.ports.review(game.gameId, session).domainCode() shouldBe "game.not_ended" }

                world.projected(game, GameStatus.ENDED)
                runBlocking {
                    world.ports
                        .review(game.gameId, session)
                        .ok()
                        .gameId shouldBe game.gameId
                }
            }

            test("[B9] Given 進行役のロビー When 招待と観察者を読む Then 招待の状態と観察者（役割なし）が見える") {
                val world = World()
                val game = world.started()
                world.projected(game)

                val facilitator =
                    Disclosure.forFacilitator(
                        checkNotNull(world.projectedGame).copy(
                            invitations =
                                listOf(
                                    ProjectedInvitation(
                                        InvitationId(java.util.UUID(1L, 1L)),
                                        world.clock,
                                        null,
                                        world.clock,
                                    ),
                                ),
                            observers =
                                listOf(
                                    ProjectedObserver(
                                        beergame.domain.ObserverId(java.util.UUID(2L, 2L)),
                                        "見学者",
                                        world.clock,
                                    ),
                                ),
                        ),
                    )

                val view = facilitator.view as SnapshotView.Facilitator
                view.invitations.map { it.revoked } shouldBe listOf(false)
                view.observers.map { it.displayName } shouldBe listOf("見学者")
                (
                    world.store
                        .events(
                            game.gameId,
                            StreamType.GAME,
                        ).map { it.payload }
                ).shouldContain(world.gameEvents(game).first())
            }
        }
    })

private fun AppFailure.shouldBeRateLimited() {
    (this is AppFailure.RateLimited) shouldBe true
}
