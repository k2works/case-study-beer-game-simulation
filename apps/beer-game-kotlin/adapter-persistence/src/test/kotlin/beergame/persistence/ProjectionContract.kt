package beergame.persistence

import arrow.core.raise.either
import beergame.application.AppFailure
import beergame.domain.Role
import beergame.domain.StreamType
import beergame.domain.StreamVersion
import io.kotest.core.spec.style.FunSpec
import io.kotest.matchers.shouldBe
import io.kotest.matchers.types.shouldBeInstanceOf

private fun String.compactJson(): String = filterNot { it.isWhitespace() }

/** 同期投影の契約（追記と同じトランザクションで、投影の行を書く）。H2 と PostgreSQL の両方で実行する。 */
fun FunSpec.projectionContract(fixture: () -> Fixture) {
    projectedRowsContract(fixture)
    projectedStatesContract(fixture)
    checkpointContract(fixture)
    projectionRollbackContract(fixture)
    projectionFailureContract(fixture)
}

private fun FunSpec.projectedRowsContract(fixture: () -> Fixture) {
    test("[7.2] Given 1 週を確定したゲーム When 同期投影を読む Then 設計の表に、設計の行が書かれている") {
        val fx = fixture()
        val script = GameScript().create(joinCode = "JOINCODE-0001", finalWeek = 3)
        val players = script.joinAllRoles()
        script.startGame().playWeek(players)
        fx.appendScript(script)
        val id = script.gameId.value

        fx.query(
            "SELECT status, final_week, commit_mode, settings_kind, retention_days " +
                "FROM game_overview WHERE game_id = ?",
            id,
        ) {
            listOf(it.getString(1), it.getInt(2), it.getString(3), it.getString(4), it.getInt(5))
        } shouldBe listOf(listOf("STARTED", 3, "MANUAL", "KIT", 90))
        fx.query("SELECT join_code FROM game_join_codes WHERE game_id = ?", id) { it.getString(1) } shouldBe
            listOf("JOINCODE-0001")
        fx.query("SELECT demand, holding_cost_minor, backlog_cost_minor FROM game_settings WHERE game_id = ?", id) {
            Triple(it.getString(1).compactJson(), it.getLong(2), it.getLong(3))
        } shouldBe listOf(Triple("[4,5,6]", 50L, 100L))
        fx.query("SELECT role FROM lobby_participants WHERE game_id = ? ORDER BY role", id) { it.getString(1) } shouldBe
            Role.entries.map { it.name }.sorted()
        fx.query("SELECT status, week, submitted_role_count FROM session_overview WHERE game_id = ?", id) {
            Triple(it.getString(1), it.getInt(2), it.getInt(3))
        } shouldBe listOf(Triple("ACTIVE", 2, 0))
        fx.count("role_current_states WHERE game_id = ? AND as_of_week = 2", id) shouldBe 4
        fx.count("current_decisions WHERE game_id = ?", id) shouldBe 0
        fx.query("SELECT week, commit_kind, contributors FROM week_commits WHERE game_id = ?", id) {
            Triple(it.getInt(1), it.getString(2), it.getInt(3))
        } shouldBe listOf(Triple(1, "MANUAL", 4))
        fx.query(
            "SELECT SUM(ordered) FROM week_role_results WHERE game_id = ? AND week = 1",
            id,
        ) { it.getInt(1) } shouldBe
            listOf(16)
        fx.count("week_role_results WHERE game_id = ?", id) shouldBe 4
    }
}

private fun FunSpec.projectedStatesContract(fixture: () -> Fixture) {
    test("[7.2] Given 入力を保存した週の途中 When 投影を読む Then current_decisions と入力済みの役割数が出る") {
        val fx = fixture()
        val script = GameScript().create()
        val players = script.joinAllRoles()
        script.startGame()
        script.save(players.getValue(Role.RETAILER), Role.RETAILER, 7)
        script.save(players.getValue(Role.FACTORY), Role.FACTORY, 3)
        fx.appendScript(script)
        val id = script.gameId.value

        fx.query(
            "SELECT role, quantity, decision_version, editor_kind " +
                "FROM current_decisions WHERE game_id = ? ORDER BY role",
            id,
        ) {
            listOf(it.getString(1), it.getInt(2), it.getLong(3), it.getString(4))
        } shouldBe listOf(listOf("FACTORY", 3, 1L, "PARTICIPANT"), listOf("RETAILER", 7, 1L, "PARTICIPANT"))
        fx.query("SELECT submitted_role_count FROM session_overview WHERE game_id = ?", id) { it.getInt(1) } shouldBe
            listOf(2)
    }

    test("[7.2] Given 最終週の確定 When 投影を読む Then セッションもゲームも ENDED") {
        val fx = fixture()
        val script = GameScript().create(finalWeek = 1)
        val players = script.joinAllRoles()
        script.startGame().playWeek(players)
        fx.appendScript(script)
        val id = script.gameId.value

        fx.query("SELECT status FROM session_overview WHERE game_id = ?", id) { it.getString(1) } shouldBe
            listOf("ENDED")
        fx.query("SELECT status FROM game_overview WHERE game_id = ?", id) { it.getString(1) } shouldBe listOf("ENDED")
    }

    test("[7.2] 判断項目 #12 Given 確定した週 When 観察者向けの表を読む Then B1 は書かない（表は作るが、書き込みは B9 まで省く）") {
        val fx = fixture()
        val script = GameScript().create()
        val players = script.joinAllRoles()
        script.startGame().playWeek(players)
        fx.appendScript(script)
        val id = script.gameId.value

        fx.count("week_team_totals WHERE game_id = ?", id) shouldBe 0
        fx.count("lobby_observer_invitations WHERE game_id = ?", id) shouldBe 0
        fx.count("lobby_observers WHERE game_id = ?", id) shouldBe 0
    }
}

private fun FunSpec.checkpointContract(fixture: () -> Fixture) {
    test("[7.2] Given 追記した版 When 投影のチェックポイントを読む Then ストリームごとの最後の版と一致する") {
        val fx = fixture()
        val script = GameScript().create()
        val players = script.joinAllRoles()
        script.startGame().playWeek(players)
        fx.appendScript(script)
        val id = script.gameId.value

        StreamType.entries.forEach { stream ->
            val maxVersion =
                fx.query(
                    "SELECT MAX(stream_version) FROM events WHERE game_id = ? AND stream_type = ?",
                    id,
                    stream.name,
                ) {
                    it.getLong(1)
                }
            val checkpoint =
                fx.query(
                    "SELECT projected_version FROM projection_checkpoints WHERE game_id = ? AND stream_type = ?",
                    id,
                    stream.name,
                ) {
                    it.getLong(1)
                }
            checkpoint shouldBe maxVersion
        }
    }
}

private fun FunSpec.projectionRollbackContract(fixture: () -> Fixture) {
    test("[7.2] Given 追記と投影を終えた後 When Left を返す Then イベントも投影の行も取り消される") {
        val fx = fixture()
        val script = GameScript().create()
        script.joinAllRoles()

        val result =
            fx.tx { tx ->
                either<AppFailure, Unit> {
                    val envelopes =
                        fx.persistence.events
                            .append(
                                tx,
                                mapOf(StreamType.GAME to StreamVersion.ZERO),
                                script.gameEvents,
                            ).bind()
                    fx.persistence.projections
                        .write(tx, script.gameId, envelopes)
                        .bind()
                    raise(AppFailure.Unauthorized)
                }
            }

        result.leftOrFail() shouldBe AppFailure.Unauthorized
        val id = script.gameId.value
        listOf(
            "events",
            "game_overview",
            "game_join_codes",
            "lobby_participants",
            "projection_checkpoints",
            "game_roots",
        ).forEach {
            fx.count("$it WHERE game_id = ?", id) shouldBe 0
        }
    }
}

private fun FunSpec.projectionFailureContract(fixture: () -> Fixture) {
    test("[7.2] Given 設計に無い一意制約の違反（参加コードの重複）When 投影を書く Then Persistence の失敗で、追記も取り消される") {
        val fx = fixture()
        val first = GameScript().create(joinCode = "DUPLICATE-CODE-1")
        fx.appendScript(first)
        val second = GameScript().create(joinCode = "DUPLICATE-CODE-1")

        val result =
            fx.tx { tx ->
                either<AppFailure, Unit> {
                    val envelopes =
                        fx.persistence.events
                            .append(
                                tx,
                                mapOf(StreamType.GAME to StreamVersion.ZERO),
                                second.gameEvents,
                            ).bind()
                    fx.persistence.projections
                        .write(tx, second.gameId, envelopes)
                        .bind()
                }
            }

        result.leftOrFail().shouldBeInstanceOf<AppFailure.Persistence>()
        fx.count("events WHERE game_id = ?", second.gameId.value) shouldBe 0
    }
}
