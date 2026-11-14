package beergame.application

import arrow.core.Either
import arrow.core.left
import beergame.domain.GameEvent
import beergame.domain.Role
import beergame.domain.SessionEvent
import beergame.domain.StreamType
import io.kotest.core.spec.style.FunSpec
import io.kotest.matchers.collections.shouldBeEmpty
import io.kotest.matchers.collections.shouldContain
import io.kotest.matchers.collections.shouldNotContain
import io.kotest.matchers.shouldBe
import io.kotest.matchers.shouldNotBe

private fun World.attempts(call: String): Int = calls.count { it == call }

/**
 * コマンド処理 `execute` の規則。ADR-004: 認証 → 認可の前提検査 → 冪等記録の照合 → 読み込み → decide → 追記・投影。
 * 業務ルール（decide の中身）は domain の試験が持つので、ここでは順序・保存・再試行・原子性だけを確かめる。
 */
class ExecuteSpec :
    FunSpec({
        test("[ADR-004] Given 参加者の入力の保存 When 実行する Then 認証、冪等記録の照合、読み込み、追記、投影、通知、冪等記録の保存の順に、1 つのトランザクションで行う") {
            val world = World()
            val game = world.started()
            world.clearCalls()

            world.ports
                .saveDecision(
                    game.gameId,
                    SaveDecisionInput(Role.DISTRIBUTOR, 1, 8, 0),
                    meta("order-check", game.seats[Role.DISTRIBUTOR].credential),
                ).ok()

            world.calls shouldBe
                listOf(
                    "tx.begin",
                    "lock.shared",
                    "authenticate",
                    "idempotency.find",
                    "events.read",
                    "events.append",
                    "project.write",
                    "notifier.publish",
                    "idempotency.save",
                    "tx.commit",
                )
        }

        test("[ADR-004] Given ゲームの作成 When 実行する Then 匿名の操作なので認証せず、周辺ストアを追記の後に書く") {
            val world = World()

            world.ports.createGame(CreateGameInput(3, listOf(4, 4, 4), 90), meta("create-order")).ok()

            world.calls shouldBe
                listOf(
                    "tx.begin",
                    "lock.shared",
                    "idempotency.find",
                    "events.read",
                    "events.append",
                    "project.write",
                    "peripheral.write",
                    "notifier.publish",
                    "idempotency.save",
                    "tx.commit",
                )
        }

        test("[ADR-004] Given decide が Left の要求 When 実行し、同じキーで再送する Then 失敗は保存されず、再送は同じ失敗を再計算する") {
            val world = World()
            val game = world.started()
            val wrongSeat = game.seats[Role.FACTORY].credential
            val request = SaveDecisionInput(Role.RETAILER, 1, 4, 0)
            val before = world.store.idempotency.size

            val first = world.ports.saveDecision(game.gameId, request, meta("same-key", wrongSeat))
            world.clearCalls()
            val second = world.ports.saveDecision(game.gameId, request, meta("same-key", wrongSeat))

            first.domainCode() shouldBe "session.forbidden"
            second.domainCode() shouldBe "session.forbidden"
            world.store.idempotency.size shouldBe before
            world.attempts("events.read") shouldBe 1
            world.attempts("idempotency.save") shouldBe 0
            world.store.events(game.gameId, StreamType.SESSION).size shouldBe 1
        }

        test("[ADR-004] Given 成功した要求 When 同じキーと同じ内容で再送する Then 保存した応答をそのまま返し、読み込みも追記もしない") {
            val world = World()
            val game = world.started()
            val request = SaveDecisionInput(Role.DISTRIBUTOR, 1, 8, 0)
            val credential = game.seats[Role.DISTRIBUTOR].credential
            val first = world.ports.saveDecision(game.gameId, request, meta("dup", credential)).ok()
            world.clearCalls()

            val second = world.ports.saveDecision(game.gameId, request, meta("dup", credential)).ok()

            second shouldBe first
            world.calls shouldBe
                listOf("tx.begin", "lock.shared", "authenticate", "idempotency.find", "tx.commit")
            world.store.events(game.gameId, StreamType.SESSION).size shouldBe 2
        }

        test("[ADR-004] Given 成功した要求 When 同じキーで内容が違う要求を送る Then app.idempotency_key_reused で、何も追記しない") {
            val world = World()
            val game = world.started()
            val credential = game.seats[Role.DISTRIBUTOR].credential
            world.ports
                .saveDecision(
                    game.gameId,
                    SaveDecisionInput(Role.DISTRIBUTOR, 1, 8, 0),
                    meta("k", credential),
                ).ok()

            val result =
                world.ports.saveDecision(
                    game.gameId,
                    SaveDecisionInput(Role.DISTRIBUTOR, 1, 9, 0),
                    meta("k", credential),
                )

            result.err() shouldBe AppFailure.IdempotencyKeyReused
            world.store.events(game.gameId, StreamType.SESSION).size shouldBe 2
        }

        test("[ADR-004] Given 進行役が成功した要求 When 同じキーと同じ内容を別の操作者が送る Then 内容が違うものとして app.idempotency_key_reused") {
            val world = World()
            val game = world.prepared()
            val participant = game.seats[Role.FACTORY]
            world.ports
                .assignRole(
                    game.gameId,
                    participant.participantId,
                    Role.DISTRIBUTOR,
                    meta("shared-key", game.facilitator),
                ).ok()

            val result =
                world.ports.assignRole(
                    game.gameId,
                    participant.participantId,
                    Role.DISTRIBUTOR,
                    meta("shared-key", participant.credential),
                )

            result.err() shouldBe AppFailure.IdempotencyKeyReused
        }

        test(
            "[ADR-004][H4] Given 成功した要求の後に資格が失効した When 失効した資格が同じキーを再送する Then 403（app.unauthorized）で、冪等記録を検索せず、応答を返さない",
        ) {
            val world = World()
            val game = world.prepared()
            val seat = game.seats[Role.FACTORY]
            val first =
                world.ports
                    .assignRole(
                        game.gameId,
                        seat.participantId,
                        Role.FACTORY,
                        meta("old-key", game.facilitator),
                    ).ok()
            world.revoke(game.facilitator)
            world.clearCalls()

            val replay =
                world.ports.assignRole(
                    game.gameId,
                    seat.participantId,
                    Role.FACTORY,
                    meta("old-key", game.facilitator),
                )

            first.versions.game shouldNotBe null
            replay.err() shouldBe AppFailure.Unauthorized
            world.calls shouldNotContain "idempotency.find"
            world.calls shouldContain "authenticate"
        }

        test("[ADR-004] Given 資格が無い、不明、期限切れ、別のゲームのもの When 資格が要る操作をする Then どれも同じ app.unauthorized で、冪等記録を検索しない") {
            val world = World()
            val game = world.prepared()
            val other = world.prepared(tag = "other")
            val seat = game.seats[Role.FACTORY]
            val act: suspend (String?) -> Either<AppFailure, CommandOutcome> = { credential ->

                world.ports.assignRole(
                    game.gameId,
                    seat.participantId,
                    Role.FACTORY,
                    meta("authz-${credential.orEmpty()}", credential),
                )
            }
            world.clearCalls()

            val none = act(null)
            val unknown = act("not-a-credential")
            val foreign = act(other.facilitator)
            world.clock = T0.plusSeconds(90L * 86_400 + 1)
            val expired = act(game.facilitator)

            listOf(none, unknown, foreign, expired).forEach { it.err() shouldBe AppFailure.Unauthorized }
            world.calls shouldNotContain "idempotency.find"
        }

        test("[ADR-005] Given 追記が 2 回競合する When 上限 3 回で実行する Then 再読み込みしてやり直し、3 回目で成功し、1 回分だけ反映する") {
            val world = World(testSettings(maxAttempts = 3))
            val game = world.started()
            world.clearCalls()
            world.conflictsToInject = 2

            val outcome =
                world.ports
                    .saveDecision(
                        game.gameId,
                        SaveDecisionInput(Role.DISTRIBUTOR, 1, 8, 0),
                        meta("retry", game.seats[Role.DISTRIBUTOR].credential),
                    ).ok()

            world.attempts("events.append") shouldBe 3
            world.attempts("events.read") shouldBe 3
            world.attempts("authenticate") shouldBe 3
            world.attempts("idempotency.find") shouldBe 3
            world.attempts("tx.rollback") shouldBe 2
            outcome.versions.session?.value shouldBe 2
            world.store.payloads<SessionEvent.DecisionSaved>(game.gameId, StreamType.SESSION).size shouldBe 1
        }

        test("[NF-R17] Given 競合が続く When 上限（設定から注入した 2 回）に達する Then app.retry_exhausted で、何も反映しない") {
            val world = World(testSettings(maxAttempts = 2))
            val game = world.started()
            world.clearCalls()
            world.conflictsToInject = 10

            val result =
                world.ports.saveDecision(
                    game.gameId,
                    SaveDecisionInput(Role.DISTRIBUTOR, 1, 8, 0),
                    meta("exhaust", game.seats[Role.DISTRIBUTOR].credential),
                )

            result.err() shouldBe AppFailure.RetryExhausted
            world.attempts("events.append") shouldBe 2
            world.store.payloads<SessionEvent.DecisionSaved>(game.gameId, StreamType.SESSION).shouldBeEmpty()
        }

        test("[NF-R17] Given 再構築のロックの待ちが上限を超えた When 実行する Then RetryExhausted をそのまま返し、再試行しない") {
            val world = World()
            val game = world.started()
            world.clearCalls()
            world.lockResult = AppFailure.RetryExhausted.left()

            val result =
                world.ports.saveDecision(
                    game.gameId,
                    SaveDecisionInput(Role.DISTRIBUTOR, 1, 8, 0),
                    meta("locked", game.seats[Role.DISTRIBUTOR].credential),
                )

            result.err() shouldBe AppFailure.RetryExhausted
            world.attempts("lock.shared") shouldBe 1
            world.calls shouldNotContain "authenticate"
        }

        test("[AC2.3.3] Given 追記の後の投影が失敗する When 実行する Then Left を返し、トランザクションごと取り消して、追記も通知も残さない") {
            val world = World()
            val game = world.started()
            val streamBefore = world.store.events(game.gameId, StreamType.SESSION)
            val noticesBefore = world.store.notices
            world.failProjection = true

            val result =
                world.ports.saveDecision(
                    game.gameId,
                    SaveDecisionInput(Role.DISTRIBUTOR, 1, 8, 0),
                    meta("proj-fail", game.seats[Role.DISTRIBUTOR].credential),
                )

            (result.err() is AppFailure.Persistence) shouldBe true
            world.store.events(game.gameId, StreamType.SESSION) shouldBe streamBefore
            world.store.notices shouldBe noticesBefore
            world.calls.last() shouldBe "tx.rollback"
        }

        test("[NF-S14] Given 追記の後の周辺ストアの書き込みが失敗する When 参加する Then 参加の事実も取り消され、冪等記録も残らない") {
            val world = World()
            val created = world.createGame()
            val gameEvents = world.store.events(created.gameId, StreamType.GAME)
            val idempotencyBefore = world.store.idempotency.size
            world.failPeripheral = true

            val result = world.ports.joinGame(JoinGameInput(created.joinCode, "田中"), meta("peripheral-fail"))

            (result.err() is AppFailure.Persistence) shouldBe true
            world.store.events(created.gameId, StreamType.GAME) shouldBe gameEvents
            world.store.idempotency.size shouldBe idempotencyBefore
            world.store.displayNames.isEmpty() shouldBe true
        }

        test("[ADR-004] Given decide が空の列を返す要求（同じ役割への割り当て直し） When 実行する Then 追記せず、冪等記録だけを書き、版は変わらない") {
            val world = World()
            val game = world.prepared()
            val seat = game.seats[Role.FACTORY]
            val versionBefore = world.store.events(game.gameId, StreamType.GAME).size
            world.clearCalls()

            val outcome =
                world.ports
                    .assignRole(
                        game.gameId,
                        seat.participantId,
                        Role.FACTORY,
                        meta("noop", game.facilitator),
                    ).ok()

            world.calls shouldNotContain "events.append"
            world.calls shouldNotContain "project.write"
            world.calls shouldContain "idempotency.save"
            outcome.versions.game?.value shouldBe versionBefore.toLong()
            world.store.events(game.gameId, StreamType.GAME).size shouldBe versionBefore
        }

        test("[ADR-005] Given 同じキーのゲーム作成が同時に来て保存で重複を検出する When 実行する Then 再試行で記録を見つけ、先の要求と同じ応答を返し、後のゲームは残らない") {
            val world = World()
            val first = world.ports.createGame(CreateGameInput(3, listOf(4, 4, 4), 90), meta("create-dup")).ok()
            world.hideNextIdempotencyFind = true

            val second = world.ports.createGame(CreateGameInput(3, listOf(4, 4, 4), 90), meta("create-dup")).ok()

            second.gameId shouldBe first.gameId
            second.issued shouldBe first.issued
            world.store.streams.keys
                .filter { it.second == StreamType.GAME }
                .size shouldBe 1
            world.store.payloads<GameEvent.GameCreated>(first.gameId, StreamType.GAME).size shouldBe 1
        }

        test("[ADR-004] Given 4 役割の入力の保存が成功する When 通知を見る Then 追記したストリームの版だけを通知する") {
            val world = World()
            val game = world.started()
            val noticesBefore = world.store.notices.size

            world.saveAll(game)

            val added = world.store.notices.drop(noticesBefore)
            added.size shouldBe Role.entries.size
            added.all { it.streamType == StreamType.SESSION && it.gameId == game.gameId } shouldBe true
        }
    })
