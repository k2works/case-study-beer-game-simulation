package beergame.acceptance

import io.cucumber.java.en.Given
import io.cucumber.java.en.Then
import io.cucumber.java.en.When
import java.time.Duration
import java.time.Instant

private const val HTTP_OK = 200
private const val HTTP_FORBIDDEN = 403
private const val CREATION_TOLERANCE_MINUTES = 5L
private const val DIGEST_LENGTH = 64

/** 画面の言葉（「予定」など）と、API の状態の値。 */
private val STATUS_LABELS =
    mapOf(
        "予定" to "SCHEDULED",
        "削除中" to "IN_PROGRESS",
        "再試行待ち" to "RETRY_PENDING",
        "再試行の上限に達した" to "ABANDONED",
    )

private fun retentionBody(
    days: Int?,
    finalWeek: Int = FINAL_WEEK,
): String {
    val base = kitGameBody(finalWeek, DEMAND_SERIES.take(finalWeek))
    return days?.let { base.dropLast(1) + ""","retentionDays":$it}""" } ?: base
}

/** 保持と削除（US5.1）のステップ定義。薄く保つ。時間の経過は、削除の処理に渡す時計を進めて表す。 */
class RetentionSteps {
    private val ctx get() = Scenario.current

    /** 直近に確かめた、受領記録の件数（「増える」「増えない」の基準）。 */
    private var knownReceipts: Int? = null

    private fun receipts(): List<String> = ctx.app.receiptDigests()

    /** ゲームの作成のときに控えた件数（共有の DB には、前のシナリオの受領記録がある）。 */
    private fun baseline(): Int = checkNotNull(knownReceipts) { "ゲームの作成の前に、受領記録を確かめようとした" }

    // ---- 作成 ----

    @Given("進行役が、保持期間を指定せずにキット準拠のゲームを作成している")
    fun createdWithoutRetention() = create(null)

    @Given("進行役が、保持期間 {int} 日でキット準拠のゲームを作成している")
    fun createdWithRetention(days: Int) = create(days)

    @Given("進行役が、最終週 {int} のキット準拠のゲームを保持期間 {int} 日で作成している")
    fun createdWithFinalWeekAndRetention(
        finalWeek: Int,
        days: Int,
    ) = create(days, finalWeek)

    @Given("もう 1 つ、保持期間 {int} 日のキット準拠のゲームが作成されている")
    fun anotherCreated(days: Int) = create(days)

    private fun create(
        days: Int?,
        finalWeek: Int = FINAL_WEEK,
    ) {
        knownReceipts = receipts().size
        val response = ctx.createGame(retentionBody(days, finalWeek))
        expect(response.status == ScenarioContext.HTTP_CREATED) { "作成できない: ${response.status} ${response.text}" }
    }

    @Given("参加者が参加している")
    fun participantJoined() {
        ctx.join(ctx.game, "参加者A")
    }

    // ---- 削除の処理 ----

    @Given("削除の処理が、最初の 1 回だけ失敗する")
    fun failOnce() = ctx.app.retention.failNext(1)

    @Given("削除の処理が、{int} 回続けて失敗する")
    fun failTimes(times: Int) = ctx.app.retention.failNext(times)

    @When("時計が {int} 日進み、削除処理が行われる")
    fun daysPassAndSweep(days: Int) {
        ctx.app.retention.advance(Duration.ofDays(days.toLong()))
        ctx.app.retention.sweep()
    }

    @When("時計が {int} 分進み、削除処理が行われる")
    fun minutesPassAndSweep(minutes: Int) {
        ctx.app.retention.advance(Duration.ofMinutes(minutes.toLong()))
        ctx.app.retention.sweep()
    }

    @When("時計が {int} 日進み、削除処理を、再試行の時刻ごとに {int} 回行う")
    fun repeatedSweeps(
        days: Int,
        times: Int,
    ) {
        ctx.app.retention.advance(Duration.ofDays(days.toLong()))
        repeat(times) { index ->
            // 2 回目以降は、前の試行のバックオフ（最大 80 分）を過ぎるまで進める
            if (index > 0) ctx.app.retention.advance(Duration.ofDays(1))
            ctx.app.retention.sweep()
        }
    }

    @Then("削除は {int} 件完了している")
    fun completed(count: Int) {
        val actual = ctx.app.retention.last.completed.size
        expect(actual == count) { "完了した削除が $count 件ではない: $actual" }
    }

    @Then("削除をやめたゲームが {int} 件通知される")
    fun abandoned(count: Int) {
        val actual = ctx.app.retention.abandonedCount
        expect(actual == count) { "通知された削除が $count 件ではない: $actual" }
    }

    // ---- 保持状態 ----

    @When("進行役が保持状態を取得する")
    fun facilitatorFetches() {
        ctx.last = ctx.api.retention(ctx.game.id, ctx.game.facilitator)
        expect(ctx.response().status == HTTP_OK) { "取得できない: ${ctx.response().status} ${ctx.response().text}" }
    }

    @When("参加者が保持状態を取得しようとする")
    fun participantTriesToFetch() {
        ctx.last =
            ctx.api.retention(
                ctx.game.id,
                ctx.game.participants
                    .first()
                    .cookie,
            )
    }

    @When("資格の無い人が保持状態を取得しようとする")
    fun anonymousTriesToFetch() {
        ctx.last = ctx.api.retention(ctx.game.id, null)
    }

    @Then("保持期間は {int} 日で、削除予定日は作成の {int} 日後である")
    fun retentionDaysAre(
        days: Int,
        afterDays: Int,
    ) {
        val json = ctx.response().json
        expect(json.number("retentionDays") == days) { "保持日数が $days 日ではない: ${ctx.response().text}" }
        val startsAt = Instant.parse(json.text("startsAt"))
        val deleteAfter = Instant.parse(json.text("deleteAfter"))
        expect(Duration.between(startsAt, deleteAfter) == Duration.ofDays(afterDays.toLong())) {
            "削除予定日が保持の開始の $afterDays 日後ではない: $startsAt → $deleteAfter"
        }
        val gap = Duration.between(startsAt, Instant.now()).abs()
        expect(gap < Duration.ofMinutes(CREATION_TOLERANCE_MINUTES)) { "保持の開始が作成の時刻ではない: $startsAt" }
    }

    @Then("保持状態は「{}」である")
    fun statusIs(label: String) {
        val expected = STATUS_LABELS.getValue(label)
        val actual = currentStatus().text("status")
        expect(actual == expected) { "状態が $expected ではない: $actual" }
    }

    @Then("保持状態は「{}」で、試行は {int} 回目である")
    fun statusAndAttempt(
        label: String,
        attempt: Int,
    ) {
        statusIs(label)
        val actual = currentStatus().number("attempt")
        expect(actual == attempt) { "試行が $attempt 回目ではない: $actual" }
    }

    @Then("バックアップに削除後も {int} 日残ることが示される")
    fun backupResidual(days: Int) {
        val actual = ctx.response().json.number("backupRetentionDays")
        expect(actual == days) { "バックアップの残存日数が $days 日ではない: $actual" }
    }

    /** 掃引の後の状態は、取得し直す（直前の応答は、掃引の前のもの）。 */
    private fun currentStatus() =
        ctx.api
            .retention(ctx.game.id, ctx.game.facilitator)
            .also { expect(it.status == HTTP_OK) { "保持状態を取得できない: ${it.status} ${it.text}" } }
            .json

    // ---- 削除の結果 ----

    @Then("進行役の資格では、このゲームの状態を取得できない")
    fun facilitatorGone() = expectForbidden(ctx.game.facilitator)

    @Then("参加者の資格では、このゲームの状態を取得できない")
    fun participantGone() =
        expectForbidden(
            ctx.game.participants
                .first()
                .cookie,
        )

    private fun expectForbidden(cookie: String) {
        val response = ctx.api.gameState(ctx.game.id, cookie)
        expect(response.status == HTTP_FORBIDDEN) { "資格が失効していない: ${response.status} ${response.text}" }
    }

    @Then("参加コードで、このゲームに参加できない")
    fun joinCodeGone() {
        val response = ctx.api.join(ctx.game.joinCode, "遅れて来た人")
        expect(response.status !in HTTP_OK..ScenarioContext.HTTP_CREATED) { "参加できてしまった: ${response.status}" }
    }

    @Then("進行役の資格で、このゲームの状態を取得できる")
    fun facilitatorStillReads() {
        val response = ctx.api.gameState(ctx.game.id, ctx.game.facilitator)
        expect(response.status == HTTP_OK) { "状態を取得できない: ${response.status} ${response.text}" }
    }

    @Then("2 つ目のゲームの進行役の資格で、そのゲームの状態を取得できる")
    fun secondGameStillReads() {
        val second = ctx.games[1]
        val response = ctx.api.gameState(second.id, second.facilitator)
        expect(response.status == HTTP_OK) { "状態を取得できない: ${response.status} ${response.text}" }
    }

    @Then("削除の受領記録が 1 件増え、ゲームの ID を含まない")
    fun receiptAdded() {
        val before = baseline()
        val digests = receipts()
        expect(digests.size == before + 1) { "受領記録が 1 件増えていない: $before → ${digests.size}" }
        knownReceipts = digests.size
        val id = ctx.game.id
        expect(digests.none { it.contains(id) || it.contains(id.replace("-", "")) }) { "受領記録にゲームの ID が含まれる" }
        expect(digests.all { it.length == DIGEST_LENGTH }) { "ダイジェストが $DIGEST_LENGTH 桁ではない" }
    }

    @Then("削除の受領記録は増えない")
    fun receiptNotAdded() {
        val before = baseline()
        val actual = receipts().size
        expect(actual == before) { "受領記録が増えた: $before → $actual" }
    }

    // ---- 全表の検査（AC5.1.4） ----

    @Given("ゲームの記録・履歴・資格の表に、このゲームの行がある")
    fun rowsExist() {
        val counts = ctx.app.rowsByTable(ctx.game.id)
        val required = listOf("events", "week_role_results", "credentials", "retention_policies")
        expect(required.all { (counts[it] ?: 0) > 0 }) { "行が無い表がある: ${counts.filterKeys { it in required }}" }
    }

    @Then("ゲームの ID を持つ表のどれにも、このゲームの行が残らない")
    fun noRowsRemain() {
        val counts = ctx.app.rowsByTable(ctx.game.id)
        val required = listOf("events", "week_role_results", "credentials", "retention_policies", "deletion_runs")
        expect(counts.keys.containsAll(required)) { "検査の対象の表が足りない: ${counts.keys}" }
        val remaining = counts.filterValues { it != 0 }
        expect(remaining.isEmpty()) { "行が残っている表がある: $remaining" }
    }
}
