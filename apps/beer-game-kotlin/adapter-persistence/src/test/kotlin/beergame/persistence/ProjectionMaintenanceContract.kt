package beergame.persistence

import arrow.core.raise.either
import beergame.application.AppFailure
import beergame.application.Inconsistency
import beergame.domain.GameId
import beergame.domain.ProjectionTable
import beergame.domain.Role
import beergame.domain.StreamType
import beergame.domain.StreamVersion
import io.kotest.core.spec.style.FunSpec
import io.kotest.matchers.collections.shouldContain
import io.kotest.matchers.collections.shouldContainExactly
import io.kotest.matchers.collections.shouldNotBeEmpty
import io.kotest.matchers.comparables.shouldBeLessThan
import io.kotest.matchers.ints.shouldBeGreaterThan
import io.kotest.matchers.shouldBe
import io.kotest.matchers.types.shouldBeInstanceOf
import kotlin.system.measureTimeMillis

private const val LONG_GAME_WEEKS = 30
private const val SLOW_MILLIS = 10_000L

/**
 * 実際の運用に近い順で、台本のイベントを 1 件ずつ（別々のトランザクションで）追記し、同期投影で書く。
 * 再構築が、増分で書かれた投影と同じ行を作ることを確かめる入力になる。
 */
private suspend fun Fixture.appendLive(script: GameScript) {
    val versions = mutableMapOf<StreamType, StreamVersion>()
    script.events.forEach { event ->
        val expected = mapOf(event.streamType to (versions[event.streamType] ?: StreamVersion.ZERO))
        tx { tx ->
            either {
                val envelopes = persistence.events.append(tx, expected, listOf(event)).bind()
                persistence.projections.write(tx, script.gameId, envelopes).bind()
                envelopes
            }
        }.orFail().also { versions[event.streamType] = it.single().streamVersion }
    }
}

/** 観察者・資格の失効・停止と再開・代理入力・開始後の入れ替えを含む、通しのゲーム。 */
private fun playedGame(finalWeek: Int = 3): GameScript {
    val script = GameScript().create(finalWeek = finalWeek)
    val players = script.joinAllRoles()
    val invitation = script.invite()
    script.observerJoins(invitation)
    script.revokeInvitation(script.invite())
    val substitute = script.join("交代")
    script.startGame()
    script.playWeek(players)
    script.pause().resume()
    script.proxy(Role.FACTORY, 5)
    script.replaceRoleHolder(substitute, Role.RETAILER)
    script.revoke(players.getValue(Role.WHOLESALER))
    repeat(finalWeek - 1) { script.playWeek(players + (Role.RETAILER to substitute)) }
    return script
}

private fun Fixture.dump(id: GameId): Map<String, List<String>> =
    dataSource.connection.use { ProjectionDump.read(it, id).tables }

private fun Fixture.checkpoints(id: GameId): List<List<String>> =
    query(
        "SELECT stream_type, projected_version, CAST(updated_at AS VARCHAR) " +
            "FROM projection_checkpoints WHERE game_id = ? ORDER BY stream_type",
        id.value,
    ) { listOf(it.getString(1), it.getString(2), it.getString(3)) }

private fun Fixture.wipeProjection(id: GameId) {
    (ProjectionTable.entries.reversed().map { it.sqlName } + "projection_checkpoints").forEach {
        execute("DELETE FROM $it WHERE game_id = ?", id.value)
    }
}

/** 投影の再構築と整合の検査の契約（B12。NF-R15）。H2 と PostgreSQL の両方で同じ内容を実行する。 */
fun FunSpec.projectionMaintenanceContract(fixture: () -> Fixture) {
    rebuildMatchesLiveProjection(fixture)
    rebuildRestoresLostRows(fixture)
    verifyDetectsDrift(fixture)
    verifyDetectsStrayRows(fixture)
    verifyDetectsCheckpointDrift(fixture)
    rebuildFailureContract(fixture)
    rebuildLockContract(fixture)
}

private fun FunSpec.rebuildMatchesLiveProjection(fixture: () -> Fixture) {
    test("[B12/NF-R15] Given 増分で投影した通しのゲーム When 再構築する Then 全表の行が元と一致し、検査は不一致 0 件") {
        val fx = fixture()
        val script = playedGame()
        fx.appendLive(script)
        val id = script.gameId
        val before = fx.dump(id)
        val checkpointsBefore = fx.checkpoints(id)

        val outcome =
            fx.persistence.maintenance
                .rebuild(id)
                .orFail()

        outcome.changedRows shouldBe 0
        outcome.events shouldBe script.events.size
        outcome.rows shouldBeGreaterThan 0
        fx.dump(id) shouldBe before
        fx.checkpoints(id) shouldBe checkpointsBefore
        fx.persistence.maintenance
            .verify(id)
            .orFail() shouldBe emptyList()
        before.getValue("lobby_observers").shouldNotBeEmpty()
        before.getValue("retention_policies").shouldNotBeEmpty()
    }

    test("[B12/NF-R15] Given 投影をすべて失ったゲーム When 再構築する Then 元と同じ行に戻り、進んだ版の記録がイベントの最後の版と一致する") {
        val fx = fixture()
        val script = playedGame()
        fx.appendLive(script)
        val id = script.gameId
        val before = fx.dump(id)
        val checkpointsBefore = fx.checkpoints(id)
        fx.wipeProjection(id)
        fx.count("game_overview WHERE game_id = ?", id.value) shouldBe 0

        val outcome =
            fx.persistence.maintenance
                .rebuild(id)
                .orFail()

        outcome.changedRows shouldBeGreaterThan 0
        fx.dump(id) shouldBe before
        fx.checkpoints(id) shouldBe checkpointsBefore
        fx.query(
            "SELECT stream_type, MAX(stream_version) FROM events WHERE game_id = ? GROUP BY stream_type " +
                "ORDER BY stream_type",
            id.value,
        ) { listOf(it.getString(1), it.getString(2)) } shouldBe checkpointsBefore.map { it.take(2) }
    }
}

private fun FunSpec.rebuildRestoresLostRows(fixture: () -> Fixture) {
    test("[B12/B11] Given 保持方針の行が無いゲーム（保持の機能より前に作られた） When 再構築する Then 行が補われ、検査は不一致 0 件") {
        val fx = fixture()
        val script = playedGame()
        fx.appendLive(script)
        val id = script.gameId
        val before = fx.dump(id)
        fx.execute("DELETE FROM retention_policies WHERE game_id = ?", id.value)
        fx.dump(id).getValue("retention_policies") shouldBe emptyList()

        fx.persistence.maintenance
            .verify(id)
            .orFail() shouldContain
            Inconsistency.RowDrift("retention_policies", missing = 1, unexpected = 0)
        fx.persistence.maintenance
            .rebuild(id)
            .orFail()
            .changedRows shouldBe 1

        fx.dump(id) shouldBe before
        fx.persistence.maintenance
            .verify(id)
            .orFail() shouldBe emptyList()
    }

    test("[B12] Given 複数のゲーム When 一覧を読む Then すべてのゲームが重複なく返る") {
        val fx = fixture()
        val first = playedGame().also { fx.appendLive(it) }
        val second = GameScript().create().also { fx.appendLive(it) }

        val ids =
            fx.persistence.maintenance
                .games()
                .orFail()

        ids shouldContain first.gameId
        ids shouldContain second.gameId
        ids shouldBe ids.distinct()
    }
}

private fun FunSpec.verifyDetectsDrift(fixture: () -> Fixture) {
    test("[B12/NF-R15] Given 投影の行が壊れたゲーム When 検査する Then 表ごとの不一致を報告し、投影は変えない") {
        val fx = fixture()
        val script = playedGame()
        fx.appendLive(script)
        val id = script.gameId
        fx.execute("UPDATE game_overview SET retention_days = 7 WHERE game_id = ?", id.value)
        val broken = fx.dump(id)

        val findings =
            fx.persistence.maintenance
                .verify(id)
                .orFail()

        findings shouldContainExactly listOf(Inconsistency.RowDrift("game_overview", missing = 1, unexpected = 1))
        fx.dump(id) shouldBe broken
    }
}

private fun FunSpec.verifyDetectsStrayRows(fixture: () -> Fixture) {
    test("[B12/NF-R15] Given イベントに由来しない余分な行があるゲーム When 検査して再構築する Then 余分な行を報告し、再構築で消える") {
        val fx = fixture()
        val script = playedGame()
        fx.appendLive(script)
        val id = script.gameId
        val before = fx.dump(id)
        fx.execute(
            "INSERT INTO lobby_observer_invitations (invitation_id, game_id, expires_at, created_at) " +
                "VALUES (?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)",
            java.util.UUID.randomUUID(),
            id.value,
        )

        fx.persistence.maintenance
            .verify(id)
            .orFail() shouldBe
            listOf(Inconsistency.RowDrift("lobby_observer_invitations", missing = 0, unexpected = 1))
        fx.persistence.maintenance
            .rebuild(id)
            .orFail()
            .changedRows shouldBe 1

        fx.dump(id) shouldBe before
    }
}

private fun FunSpec.verifyDetectsCheckpointDrift(fixture: () -> Fixture) {
    test("[B12/NF-R15] Given 進んだ版の記録が戻ったゲーム When 検査する Then ストリームの版の食い違いを報告する") {
        val fx = fixture()
        val script = playedGame()
        fx.appendLive(script)
        val id = script.gameId
        val head = script.sessionEvents.size.toLong()
        fx.execute(
            "UPDATE projection_checkpoints SET projected_version = projected_version - 1 " +
                "WHERE game_id = ? AND stream_type = 'SESSION'",
            id.value,
        )

        val findings =
            fx.persistence.maintenance
                .verify(id)
                .orFail()

        findings shouldBe listOf(Inconsistency.CheckpointDrift(StreamType.SESSION, head - 1, head))
        fx.persistence.maintenance
            .rebuild(id)
            .orFail()
        fx.persistence.maintenance
            .verify(id)
            .orFail() shouldBe emptyList()
    }
}

private fun FunSpec.rebuildFailureContract(fixture: () -> Fixture) {
    test("[B12/NF-R16] Given 読めない版のイベントを含むゲーム When 再構築する Then 失敗し、投影は元のまま（取り消される）") {
        val fx = fixture()
        val script = playedGame()
        fx.appendLive(script)
        val id = script.gameId
        val before = fx.dump(id)
        val checkpointsBefore = fx.checkpoints(id)
        fx.execute("UPDATE events SET schema_version = 99 WHERE event_id = ?", script.sessionEvents.last().eventId)

        val result = fx.persistence.maintenance.rebuild(id)

        result.leftOrFail().shouldBeInstanceOf<AppFailure.Persistence>()
        fx.dump(id) shouldBe before
        fx.checkpoints(id) shouldBe checkpointsBefore
    }

    test("[B12/NF-P18] Given 最終週が長いゲーム When 再構築する Then 一致し、時間を記録する（極端な遅さだけ失敗）") {
        val fx = fixture()
        val script = playedGame(LONG_GAME_WEEKS)
        fx.appendLive(script)
        val id = script.gameId
        val before = fx.dump(id)

        val millis =
            measureTimeMillis {
                fx.persistence.maintenance
                    .rebuild(id)
                    .orFail()
            }

        System.err.println("[B12/NF-P18] ${fx.dialect}: ${script.events.size} 件のイベントの再構築 $millis ミリ秒")
        fx.dump(id) shouldBe before
        millis shouldBeLessThan SLOW_MILLIS
    }
}

private fun FunSpec.rebuildLockContract(fixture: () -> Fixture) {
    test("[B12/M23] Given コマンドが共有ロックを持つ間 When 再構築する Then 待ちの上限で失敗し、投影は元のまま") {
        val fx = fixture()
        val script = playedGame()
        fx.appendLive(script)
        val id = script.gameId
        val before = fx.dump(id)
        fx.execute("DELETE FROM retention_policies WHERE game_id = ?", id.value)
        val broken = fx.dump(id)

        val rebuilt =
            fx
                .tx { tx ->
                    either {
                        fx.persistence.lock
                            .acquireShared(tx, id)
                            .bind()
                        fx.persistence.maintenance.rebuild(id)
                    }
                }.orFail()

        rebuilt.leftOrFail() shouldBe AppFailure.RetryExhausted
        fx.dump(id) shouldBe broken
        fx.persistence.maintenance
            .rebuild(id)
            .orFail()
        fx.dump(id) shouldBe before
    }
}
