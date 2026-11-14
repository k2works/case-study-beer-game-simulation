package beergame.application

import beergame.domain.Actor
import beergame.domain.GameError
import beergame.domain.GameEvent
import beergame.domain.ParticipantId
import beergame.domain.Role
import beergame.domain.SessionEvent
import beergame.domain.StreamType
import beergame.domain.ValidationError
import io.kotest.core.spec.style.FunSpec
import io.kotest.matchers.collections.shouldBeEmpty
import io.kotest.matchers.collections.shouldContain
import io.kotest.matchers.collections.shouldContainExactly
import io.kotest.matchers.collections.shouldHaveSize
import io.kotest.matchers.shouldBe
import java.time.Duration
import java.util.UUID

private val VALID = CreateGameInput(finalWeek = 3, demand = listOf(4, 4, 4), retentionDays = 90)

/** ゲームの作成・参加・役割の割り当て・開始（game ストリーム）。業務ルールそのものは domain の試験が持つ。 */
class GameCommandsSpec :
    FunSpec({
        test("[US1.1/AC1.1.1] Given 有効なキット準拠の設定 When ゲームを作成する Then 準備中のゲームが 1 件作成され、進行役の資格が発行される") {
            val world = World()

            val outcome = world.ports.createGame(VALID, meta("create-1")).ok()

            val created = world.store.payloads<GameEvent.GameCreated>(outcome.gameId, StreamType.GAME).single()
            created.settings.finalWeek.value shouldBe 3
            created.retentionDays.value shouldBe 90
            created.facilitatorCredentialExpiresAt shouldBe T0.plus(Duration.ofDays(90))
            outcome.versions shouldBe Versions(game = outcome.versions.game, session = null)
            outcome.versions.game?.value shouldBe 1
            world.store.notices
                .single()
                .streamType shouldBe StreamType.GAME
            checkNotNull(outcome.issued).kind shouldBe CredentialKind.FACILITATOR
        }

        test("[US1.1/#14] Given ゲームの作成 When 進行役の資格を発行する Then 資格とブラウザセッションをダイジェストだけで保存し、生の値は世界のどこにも残らない") {
            val world = World()

            val outcome = world.ports.createGame(VALID, meta("create-1")).ok()
            val raw = checkNotNull(outcome.issued).raw

            val digest = CredentialDigest.of(world.settings.credentialSecret, raw)
            digest shouldBe
                world.store.credentials.keys
                    .single()
            (digest == raw) shouldBe false
            world.store.browserSessions.keys
                .single() shouldBe digest
            val row = world.store.credentials.getValue(digest)
            row.kind shouldBe CredentialKind.FACILITATOR
            row.subjectId shouldBe outcome.gameId.value
            row.keyVersion shouldBe 1
            row.expiresAt shouldBe T0.plus(Duration.ofDays(90))
            world.store.projected
                .map { it.payload.toString() }
                .none { it.contains(raw) } shouldBe true
            world.store.streams.values
                .flatten()
                .none { it.payload.toString().contains(raw) } shouldBe true
        }

        test("[US1.1/AC1.1.1] Given 作成の要求 When 同じキーで再送する Then ゲームは 1 つのままで、同じ応答（同じ進行役の資格）を返す") {
            val world = World()

            val first = world.ports.createGame(VALID, meta("create-1")).ok()
            val second = world.ports.createGame(VALID, meta("create-1")).ok()

            second shouldBe first
            world.store.streams.keys
                .filter { it.second == StreamType.GAME }
                .shouldHaveSize(1)
        }

        test("[US1.1/AC1.1.2] Given 最終週 12 で第 5 週の需要が 1001 When 作成しようとする Then 作成せず、対象の週を示し、トランザクションも開かない") {
            val world = World()
            val demand = List(12) { if (it == 4) 1001 else 4 }

            val result = world.ports.createGame(CreateGameInput(12, demand, 90), meta("bad"))

            val failure = result.err()
            failure as AppFailure.Invalid
            val error = failure.errors.filterIsInstance<ValidationError.DemandSeriesInvalid>().single()
            error.weekIndex shouldBe 5
            world.store.streams.isEmpty() shouldBe true
            world.calls.shouldBeEmpty()
        }

        test("[US1.1/AC1.1.2] Given 需要系列と保持日数の両方が不正 When 作成しようとする Then 誤りを項目ごとにすべて集めて返す") {
            val world = World()

            val failure = world.ports.createGame(CreateGameInput(3, listOf(4, 1001, 4), 0), meta("bad")).err()

            failure as AppFailure.Invalid
            failure.errors.filterIsInstance<ValidationError.DemandSeriesInvalid>().map {
                it.weekIndex
            } shouldContainExactly
                listOf(2)
            failure.errors
                .filterIsInstance<ValidationError.RetentionOutOfRange>()
                .single()
                .actual shouldBe 0
        }

        test("[US1.2/AC1.2.1] Given 有効な参加コード When 表示名「田中」で参加する Then ロビーに参加し、復帰資格とブラウザセッションが保存され、表示名はイベントに入らない") {
            val world = World()
            val created = world.createGame()

            val outcome = world.ports.joinGame(JoinGameInput(created.joinCode, "田中"), meta("join-1")).ok()
            val issued = checkNotNull(outcome.issued)

            val joined = world.store.payloads<GameEvent.ParticipantJoined>(created.gameId, StreamType.GAME).single()
            joined.credentialExpiresAt shouldBe T0.plus(Duration.ofDays(30))
            issued.kind shouldBe CredentialKind.PARTICIPANT_RECOVERY
            issued.actor.id shouldBe joined.participantId.value
            world.store.displayNames[joined.participantId] shouldBe "田中"
            val digest = CredentialDigest.of(world.settings.credentialSecret, issued.raw)
            world.store.credentials
                .getValue(digest)
                .kind shouldBe CredentialKind.PARTICIPANT_RECOVERY
            world.store.browserSessions
                .getValue(digest)
                .first shouldBe created.gameId
            (issued.raw in world.store.credentials.keys) shouldBe false
            world.store.streams.values
                .flatten()
                .none { it.payload.toString().contains("田中") } shouldBe true
        }

        test("[US1.2/AC1.2.2] Given 存在しない参加コード When 参加しようとする Then 参加できず、game.invitation_invalid（403）で、何も追記しない") {
            val world = World()
            val created = world.createGame()
            val before = world.store.events(created.gameId, StreamType.GAME)

            val result = world.ports.joinGame(JoinGameInput("NO-SUCH-CODE", "田中"), meta("join-1"))

            result.domainCode() shouldBe "game.invitation_invalid"
            world.store.events(created.gameId, StreamType.GAME) shouldBe before
        }

        test("[US1.2/AC1.2.2] Given 8 桁に満たない参加コード When 参加しようとする Then 存在しないコードと同じ game.invitation_invalid") {
            val world = World()
            world.createGame()

            world.ports.joinGame(JoinGameInput("ABC", "田中"), meta("join-1")).domainCode() shouldBe
                "game.invitation_invalid"
        }

        test("[US1.2/AC1.2.2] Given 開始済みのゲームの参加コード When 新しい参加者が参加しようとする Then 参加できず、受付の終了（game.not_preparing）を示す") {
            val world = World()
            val game = world.started()

            val result = world.ports.joinGame(JoinGameInput(game.created.joinCode, "山本"), meta("join-late"))

            result.domainCode() shouldBe "game.not_preparing"
            world.store.displayNames.values
                .contains("山本") shouldBe false
        }

        test("[US1.2/AC1.2.1] Given 表示名が空白だけ When 参加しようとする Then 422 の誤り（DisplayNameInvalid）で、トランザクションも開かない") {
            val world = World()
            val created = world.createGame()
            world.clearCalls()

            val failure = world.ports.joinGame(JoinGameInput(created.joinCode, "   "), meta("join-1")).err()

            failure as AppFailure.Invalid
            failure.errors
                .filterIsInstance<ValidationError.DisplayNameInvalid>()
                .single()
                .length shouldBe 0
            world.calls.shouldBeEmpty()
        }

        test("[US1.2] Given 準備中のゲームと参加者 When 進行役が役割を割り当てる Then RoleAssigned を追記し、ロビーの版が進む") {
            val world = World()
            val created = world.createGame()
            val seat = world.join(created, "田中", "join-1")

            val outcome =
                world.ports
                    .assignRole(
                        created.gameId,
                        seat.participantId,
                        Role.RETAILER,
                        meta("assign-1", created.facilitator),
                    ).ok()

            world.store
                .payloads<GameEvent.RoleAssigned>(created.gameId, StreamType.GAME)
                .single()
                .role shouldBe
                Role.RETAILER
            outcome.versions.game?.value shouldBe 3
        }

        test("[US1.2/AC1.2.5] Given 小売店にいる参加者 When 進行役が二次卸に割り当てる Then 解除と割り当ての 2 イベントを 1 回の追記で書く") {
            val world = World()
            val created = world.createGame()
            val seat = world.join(created, "山本", "join-1")
            world.ports
                .assignRole(
                    created.gameId,
                    seat.participantId,
                    Role.RETAILER,
                    meta("assign-1", created.facilitator),
                ).ok()

            val outcome =
                world.ports
                    .assignRole(
                        created.gameId,
                        seat.participantId,
                        Role.WHOLESALER,
                        meta("assign-2", created.facilitator),
                    ).ok()

            val tail =
                world.store
                    .events(created.gameId, StreamType.GAME)
                    .takeLast(2)
                    .map { it.payload }
            tail shouldBe
                listOf(
                    GameEvent.RoleUnassigned(seat.participantId, Role.RETAILER),
                    GameEvent.RoleAssigned(seat.participantId, Role.WHOLESALER),
                )
            outcome.versions.game?.value shouldBe 5
        }

        test("[US1.2] Given 参加者の資格 When 役割の割り当てをしようとする Then game.forbidden（進行役だけ）で、役割は変わらない") {
            val world = World()
            val created = world.createGame()
            val seat = world.join(created, "田中", "join-1")

            val result =
                world.ports.assignRole(
                    created.gameId,
                    seat.participantId,
                    Role.RETAILER,
                    meta("assign-1", seat.credential),
                )

            result.domainCode() shouldBe "game.forbidden"
            world.store.payloads<GameEvent.RoleAssigned>(created.gameId, StreamType.GAME).shouldBeEmpty()
        }

        test("[US1.2] Given 別のゲームの進行役の資格 When 割り当てをしようとする Then app.unauthorized で、対象のゲームには何も追記しない") {
            val world = World()
            val target = world.createGame(tag = "a")
            val other = world.createGame(tag = "b")
            val seat = world.join(target, "田中", "join-1")

            val result =
                world.ports.assignRole(
                    target.gameId,
                    seat.participantId,
                    Role.RETAILER,
                    meta("assign-1", other.facilitator),
                )

            result.err() shouldBe AppFailure.Unauthorized
            world.store.payloads<GameEvent.RoleAssigned>(target.gameId, StreamType.GAME).shouldBeEmpty()
        }

        test("[US1.2] Given 存在しない参加者 When 割り当てる Then game.participant_not_found") {
            val world = World()
            val created = world.createGame()
            val ghost = ParticipantId(UUID(7L, 7L))

            world.ports
                .assignRole(
                    created.gameId,
                    ghost,
                    Role.RETAILER,
                    meta("assign-1", created.facilitator),
                ).domainCode() shouldBe
                "game.participant_not_found"
        }

        test("[US1.2/AC1.2.3] Given 3 役割だけに参加者がいる When 進行役が開始しようとする Then 開始せず、不足している役割（一次卸）を示し、どのストリームにも追記しない") {
            val world = World()
            val created = world.createGame()
            listOf(Role.FACTORY, Role.WHOLESALER, Role.RETAILER).forEachIndexed { i, role ->
                val seat = world.join(created, "参加者$i", "join-$i")
                world.ports
                    .assignRole(
                        created.gameId,
                        seat.participantId,
                        role,
                        meta("assign-$i", created.facilitator),
                    ).ok()
            }
            val gameBefore = world.store.events(created.gameId, StreamType.GAME)

            val failure = world.ports.startGame(created.gameId, meta("start-1", created.facilitator)).err()

            failure as AppFailure.Domain
            (failure.error as GameError.StartConditionNotMet).missing shouldBe listOf(Role.DISTRIBUTOR)
            world.store.events(created.gameId, StreamType.GAME) shouldBe gameBefore
            world.store.events(created.gameId, StreamType.SESSION).shouldBeEmpty()
        }

        test("[US1.2] Given 4 役割に参加者がいる When 進行役が開始する Then game と session の両方に 1 回の追記で書き、両方の版を返し、投影も 1 回で書く") {
            val world = World()
            val game = world.prepared()
            val gameVersion = world.store.events(game.gameId, StreamType.GAME).size
            world.clearCalls()

            val outcome = world.ports.startGame(game.gameId, meta("start-1", game.facilitator)).ok()

            world.store.payloads<GameEvent.GameStarted>(game.gameId, StreamType.GAME).shouldHaveSize(1)
            world.store.payloads<SessionEvent.SessionStarted>(game.gameId, StreamType.SESSION).shouldHaveSize(1)
            outcome.versions.game?.value shouldBe gameVersion + 1L
            outcome.versions.session?.value shouldBe 1
            world.calls.count { it == "events.append" } shouldBe 1
            world.calls.count { it == "project.write" } shouldBe 1
            world.calls.count { it == "events.read" } shouldBe 2
            world.store.notices
                .takeLast(2)
                .map { it.streamType }
                .toSet() shouldBe
                setOf(StreamType.GAME, StreamType.SESSION)
        }

        test("[US1.2] Given 開始の投影が失敗する When 開始する Then game も session も追記されない（2 ストリームの原子性）") {
            val world = World()
            val game = world.prepared()
            val gameBefore = world.store.events(game.gameId, StreamType.GAME)
            world.failProjection = true

            val result = world.ports.startGame(game.gameId, meta("start-1", game.facilitator))

            (result.err() is AppFailure.Persistence) shouldBe true
            world.store.events(game.gameId, StreamType.GAME) shouldBe gameBefore
            world.store.events(game.gameId, StreamType.SESSION).shouldBeEmpty()
        }

        test("[US1.2] Given 開始済みのゲーム When 新しいキーで開始を送る Then session.already_started で、同じキーなら保存した応答を返す") {
            val world = World()
            val game = world.started()

            val again = world.ports.startGame(game.gameId, meta("start-again", game.facilitator))
            val replay = world.ports.startGame(game.gameId, meta("start-", game.facilitator)).ok()

            again.domainCode() shouldBe "session.already_started"
            replay.versions.session?.value shouldBe 1
            world.store.payloads<SessionEvent.SessionStarted>(game.gameId, StreamType.SESSION).shouldHaveSize(1)
        }

        test("[US1.2] Given 参加者の資格 When 開始しようとする Then game.forbidden で、開始しない") {
            val world = World()
            val game = world.prepared()

            val result = world.ports.startGame(game.gameId, meta("start-1", game.seats[Role.RETAILER].credential))

            result.domainCode() shouldBe "game.forbidden"
            world.store.events(game.gameId, StreamType.SESSION).shouldBeEmpty()
        }

        test("[AC1.2.1] Given 進行役の資格のダイジェスト When 認証する Then 操作者は進行役で、ゲームは資格のゲーム") {
            val world = World()
            val created = world.createGame()
            val digest = CredentialDigest.of(world.settings.credentialSecret, created.facilitator)

            val verified =
                world.ports.events
                    .transaction { tx ->
                        world.ports.peripheral.authenticate(
                            tx,
                            digest,
                            T0,
                        )
                    }.ok()

            verified?.actor shouldBe Actor.Facilitator(created.gameId)
            verified?.gameId shouldBe created.gameId
            world.store.credentials.keys shouldContain digest
        }
    })
