package beergame.persistence

import arrow.core.raise.either
import beergame.application.AppFailure
import beergame.domain.Editor
import beergame.domain.GameEvent
import beergame.domain.Role
import beergame.domain.SessionEvent
import beergame.domain.StreamType
import beergame.domain.StreamVersion
import io.kotest.core.spec.style.FunSpec
import io.kotest.matchers.shouldBe
import io.kotest.matchers.types.shouldBeInstanceOf
import java.time.OffsetDateTime

private fun String.compactJson(): String = filterNot { it.isWhitespace() }

/** 同期投影の契約（追記と同じトランザクションで、投影の行を書く）。H2 と PostgreSQL の両方で実行する。 */
fun FunSpec.projectionContract(fixture: () -> Fixture) {
    projectedRowsContract(fixture)
    projectedStatesContract(fixture)
    continuationProjectionContract(fixture)
    replacedRoleProjectionContract(fixture)
    coHolderProjectionContract(fixture)
    projectedEndContract(fixture)
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
}

/** B5 の継続（停止・代理入力・資格）のイベントの投影。 */
private fun FunSpec.continuationProjectionContract(fixture: () -> Fixture) {
    test("[B5/4.7] Given 停止・代理入力・再開 When 投影を読む Then PAUSED を経て ACTIVE に戻り、代理入力は進行役の入力者で入る") {
        val fx = fixture()
        val script = GameScript().create()
        val players = script.joinAllRoles()
        script.startGame()
        script.save(players.getValue(Role.RETAILER), Role.RETAILER, 7)
        script.pause()
        val pausedId = script.gameId.value
        // 停止中の状態までを投影する
        fx.appendScript(script)

        fx.query("SELECT status, week, submitted_role_count FROM session_overview WHERE game_id = ?", pausedId) {
            Triple(it.getString(1), it.getInt(2), it.getInt(3))
        } shouldBe listOf(Triple("PAUSED", 1, 1))
        fx.query("SELECT status FROM game_overview WHERE game_id = ?", pausedId) { it.getString(1) } shouldBe
            listOf("STARTED")

        val second = GameScript().create()
        val secondPlayers = second.joinAllRoles()
        second
            .startGame()
            .pause()
            .proxy(Role.FACTORY, 6)
            .resume()
        fx.appendScript(second)
        val id = second.gameId.value
        secondPlayers.size shouldBe 4

        fx.query("SELECT status, week, submitted_role_count FROM session_overview WHERE game_id = ?", id) {
            Triple(it.getString(1), it.getInt(2), it.getInt(3))
        } shouldBe listOf(Triple("ACTIVE", 1, 1))
        fx.query(
            "SELECT role, quantity, decision_version, editor_kind, editor_id FROM current_decisions WHERE game_id = ?",
            id,
        ) {
            listOf(it.getString(1), it.getInt(2), it.getLong(3), it.getString(4), it.getString(5))
        } shouldBe listOf(listOf("FACTORY", 6, 1L, "FACILITATOR", id.toString()))
    }

    test("[B5/4.7][L5] Given 資格の失効のイベント When 投影する Then ロビー（lobby_participants）は変わらない（資格の状態の正本は credentials）") {
        val fx = fixture()
        val script = GameScript().create()
        val players = script.joinAllRoles()
        script.revoke(players.getValue(Role.RETAILER))
        fx.appendScript(script)
        val id = script.gameId.value

        fx.query("SELECT role FROM lobby_participants WHERE game_id = ? ORDER BY role", id) { it.getString(1) } shouldBe
            Role.entries.map { it.name }.sorted()
    }
}

/** 開始後の役割の入れ替えの投影（B5 Step 3.5・5.5。`lobby_participants.replaced_at`。Step 4 で保留した永続化の契約）。 */
private fun FunSpec.replacedRoleProjectionContract(fixture: () -> Fixture) {
    test(
        "[B5/5.5] Given 開始後に役割を入れ替えたゲーム When 投影を読む " +
            "Then 旧担当者の行は消えず role が NULL・replaced_at に入れ替えの時刻、新担当者は role を持ち replaced_at は NULL",
    ) {
        val fx = fixture()
        val script = GameScript().create()
        val players = script.joinAllRoles()
        val newcomer = script.join()
        script.startGame().replaceRoleHolder(newcomer, Role.RETAILER)
        fx.appendScript(script)
        val id = script.gameId.value
        val replacedAt = script.events.single { it.payload is GameEvent.ParticipantReplaced }.occurredAt

        val rows =
            fx.query("SELECT participant_id, role, replaced_at FROM lobby_participants WHERE game_id = ?", id) {
                Triple(
                    it.getString(1),
                    it.getString(2),
                    it.getObject(3, OffsetDateTime::class.java)?.toInstant(),
                )
            }

        rows.size shouldBe 5
        val old = players.getValue(Role.RETAILER).value.toString()
        rows.single { it.first == old } shouldBe Triple(old, null, replacedAt)
        rows.single { it.first == newcomer.value.toString() } shouldBe
            Triple(newcomer.value.toString(), Role.RETAILER.name, null)
        rows
            .filter { it.first != old && it.first != newcomer.value.toString() }
            .map { it.third } shouldBe listOf(null, null, null)
    }

    test("[B5/6.2] Given 開始後に役割を入れ替えたゲーム When 問い合わせ用の投影を読む Then 旧担当者だけが replaced で、役割は無い") {
        val fx = fixture()
        val script = GameScript().create()
        val players = script.joinAllRoles()
        val newcomer = script.join()
        script.startGame().replaceRoleHolder(newcomer, Role.RETAILER)
        fx.appendScript(script)

        val game =
            checkNotNull(
                fx.persistence.reader
                    .read(script.gameId)
                    .getOrNull(),
            )
        val replaced = game.participants.filter { it.replaced }

        replaced.map { it.participantId } shouldBe listOf(players.getValue(Role.RETAILER))
        replaced.single().role shouldBe null
        game.participants.single { it.participantId == newcomer }.role shouldBe Role.RETAILER
        game.participants.size shouldBe 5
    }
}

private fun FunSpec.coHolderProjectionContract(fixture: () -> Fixture) {
    test(
        "[B6/3.1c] Given 同じ役割に共同担当がいて、共同担当が保存した When 問い合わせ用の投影を読む " +
            "Then 入力の保存者（参加者）・保存の時刻（イベントの時刻）が読め、同じ役割の共同担当が参加の順に並ぶ",
    ) {
        val fx = fixture()
        val script = GameScript().create()
        val players = script.joinAllRoles()
        val first = script.join("花子")
        val second = script.join("次郎")
        script.assign(first, Role.RETAILER).assign(second, Role.RETAILER)
        script.startGame().save(second, Role.RETAILER, 9)
        fx.appendScript(script)
        val savedAt = script.events.last { it.payload is SessionEvent.DecisionSaved }.occurredAt

        val game =
            checkNotNull(
                fx.persistence.reader
                    .read(script.gameId)
                    .getOrNull(),
            )

        val decision = game.decisions.getValue(Role.RETAILER)
        decision.editor shouldBe Editor.ByParticipant(second)
        decision.savedAt shouldBe savedAt
        decision.quantity shouldBe 9
        // 表示名は周辺ストア（display_profiles）の結合で、この契約の台本（投影だけ）は書かない。結合は、application の流れの契約が確かめる
        game.participants.filter { it.role == Role.RETAILER }.map { it.participantId } shouldBe
            listOf(players.getValue(Role.RETAILER), first, second)
    }

    test("[B6/3.1c] Given 進行役の代理入力 When 問い合わせ用の投影を読む Then 入力の保存者は進行役（ゲームの識別子）で、保存の時刻が読める") {
        val fx = fixture()
        val script = GameScript().create()
        script.joinAllRoles()
        script.startGame().proxy(Role.FACTORY, 6)
        fx.appendScript(script)
        val savedAt = script.events.last { it.payload is SessionEvent.ProxyDecisionSubmitted }.occurredAt

        val game =
            checkNotNull(
                fx.persistence.reader
                    .read(script.gameId)
                    .getOrNull(),
            )

        val decision = game.decisions.getValue(Role.FACTORY)
        decision.editor shouldBe Editor.ByFacilitator(script.gameId)
        decision.savedAt shouldBe savedAt
    }
}

private fun FunSpec.projectedEndContract(fixture: () -> Fixture) {
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

    test("[B9] Given 確定した週・招待・観察者 When 観察者向けの表を読む Then チーム合計・招待・観察者が、同じトランザクションで書かれる") {
        val fx = fixture()
        val script = GameScript().create()
        val players = script.joinAllRoles()
        val invitation = script.invite()
        val observer = script.observerJoins(invitation)
        val other = script.invite()
        script.revokeInvitation(other)
        script.startGame().playWeek(players)
        fx.appendScript(script)
        val id = script.gameId.value

        fx.query("SELECT week, total_ordered, contributors FROM week_team_totals WHERE game_id = ?", id) {
            Triple(it.getInt(1), it.getInt(2), it.getInt(3))
        } shouldBe listOf(Triple(1, 16, 4))
        fx.query("SELECT invitation_id FROM lobby_observer_invitations WHERE game_id = ? AND revoked_at IS NULL", id) {
            it.getString(1)
        } shouldBe listOf(invitation.value.toString())
        fx.count("lobby_observer_invitations WHERE game_id = ? AND revoked_at IS NOT NULL", id) shouldBe 1
        fx.query("SELECT observer_id, invitation_id FROM lobby_observers WHERE game_id = ?", id) {
            it.getString(1) to it.getString(2)
        } shouldBe listOf(observer.value.toString() to invitation.value.toString())
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
