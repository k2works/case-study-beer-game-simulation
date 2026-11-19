package beergame.application

import beergame.domain.Quantity
import beergame.domain.Role
import beergame.domain.RoleMap
import beergame.domain.SessionError
import beergame.domain.SessionEvent
import beergame.domain.StreamType
import beergame.domain.ValidationError
import io.kotest.core.spec.style.FunSpec
import io.kotest.matchers.collections.shouldBeEmpty
import io.kotest.matchers.collections.shouldHaveSize
import io.kotest.matchers.shouldBe
import kotlinx.coroutines.runBlocking

private fun World.save(
    game: Prepared,
    role: Role,
    quantity: Int,
    expected: Long = 0,
    key: String = "save-${role.name}-$quantity-$expected",
) = runBlocking {
    ports.saveDecision(
        game.gameId,
        SaveDecisionInput(role, 1, quantity, expected),
        meta(key, game.seats[role].credential),
    )
}

private fun basis(version: Long): RoleMap<Long> = RoleMap.all(version)

/** 入力の保存と 1 週の確定（session ストリーム）。 */
class SessionCommandsSpec :
    FunSpec({
        test("[US2.2/AC2.2.1] Given 開始済みのゲーム When 一次卸の参加者が当週の数量 8 を保存する Then 一次卸の入力として保存され、session の版だけを返す") {
            val world = World()
            val game = world.started()

            val outcome = world.save(game, Role.DISTRIBUTOR, 8).ok()

            val saved = world.store.payloads<SessionEvent.DecisionSaved>(game.gameId, StreamType.SESSION).single()
            saved.role shouldBe Role.DISTRIBUTOR
            saved.quantity shouldBe Quantity.of(8).ok()
            saved.decisionVersion.value shouldBe 1
            outcome.versions.game shouldBe null
            outcome.versions.session?.value shouldBe 2
        }

        test("[US2.2/AC2.2.1] Given 工場の参加者 When 当週の数量 6 を保存する Then 工場の入力として保存される") {
            val world = World()
            val game = world.started()

            world.save(game, Role.FACTORY, 6).ok()

            val saved = world.store.payloads<SessionEvent.DecisionSaved>(game.gameId, StreamType.SESSION).single()
            saved.role shouldBe Role.FACTORY
            saved.quantity.value shouldBe 6
        }

        test("[US2.2/AC2.2.2] Given 範囲外の数量（-1、1001） When 保存しようとする Then 保存せず、数量の誤りを返し、トランザクションも開かない") {
            val world = World()
            val game = world.started()
            world.clearCalls()

            val negative = world.save(game, Role.RETAILER, -1).err()
            val tooMany = world.save(game, Role.RETAILER, 1001).err()

            negative as AppFailure.Invalid
            tooMany as AppFailure.Invalid
            negative.errors
                .filterIsInstance<ValidationError.QuantityOutOfRange>()
                .single()
                .actual shouldBe -1
            tooMany.errors
                .filterIsInstance<ValidationError.QuantityOutOfRange>()
                .single()
                .actual shouldBe 1001
            world.calls.shouldBeEmpty()
        }

        test("[US2.2/AC2.2.2] Given 境界の数量（0、1000） When 保存する Then 受け付ける") {
            val world = World()
            val game = world.started()

            world.save(game, Role.RETAILER, 0).ok()
            world.save(game, Role.RETAILER, 1000, expected = 1).ok()

            world.store
                .payloads<SessionEvent.DecisionSaved>(
                    game.gameId,
                    StreamType.SESSION,
                ).map { it.quantity.value } shouldBe
                listOf(0, 1000)
        }

        test("[US2.2/AC2.2.2] Given 週と数量の両方が不正 When 保存しようとする Then 誤りをすべて集める") {
            val world = World()
            val game = world.started()

            val failure =
                world.ports
                    .saveDecision(
                        game.gameId,
                        SaveDecisionInput(Role.RETAILER, 0, 1001, 0),
                        meta("bad", game.seats[Role.RETAILER].credential),
                    ).err()

            failure as AppFailure.Invalid
            failure.errors shouldHaveSize 2
        }

        test("[US2.1] Given 工場の参加者 When 小売店の入力を保存しようとする Then session.forbidden で、何も保存しない") {
            val world = World()
            val game = world.started()

            val result =
                world.ports.saveDecision(
                    game.gameId,
                    SaveDecisionInput(Role.RETAILER, 1, 4, 0),
                    meta("cross-role", game.seats[Role.FACTORY].credential),
                )

            result.domainCode() shouldBe "session.forbidden"
            world.store.payloads<SessionEvent.DecisionSaved>(game.gameId, StreamType.SESSION).shouldBeEmpty()
        }

        test("[US2.1] Given 進行役の資格 When 入力を保存しようとする Then session.forbidden（入力は担当の参加者だけ）") {
            val world = World()
            val game = world.started()

            val result =
                world.ports.saveDecision(
                    game.gameId,
                    SaveDecisionInput(Role.RETAILER, 1, 4, 0),
                    meta("facilitator-input", game.facilitator),
                )

            result.domainCode() shouldBe "session.forbidden"
        }

        test("[US2.1] Given 別のゲームの参加者の資格 When 入力を保存しようとする Then app.unauthorized（403）で、何も保存しない") {
            val world = World()
            val game = world.started(tag = "a")
            val other = world.started(tag = "b")

            val result =
                world.ports.saveDecision(
                    game.gameId,
                    SaveDecisionInput(Role.RETAILER, 1, 4, 0),
                    meta("cross-game", other.seats[Role.RETAILER].credential),
                )

            result.err() shouldBe AppFailure.Unauthorized
            world.store.payloads<SessionEvent.DecisionSaved>(game.gameId, StreamType.SESSION).shouldBeEmpty()
        }

        test("[US2.2] Given 開始前のゲーム When 入力を保存しようとする Then session.not_active") {
            val world = World()
            val game = world.prepared()

            val result =
                world.ports.saveDecision(
                    game.gameId,
                    SaveDecisionInput(Role.RETAILER, 1, 4, 0),
                    meta("early", game.seats[Role.RETAILER].credential),
                )

            result.domainCode() shouldBe "session.not_active"
        }

        test("[US2.2] Given 古い意思決定の版 When 保存しようとする Then session.decision_conflict で、再試行せず 1 回の判定で返す") {
            val world = World()
            val game = world.started()
            world.save(game, Role.RETAILER, 4).ok()
            world.clearCalls()

            val result = world.save(game, Role.RETAILER, 9, expected = 0, key = "stale")

            result.domainCode() shouldBe "session.decision_conflict"
            world.calls.count { it == "events.read" } shouldBe 1
        }

        test("[US2.2] Given 保存した入力 When 同じ要求を再送する Then 保存は 1 回分だけ") {
            val world = World()
            val game = world.started()

            val first = world.save(game, Role.RETAILER, 4, key = "dup").ok()
            val second = world.save(game, Role.RETAILER, 4, key = "dup").ok()

            second shouldBe first
            world.store.payloads<SessionEvent.DecisionSaved>(game.gameId, StreamType.SESSION) shouldHaveSize 1
        }

        test("[US2.3/AC2.3.1] Given 第 1 週の 4 役割の入力がそろった When 進行役が第 1 週を確定する Then WeekCommitted を追記し、session の版を返す") {
            val world = World()
            val game = world.started()
            world.saveAll(game, quantity = 4)

            val outcome =
                world.ports
                    .commitWeek(
                        game.gameId,
                        CommitWeekInput(1, basis(1)),
                        meta("commit-1", game.facilitator),
                    ).ok()

            val committed = world.store.payloads<SessionEvent.WeekCommitted>(game.gameId, StreamType.SESSION).single()
            committed.week.value shouldBe 1
            committed.decisions shouldBe RoleMap.all(Quantity.of(4).ok())
            Role.entries.forEach { committed.results[it].ordered.value shouldBe 4 }
            outcome.versions.session?.value shouldBe 6
            outcome.versions.game shouldBe null
        }

        test("[US2.3/AC2.3.2] Given 第 1 週を確定済み When 同じ確定の要求を再送する Then 保存した応答を返し、結果は 1 回分だけ") {
            val world = World()
            val game = world.started()
            world.saveAll(game)
            val first =
                world.ports
                    .commitWeek(
                        game.gameId,
                        CommitWeekInput(1, basis(1)),
                        meta("commit-1", game.facilitator),
                    ).ok()

            val second =
                world.ports
                    .commitWeek(
                        game.gameId,
                        CommitWeekInput(1, basis(1)),
                        meta("commit-1", game.facilitator),
                    ).ok()

            second shouldBe first
            world.store.payloads<SessionEvent.WeekCommitted>(game.gameId, StreamType.SESSION) shouldHaveSize 1
        }

        test("[US2.3/AC2.3.2] Given 第 1 週を確定済み When 新しい要求で第 1 週を確定しようとする Then session.week_advanced で拒否され、結果は増えない") {
            val world = World()
            val game = world.started()
            world.saveAll(game)
            world.ports.commitWeek(game.gameId, CommitWeekInput(1, basis(1)), meta("commit-1", game.facilitator)).ok()

            val result =
                world.ports.commitWeek(
                    game.gameId,
                    CommitWeekInput(1, basis(1)),
                    meta("commit-new", game.facilitator),
                )

            result.domainCode() shouldBe "session.week_advanced"
            world.store.payloads<SessionEvent.WeekCommitted>(game.gameId, StreamType.SESSION) shouldHaveSize 1
        }

        test("[US2.3] Given 工場が未入力の第 1 週 When 確定しようとする Then session.incomplete_decisions で、不足している役割（工場）を示し、週は確定されない") {
            val world = World()
            val game = world.started()
            listOf(Role.DISTRIBUTOR, Role.WHOLESALER, Role.RETAILER).forEach { world.save(game, it, 4).ok() }
            val basisWithFactoryUnsaved = RoleMap(0L, 1L, 1L, 1L)

            val failure =
                world.ports
                    .commitWeek(
                        game.gameId,
                        CommitWeekInput(1, basisWithFactoryUnsaved),
                        meta("commit-1", game.facilitator),
                    ).err()

            failure as AppFailure.Domain
            (failure.error as SessionError.IncompleteDecisions).missing shouldBe listOf(Role.FACTORY)
            world.store.payloads<SessionEvent.WeekCommitted>(game.gameId, StreamType.SESSION).shouldBeEmpty()
        }

        test("[US2.3] Given 確定の根拠にした入力の版が現在と違う When 確定しようとする Then session.decisions_changed") {
            val world = World()
            val game = world.started()
            world.saveAll(game)

            val result =
                world.ports.commitWeek(
                    game.gameId,
                    CommitWeekInput(1, basis(0)),
                    meta("commit-1", game.facilitator),
                )

            result.domainCode() shouldBe "session.decisions_changed"
        }

        test("[US2.3] Given 参加者の資格 When 確定しようとする Then session.forbidden（確定は進行役だけ）") {
            val world = World()
            val game = world.started()
            world.saveAll(game)

            val result =
                world.ports.commitWeek(
                    game.gameId,
                    CommitWeekInput(1, basis(1)),
                    meta("commit-1", game.seats[Role.RETAILER].credential),
                )

            result.domainCode() shouldBe "session.forbidden"
        }

        test("[US2.3/AC2.3.3] Given 確定の投影が失敗する When 確定する Then 週は確定されず、投影の障害を直した後の再実行で 1 回だけ確定される") {
            val world = World()
            val game = world.started()
            world.saveAll(game)
            val request = CommitWeekInput(1, basis(1))
            world.failProjection = true

            val failed = world.ports.commitWeek(game.gameId, request, meta("commit-1", game.facilitator))
            world.store.payloads<SessionEvent.WeekCommitted>(game.gameId, StreamType.SESSION).shouldBeEmpty()
            world.failProjection = false
            val retried = world.ports.commitWeek(game.gameId, request, meta("commit-1", game.facilitator))

            (failed.err() is AppFailure.Persistence) shouldBe true
            retried.ok()
            world.store.payloads<SessionEvent.WeekCommitted>(game.gameId, StreamType.SESSION) shouldHaveSize 1
        }

        test("[US2.3/AC2.3.4] Given 同じ設定と入力の 2 つのゲーム When どちらも第 1 週を確定する Then 全役割の結果と状態が一致する") {
            val results =
                listOf("a", "b").map { tag ->
                    val world = World()
                    val game = world.started(tag = tag)
                    world.saveAll(game, quantity = 7)
                    world.ports
                        .commitWeek(
                            game.gameId,
                            CommitWeekInput(1, basis(1)),
                            meta("commit-1", game.facilitator),
                        ).ok()
                    world.store
                        .payloads<SessionEvent.WeekCommitted>(game.gameId, StreamType.SESSION)
                        .single()
                        .let { it.results to it.nextStates }
                }

            results[0] shouldBe results[1]
        }

        test("[US2.3] Given 最終週のゲーム When 最終週を確定する Then WeekCommitted と SessionEnded を 1 回の追記で書く") {
            val world = World()
            val game = world.started(demand = listOf(4))
            world.saveAll(game)

            val outcome =
                world.ports
                    .commitWeek(
                        game.gameId,
                        CommitWeekInput(1, basis(1)),
                        meta("commit-1", game.facilitator),
                    ).ok()

            val tail =
                world.store
                    .events(game.gameId, StreamType.SESSION)
                    .takeLast(2)
                    .map { it.payload }
            (tail[0] is SessionEvent.WeekCommitted) shouldBe true
            (tail[1] is SessionEvent.SessionEnded) shouldBe true
            outcome.versions.session?.value shouldBe 7
        }
    })
