package beergame.persistence

import arrow.core.raise.either
import beergame.application.AppFailure
import beergame.application.NewEvent
import beergame.domain.DomainEvent
import beergame.domain.EventEnvelope
import beergame.domain.GameEvent
import beergame.domain.SessionEvent
import beergame.domain.StreamType
import beergame.domain.StreamVersion
import com.zaxxer.hikari.HikariDataSource
import io.kotest.core.spec.style.FunSpec
import io.kotest.matchers.collections.shouldContainExactly
import io.kotest.matchers.shouldBe
import io.kotest.matchers.types.shouldBeInstanceOf
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch
import java.util.UUID

/** 台本のイベントを、ストリームの版 0 から、追記と投影（任意）まで 1 つのトランザクションで書く。 */
suspend fun Fixture.appendScript(
    script: GameScript,
    project: Boolean = true,
): List<EventEnvelope<DomainEvent>> =
    tx { tx ->
        either {
            val expected =
                script.events
                    .map { it.streamType }
                    .distinct()
                    .associateWith { StreamVersion.ZERO }
            val envelopes = persistence.events.append(tx, expected, script.events).bind()
            if (project) persistence.projections.write(tx, script.gameId, envelopes).bind()
            envelopes
        }
    }.orFail()

suspend fun Fixture.readStream(
    script: GameScript,
    stream: StreamType,
) = tx { tx -> persistence.events.read(tx, script.gameId, stream) }.orFail()

private fun NewEvent.matches(e: EventEnvelope<DomainEvent>): Boolean =
    e.eventId == eventId && e.gameId == gameId && e.streamType == streamType && e.payload == payload &&
        e.actor == actor && e.correlationId == correlationId && e.commandId == commandId && e.occurredAt == occurredAt

/** イベントストアの契約（`EventStore`）。H2 と PostgreSQL の両方で同じ内容を実行する。 */
fun FunSpec.eventStoreContract(fixture: () -> Fixture) {
    appendContract(fixture)
    rollbackContract(fixture)
    startGameContract(fixture)
    doubleStartContract(fixture)
    cascadeContract(fixture)
}

private fun FunSpec.appendContract(fixture: () -> Fixture) {
    test("[7.1] Given 追記したイベント When 読み込む Then ストリームの版の順に、欠番なく、封筒の値ごと往復する") {
        val fx = fixture()
        val script = GameScript().create()
        script.joinAllRoles()
        val appended = fx.appendScript(script, project = false)

        val read = fx.readStream(script, StreamType.GAME)

        read.events.map { it.streamVersion.value } shouldContainExactly (1L..script.gameEvents.size).toList()
        read.version.value shouldBe script.gameEvents.size.toLong()
        script.gameEvents.zip(read.events).all { (sent, got) -> sent.matches(got) } shouldBe true
        appended.map { it.streamVersion } shouldContainExactly appended.map { it.streamVersion }.sortedBy { it.value }
        read.events.all { it.schemaVersion == 1 } shouldBe true
    }

    test("[7.1] Given 同じ版を期待する 2 つの追記 When 2 つ目を追記する Then ConcurrencyConflict で、1 つ目の結果だけが残る") {
        val fx = fixture()
        val script = GameScript().create()
        fx.appendScript(script, project = false)
        script.join()
        val first = script.gameEvents.drop(1)
        val second = first.map { it.copy(eventId = UUID.randomUUID()) }
        val afterCreate = mapOf(StreamType.GAME to StreamVersion.of(1).orFail())
        fx.tx { tx -> fx.persistence.events.append(tx, afterCreate, first) }.orFail()

        val result = fx.tx { tx -> fx.persistence.events.append(tx, afterCreate, second) }

        result.leftOrFail() shouldBe AppFailure.ConcurrencyConflict
        fx.readStream(script, StreamType.GAME).events.size shouldBe 2
    }
}

private fun FunSpec.rollbackContract(fixture: () -> Fixture) {
    test("[7.1] Given 追記と投影の後 When Left を返す Then ROLLBACK され、イベントも根（game_roots）も残らない") {
        val fx = fixture()
        val script = GameScript().create()

        val result =
            fx.tx { tx ->
                either<AppFailure, Unit> {
                    fx.persistence.events
                        .append(
                            tx,
                            mapOf(StreamType.GAME to StreamVersion.ZERO),
                            script.gameEvents,
                        ).bind()
                    raise(AppFailure.Unauthorized)
                }
            }

        result.leftOrFail() shouldBe AppFailure.Unauthorized
        fx.count("events WHERE game_id = ?", script.gameId.value) shouldBe 0
        fx.count("game_roots WHERE game_id = ?", script.gameId.value) shouldBe 0
    }

    test("[7.1] Given 期待する版が無いストリームのイベント When 追記する Then Persistence の失敗で、何も残らない") {
        val fx = fixture()
        val script = GameScript().create()
        script.joinAllRoles()
        script.startGame()

        val result =
            fx.tx { tx ->
                fx.persistence.events.append(tx, mapOf(StreamType.GAME to StreamVersion.ZERO), script.events)
            }

        result.leftOrFail().shouldBeInstanceOf<AppFailure.Persistence>()
        fx.count("events WHERE game_id = ?", script.gameId.value) shouldBe 0
    }
}

private fun FunSpec.startGameContract(fixture: () -> Fixture) {
    test("[7.1] Given 準備済みのゲーム When startGame の 2 ストリームを 1 回で追記する Then 両方が読める（原子的）") {
        val fx = fixture()
        val script = GameScript().create()
        script.joinAllRoles()
        val prepared = script.gameEvents.size
        fx.appendScript(script, project = false)
        val startScript = script.startGame()
        val start = startScript.events.drop(prepared)

        fx
            .tx { tx ->
                fx.persistence.events.append(
                    tx,
                    mapOf(
                        StreamType.GAME to StreamVersion.of(prepared.toLong()).orFail(),
                        StreamType.SESSION to StreamVersion.ZERO,
                    ),
                    start,
                )
            }.orFail()

        fx
            .readStream(script, StreamType.GAME)
            .events
            .last()
            .payload
            .shouldBeInstanceOf<GameEvent.GameStarted>()
        fx
            .readStream(
                script,
                StreamType.SESSION,
            ).events
            .single()
            .payload
            .shouldBeInstanceOf<SessionEvent.SessionStarted>()
    }
}

private fun FunSpec.doubleStartContract(fixture: () -> Fixture) {
    test("[7.1] Given SESSION の版 1 が既にある When startGame を追記する Then 片方の失敗で GAME 側も残らない（二重の開始の原子性）") {
        val fx = fixture()
        val script = GameScript().create()
        script.joinAllRoles()
        val prepared = script.gameEvents.size
        fx.appendScript(script, project = false)
        script.startGame()
        val start = script.events.drop(prepared)
        val sessionStarted = start.filter { it.streamType == StreamType.SESSION }
        fx
            .tx { tx ->
                fx.persistence.events.append(tx, mapOf(StreamType.SESSION to StreamVersion.ZERO), sessionStarted)
            }.orFail()
        val gameVersion = StreamVersion.of(prepared.toLong()).orFail()

        val result =
            fx.tx { tx ->
                fx.persistence.events.append(
                    tx,
                    mapOf(StreamType.GAME to gameVersion, StreamType.SESSION to StreamVersion.ZERO),
                    start.map { it.copy(eventId = UUID.randomUUID()) },
                )
            }

        result.leftOrFail() shouldBe AppFailure.ConcurrencyConflict
        fx.readStream(script, StreamType.GAME).version shouldBe gameVersion
        fx.count("events WHERE game_id = ? AND event_type = 'GameStarted'", script.gameId.value) shouldBe 0
    }
}

private fun FunSpec.cascadeContract(fixture: () -> Fixture) {
    test("[7.1] Given 追記と投影を終えたゲーム When game_roots を削除する Then 連鎖して、どの表にも行が残らない（ON DELETE CASCADE）") {
        val fx = fixture()
        val script = GameScript().create(finalWeek = 2)
        val players = script.joinAllRoles()
        script.startGame().playWeek(players)
        fx.appendScript(script)
        val id = script.gameId.value
        fx.count("events WHERE game_id = ?", id) shouldBe script.events.size

        fx.execute("DELETE FROM game_roots WHERE game_id = ?", id)

        val tables =
            listOf(
                "events",
                "projection_checkpoints",
                "game_overview",
                "game_join_codes",
                "game_settings",
                "lobby_participants",
                "session_overview",
                "role_current_states",
                "current_decisions",
                "week_commits",
                "week_role_results",
                "week_team_totals",
                "idempotency_records",
            )
        tables.associateWith { fx.count("$it WHERE game_id = ?", id) }.filterValues { it != 0 } shouldBe emptyMap()
    }
}

/** トランザクションの意味論の契約（キャンセルされても、トランザクションは必ず閉じる）。 */
fun FunSpec.transactionContract(fixture: () -> Fixture) {
    test("[7.1] Given 追記の途中 When コルーチンがキャンセルされる Then ROLLBACK され、接続はプールへ戻る（NonCancellable）") {
        val fx = fixture()
        val script = GameScript().create()
        val started = CompletableDeferred<Unit>()
        val pool = fx.dataSource as HikariDataSource

        coroutineScope {
            val job =
                launch {
                    fx.tx { tx ->
                        either<AppFailure, Unit> {
                            val expected = mapOf(StreamType.GAME to StreamVersion.ZERO)
                            fx.persistence.events
                                .append(tx, expected, script.gameEvents)
                                .bind()
                            started.complete(Unit)
                            awaitCancellation()
                        }
                    }
                }
            started.await()
            job.cancelAndJoin()
        }

        fx.count("events WHERE game_id = ?", script.gameId.value) shouldBe 0
        fx.count("game_roots WHERE game_id = ?", script.gameId.value) shouldBe 0
        pool.hikariPoolMXBean.activeConnections shouldBe 0
    }
}
