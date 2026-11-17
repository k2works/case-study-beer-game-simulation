package beergame.persistence

import beergame.application.DeletionReceipt
import beergame.application.DueDeletion
import beergame.application.RetentionStore
import beergame.domain.GameId
import beergame.domain.RetentionEvent
import beergame.domain.RetentionSaga
import beergame.domain.RetentionState
import io.kotest.core.spec.style.FunSpec
import io.kotest.matchers.collections.shouldContainAll
import io.kotest.matchers.shouldBe
import java.time.Duration
import java.time.Instant
import java.util.UUID

/** 台本（[GameScript]）の作成時刻（2026-11-14T09:00:00Z）+ 90 日。 */
private val DELETE_AFTER: Instant = Instant.parse("2027-02-12T09:00:00Z")
private val DIGEST: String = "a".repeat(64)

private fun receipt(
    deletionId: UUID,
    at: Instant,
    digest: String = DIGEST,
) = DeletionReceipt(deletionId, digest, at, at.plus(Duration.ofDays(365)))

private fun started(
    attempt: Int,
    at: Instant,
) = RetentionEvent.DeletionStarted(attempt, at, at.plus(RetentionSaga.LEASE))

/** 終了済みのゲーム（全役割・全週の記録がある）を作り、投影まで書く。 */
private suspend fun Fixture.playedGame(): GameScript {
    val script = GameScript().create(finalWeek = 2)
    val players = script.joinAllRoles()
    script.startGame().playWeek(players)
    appendScript(script)
    return script
}

/** `game_id` 列を持つ全表（`information_schema` から取得する。表の一覧を手で持たない）。 */
private fun Fixture.tablesWithGameId(): List<String> =
    query(
        "SELECT DISTINCT table_name FROM information_schema.columns " +
            "WHERE column_name = 'game_id' AND LOWER(table_schema) = 'public' ORDER BY table_name",
    ) { it.getString(1) }

private fun Fixture.rowCounts(gameId: GameId): Map<String, Int> =
    tablesWithGameId().associateWith { count("$it WHERE game_id = ?", gameId.value) }

/** 保持と削除の永続化の契約（B11。AC5.1.2〜5.1.4）。H2 と PostgreSQL の両方で同じ内容を実行する。 */
fun FunSpec.retentionContract(fixture: () -> Fixture) {
    policyContract(fixture)
    dueContract(fixture)
    cascadeCompletenessContract(fixture)
    atomicDeleteContract(fixture)
    failureRecordContract(fixture)
    receiptPurgeContract(fixture)
}

private fun FunSpec.policyContract(fixture: () -> Fixture) {
    test("[B11/AC5.1.1] Given 作成したゲーム When 投影を読む Then 保持方針（日数・起点・期限）が、読み取りの型に載る") {
        val fx = fixture()
        val script = fx.playedGame()

        val retention =
            fx.persistence.reader
                .read(script.gameId)
                .orFail()
                ?.retention

        retention?.retentionDays shouldBe 90
        retention?.startsAt shouldBe Instant.parse("2026-11-14T09:00:00Z")
        retention?.deleteAfter shouldBe DELETE_AFTER
        retention?.run shouldBe null
    }
}

private fun FunSpec.dueContract(fixture: () -> Fixture) {
    test("[B11/AC5.1.2] Given 保持期限のあるゲーム When 期限の前後で検出する Then 期限に達してから、未着手の対象として返る") {
        val fx = fixture()
        val store = retentionStore(fx.dataSource)
        val script = fx.playedGame()

        fx.dueIds(store, DELETE_AFTER.minusSeconds(1)).contains(script.gameId) shouldBe false
        val due = store.due(DELETE_AFTER, 1000).orFail().first { it.gameId == script.gameId }
        due shouldBe DueDeletion(script.gameId, null, RetentionState.Pending)
    }

    test("[B11/AC5.1.3] Given 試行の開始を記録した When 貸出の期限の前後で検出する Then 期限を過ぎるまで返らず、過ぎると試行中として返る") {
        val fx = fixture()
        val store = retentionStore(fx.dataSource)
        val script = fx.playedGame()
        val id = UUID.randomUUID()
        val event = started(1, DELETE_AFTER)
        store.begin(script.gameId, id, event).orFail()

        fx.dueIds(store, event.leaseUntil.minusSeconds(1)).contains(script.gameId) shouldBe false
        store.due(event.leaseUntil, 1000).orFail().first { it.gameId == script.gameId } shouldBe
            DueDeletion(script.gameId, id, RetentionState.InProgress(1, event.leaseUntil))
        val run =
            fx.persistence.reader
                .read(script.gameId)
                .orFail()
                ?.retention
                ?.run
        run?.status shouldBe "IN_PROGRESS"
        run?.attempt shouldBe 1
    }
}

private suspend fun Fixture.dueIds(
    store: RetentionStore,
    at: Instant,
): List<GameId> = store.due(at, 1000).orFail().map { it.gameId }

private fun FunSpec.cascadeCompletenessContract(fixture: () -> Fixture) {
    test("[B11/AC5.1.4] Given 全表に行のあるゲームと、別のゲーム When 削除する Then game_id を持つ全表から当該ゲームの行が消え、別のゲームは残る") {
        val fx = fixture()
        val store = retentionStore(fx.dataSource)
        val target = fx.playedGame()
        val other = fx.playedGame()
        val id = UUID.randomUUID()
        store.begin(target.gameId, id, started(1, DELETE_AFTER)).orFail()
        fx.rowCounts(target.gameId).filterValues { it > 0 }.keys shouldContainAll
            listOf("events", "game_overview", "retention_policies", "week_role_results", "deletion_runs")
        val otherBefore = fx.rowCounts(other.gameId)

        store.delete(target.gameId, receipt(id, DELETE_AFTER)).orFail()

        // 検査の対象の表が、期待する表を含む（空の一覧を「残らない」と誤って判定しない）
        fx.tablesWithGameId() shouldContainAll
            listOf("events", "game_overview", "retention_policies", "week_role_results", "deletion_runs", "credentials")
        fx.rowCounts(target.gameId).filterValues { it != 0 } shouldBe emptyMap()
        fx.rowCounts(other.gameId) shouldBe otherBefore
        fx.count("deletion_attempts WHERE deletion_id = ?", id) shouldBe 0
        fx.count("deletion_receipts WHERE deletion_id = ?", id) shouldBe 1
        fx.query(
            "SELECT game_reference_digest FROM deletion_receipts WHERE deletion_id = ?",
            id,
        ) { it.getString(1) } shouldBe
            listOf(DIGEST)
        fx.persistence.reader
            .read(target.gameId)
            .orFail() shouldBe null
    }
}

private fun FunSpec.atomicDeleteContract(fixture: () -> Fixture) {
    test("[B11/AC5.1.3] Given 削除の途中で失敗する（受領記録が制約に違反する） When 削除する Then 全体を取り消し、半分の状態を残さない") {
        val fx = fixture()
        val store = retentionStore(fx.dataSource)
        val script = fx.playedGame()
        val id = UUID.randomUUID()
        store.begin(script.gameId, id, started(1, DELETE_AFTER)).orFail()
        val before = fx.rowCounts(script.gameId)

        val result = store.delete(script.gameId, receipt(id, DELETE_AFTER, digest = "short"))

        result.isLeft() shouldBe true
        fx.rowCounts(script.gameId) shouldBe before
        fx.count("deletion_receipts WHERE deletion_id = ?", id) shouldBe 0
    }
}

private fun FunSpec.failureRecordContract(fixture: () -> Fixture) {
    test("[B11/AC5.1.3] Given 失敗を記録した When 検出する Then 次の試行の時刻まで返らず、時刻を過ぎると再試行待ちとして返る。やめた状態は返らない") {
        val fx = fixture()
        val store = retentionStore(fx.dataSource)
        val script = fx.playedGame()
        val id = UUID.randomUUID()
        store.begin(script.gameId, id, started(1, DELETE_AFTER)).orFail()
        val next = DELETE_AFTER.plus(Duration.ofMinutes(5))
        store.fail(id, RetentionEvent.DeletionFailed(1, "persistence.retention.delete", next)).orFail()

        fx.dueIds(store, next.minusSeconds(1)).contains(script.gameId) shouldBe false
        store.due(next, 1000).orFail().first { it.gameId == script.gameId } shouldBe
            DueDeletion(script.gameId, id, RetentionState.Failed(1, next, "persistence.retention.delete"))
        val run =
            fx.persistence.reader
                .read(script.gameId)
                .orFail()
                ?.retention
                ?.run
        run?.status shouldBe "FAILED"
        run?.nextAttemptAt shouldBe next
        run?.lastFailureCode shouldBe "persistence.retention.delete"
        fx.query("SELECT failure_code FROM deletion_attempts WHERE deletion_id = ? AND attempt = 1", id) {
            it.getString(1)
        } shouldBe
            listOf("persistence.retention.delete")

        // 2 回目の試行（同じ進行の行を更新し、試行の履歴を足す）の後、再試行をやめる
        store.begin(script.gameId, id, started(2, next)).orFail()
        fx.count("deletion_attempts WHERE deletion_id = ?", id) shouldBe 2
        store.fail(id, RetentionEvent.DeletionFailed(2, "x", null)).orFail()

        fx.dueIds(store, next.plus(Duration.ofDays(365))).contains(script.gameId) shouldBe false
        fx.persistence.reader
            .read(script.gameId)
            .orFail()
            ?.retention
            ?.run
            ?.nextAttemptAt shouldBe null
        fx.count("deletion_runs WHERE game_id = ?", script.gameId.value) shouldBe 1
    }
}

private fun FunSpec.receiptPurgeContract(fixture: () -> Fixture) {
    test("[B11/AC5.1.2] Given 期限切れの受領記録 When 掃除する Then 期限を過ぎたものだけ消える") {
        val fx = fixture()
        val store = retentionStore(fx.dataSource)
        val script = fx.playedGame()
        val id = UUID.randomUUID()
        store.begin(script.gameId, id, started(1, DELETE_AFTER)).orFail()
        store.delete(script.gameId, receipt(id, DELETE_AFTER)).orFail()
        val expiresAt = DELETE_AFTER.plus(Duration.ofDays(365))

        store.purgeReceipts(expiresAt.minusSeconds(1)).orFail()
        fx.count("deletion_receipts WHERE deletion_id = ?", id) shouldBe 1
        (store.purgeReceipts(expiresAt).orFail() >= 1) shouldBe true
        fx.count("deletion_receipts WHERE deletion_id = ?", id) shouldBe 0
    }
}
