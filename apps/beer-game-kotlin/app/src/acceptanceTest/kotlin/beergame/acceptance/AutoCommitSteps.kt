package beergame.acceptance

import io.cucumber.java.en.Given
import io.cucumber.java.en.Then
import io.cucumber.java.en.When
import kotlinx.serialization.json.jsonObject

private const val HTTP_OK = 200
private const val HTTP_UNPROCESSABLE = 422

private val COMMIT_MODE_LABELS = mapOf("手動確定" to "MANUAL", "自動確定" to "AUTO")

private fun commitModeBody(mode: String): String = kitGameBody().removeSuffix("}") + ",\"commitMode\":\"$mode\"}"

/** 自動確定のステップ定義（AC1.1.6、US2.4）。薄く保つ。 */
class AutoCommitSteps {
    private val ctx get() = Scenario.current

    @Given("進行役が、自動確定を有効にして、ゲームを作成している")
    fun createdWithAutoCommit() {
        val response = ctx.createGame(commitModeBody("AUTO"))
        expect(response.status == ScenarioContext.HTTP_CREATED) { "作成できない: ${response.status} ${response.text}" }
    }

    @When("進行役が、自動確定を有効にして、ゲームを作成する")
    fun createWithAutoCommit() {
        ctx.last = ctx.createGame(commitModeBody("AUTO"))
    }

    @When("進行役が、確定方式「{}」で、ゲームを作成しようとする")
    fun tryCreateWithCommitMode(mode: String) {
        ctx.last = ctx.createGame(commitModeBody(mode))
    }

    @Then("ゲームの確定方式は「{}」である")
    fun commitModeIs(label: String) {
        val expected = checkNotNull(COMMIT_MODE_LABELS[label]) { "知らない確定方式: $label" }
        val actual =
            ctx.api
                .gameState(ctx.game.id, ctx.game.facilitator)
                .json
                .text("commitMode")
        expect(actual == expected) { "確定方式が $expected ではない: $actual" }
    }

    @Then("誤りの対象は「commitMode」であり、MANUAL か AUTO にするという修正内容が示される")
    fun commitModeErrorShown() {
        val response = ctx.response()
        expect(
            response.status == HTTP_UNPROCESSABLE && ctx.games.isEmpty(),
        ) { "拒否されていない: ${response.status} ${response.text}" }
        val error =
            response.json
                .array("errors")
                .map { it.jsonObject }
                .firstOrNull { it.text("field") == "commitMode" }
        expect(error != null && "MANUAL" in error.text("message") && "AUTO" in error.text("message")) {
            "commitMode の修正内容が示されていない: ${response.text}"
        }
    }

    @When("{word}の参加者が、第 {int} 週の数量として {int} を保存する")
    fun participantSaves(
        label: String,
        week: Int,
        quantity: Int,
    ) {
        val player = ctx.game.playerOf(Role.ofLabel(label))
        ctx.last = ctx.api.saveDecision(ctx.game.id, week, quantity.toString(), player.cookie)
        expect(ctx.response().status == HTTP_OK) { "保存できない: ${ctx.response().status} ${ctx.response().text}" }
    }

    @When("進行役が、自動確定を有効にする")
    fun enableAutoCommit() = changeCommitMode("AUTO")

    @When("進行役が、自動確定を無効にする")
    fun disableAutoCommit() = changeCommitMode("MANUAL")

    @When("{word}の参加者が、自動確定を無効にしようとする")
    fun participantTriesToDisable(label: String) {
        val player = ctx.game.playerOf(Role.ofLabel(label))
        ctx.last = ctx.api.setCommitMode(ctx.game.id, "MANUAL", player.cookie)
    }

    private fun changeCommitMode(mode: String) {
        ctx.last = ctx.api.setCommitMode(ctx.game.id, mode, ctx.game.facilitator)
        expect(ctx.response().status == HTTP_OK) { "確定方式を変えられない: ${ctx.response().status} ${ctx.response().text}" }
    }
}
