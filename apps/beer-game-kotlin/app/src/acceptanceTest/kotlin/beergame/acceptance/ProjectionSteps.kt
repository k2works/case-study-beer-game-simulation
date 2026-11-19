package beergame.acceptance

import io.cucumber.java.en.Given
import io.cucumber.java.en.Then
import io.cucumber.java.en.When

private const val HTTP_OK = 200
private const val RETENTION_DEFAULT_DAYS = 90

/** 投影の再構築と整合の検査（B12。NF-R15）のステップ定義。薄く保つ。 */
class ProjectionSteps {
    private val ctx get() = Scenario.current

    /** 控えていた投影の内容。 */
    private var remembered: Map<String, List<String>>? = null

    private val projection get() = ctx.app.projection

    // ---- 控える・壊す ----

    @Given("そのゲームの投影の内容を控えている")
    fun rememberProjection() {
        val snapshot = projection.snapshot(ctx.game.id)
        expect(snapshot.getValue("game_overview").isNotEmpty()) { "投影が作られていない" }
        remembered = snapshot
    }

    @Given("そのゲームの保持方針の行を消している")
    fun retentionPolicyRemoved() = projection.deleteRetentionPolicy(ctx.game.id)

    @Given("そのゲームの投影の行を 1 つ書き換えている")
    fun overviewCorrupted() = projection.corruptOverview(ctx.game.id)

    @Given("そのゲームの投影の進んだ版の記録を 1 つ戻している")
    fun checkpointRewound() = projection.rewindSessionCheckpoint(ctx.game.id)

    @When("そのゲームの投影をすべて空にする")
    fun wipe() = projection.wipe(ctx.game.id)

    // ---- 再構築・検査 ----

    @When("そのゲームの投影を再構築する")
    fun rebuild() = projection.rebuild(ctx.game.id)

    @When("投影の整合を検査する")
    fun verify() = projection.verify(ctx.game.id)

    // ---- 確認 ----

    @Then("そのゲームの投影は、控えていた内容と一致する")
    fun matchesRemembered() {
        val before = checkNotNull(remembered) { "投影の内容を控えていない" }
        val after = projection.snapshot(ctx.game.id)
        before.keys.forEach { table ->
            expect(before.getValue(table) == after.getValue(table)) {
                "表 $table の内容が控えと違う: 控え ${before.getValue(table)}、いま ${after.getValue(table)}"
            }
        }
    }

    @Then("進行役が状況を取得すると、ゲームは終了している")
    fun gameIsEnded() {
        val state = ctx.api.gameState(ctx.game.id, ctx.game.facilitator)
        expect(state.status == HTTP_OK && state.json.text("status") == "ENDED") { "終了していない: ${state.text}" }
    }

    @Then("進行役が保持状態を取得すると、保持期間は {int} 日である")
    fun retentionRestored(days: Int) {
        expect(days == RETENTION_DEFAULT_DAYS) { "このシナリオは既定の保持期間（90 日）を前提にする" }
        val response = ctx.api.retention(ctx.game.id, ctx.game.facilitator)
        expect(response.status == HTTP_OK) { "保持状態を取得できない: ${response.status} ${response.text}" }
        expect(response.json.number("retentionDays") == days) { "保持期間が $days 日ではない: ${response.text}" }
    }

    @Then("不一致が報告され、その中に表「{}」が含まれる")
    fun driftReportedFor(table: String) {
        val report = checkNotNull(projection.lastVerify) { "検査していない" }
        val tables = report.inconsistent.flatMap { it.findings }.map { it.toString() }
        expect(tables.any { "table=$table" in it }) { "表 $table の不一致が報告されていない: $tables" }
    }

    @Then("不一致が報告され、その中にストリーム「{}」の版の食い違いが含まれる")
    fun checkpointDriftReported(stream: String) {
        val report = checkNotNull(projection.lastVerify) { "検査していない" }
        val findings = report.inconsistent.flatMap { it.findings }.map { it.toString() }
        expect(findings.any { "CheckpointDrift" in it && "streamType=$stream" in it }) {
            "ストリーム $stream の版の食い違いが報告されていない: $findings"
        }
    }

    @Then("不一致は 0 件である")
    fun noDrift() {
        val report = checkNotNull(projection.lastVerify) { "検査していない" }
        expect(report.inconsistent.isEmpty() && report.failed.isEmpty() && report.checked == 1) {
            "不一致がある、または検査できていない: $report"
        }
    }
}
