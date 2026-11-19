package beergame.acceptance

import io.cucumber.java.en.Given
import io.cucumber.java.en.Then
import io.cucumber.java.en.When
import kotlinx.serialization.json.jsonObject

private const val HTTP_OK = 200
private const val HTTP_CONFLICT = 409
private const val ROLE_COUNT = 4
private const val GAME_NOT_ENDED = "game.not_ended"
private val METRICS = listOf("orders", "order", "inventory", "backlog", "shipment", "cost")

/** 振り返り（US4.2）のステップ定義。薄く保つ。 */
class ReviewSteps {
    private val ctx get() = Scenario.current

    @Given("進行役が、最終週 {int} のキット準拠のゲームを作成している")
    fun createdWithFinalWeek(finalWeek: Int) {
        val response = ctx.createGame(kitGameBody(finalWeek, DEMAND_SERIES.take(finalWeek)))
        expect(response.status == ScenarioContext.HTTP_CREATED) { "作成できない: ${response.status} ${response.text}" }
    }

    @Given("全 {int} 週が、各役割 {int} の入力で確定され、ゲームが終了している")
    fun allWeeksCommitted(
        weeks: Int,
        quantity: Int,
    ) {
        (1..weeks).forEach { commitWeek(it, quantity) }
        val state = ctx.api.gameState(ctx.game.id, ctx.game.facilitator)
        expect(state.json.text("status") == "ENDED") { "ゲームが終了していない: ${state.text}" }
    }

    @Given("第 {int} 週が、各役割 {int} の入力で確定されている")
    fun weekCommitted(
        week: Int,
        quantity: Int,
    ) = commitWeek(week, quantity)

    @When("進行役が振り返りを取得する")
    fun facilitatorFetches() {
        ctx.last = ctx.api.review(ctx.game.id, ctx.game.facilitator)
        expect(ctx.response().status == HTTP_OK) { "取得できない: ${ctx.response().status} ${ctx.response().text}" }
    }

    @When("進行役が振り返りを取得しようとする")
    fun facilitatorTriesToFetch() {
        ctx.last = ctx.api.review(ctx.game.id, ctx.game.facilitator)
    }

    @When("{word}の参加者が振り返りを取得する")
    fun participantFetches(label: String) {
        ctx.last = ctx.api.review(ctx.game.id, ctx.game.playerOf(Role.ofLabel(label)).cookie)
        expect(ctx.response().status == HTTP_OK) { "取得できない: ${ctx.response().status} ${ctx.response().text}" }
    }

    @When("{word}の参加者が振り返りを取得しようとする")
    fun participantTriesToFetch(label: String) {
        ctx.last = ctx.api.review(ctx.game.id, ctx.game.playerOf(Role.ofLabel(label)).cookie)
    }

    @When("資格の無い人が振り返りを取得しようとする")
    fun anonymousTriesToFetch() {
        ctx.last = ctx.api.review(ctx.game.id, null)
    }

    @Then("振り返りに、4 役割のそれぞれについて {int} 週分の注文・在庫・受注残・出荷・費用が含まれる")
    fun reviewHasAllRoles(weeks: Int) {
        val results =
            ctx
                .response()
                .json
                .array("results")
                .map { it.jsonObject }
        expect(results.size == ROLE_COUNT * weeks) { "結果が ${ROLE_COUNT * weeks} 件ではない: ${results.size}" }
        Role.entries.forEach { role ->
            val weeksOfRole = results.filter { it.text("role") == role.apiName }.map { it.number("week") }.sorted()
            expect(weeksOfRole == (1..weeks).toList()) { "${role.label}の週が不足: $weeksOfRole" }
        }
        expect(results.all { row -> METRICS.all { it in row } }) { "指標が不足している行がある" }
    }

    @Then("ゲームがまだ終了していないという理由で拒否される")
    fun rejectedBecauseNotEnded() {
        val response = ctx.response()
        expect(response.status == HTTP_CONFLICT && response.code() == GAME_NOT_ENDED) {
            "終了前の拒否ではない: ${response.status} ${response.text}"
        }
    }

    @Then("結果の一覧は含まれない")
    fun noRoleValues() {
        expect("results" !in ctx.response().json) { "値が含まれている: ${ctx.response().text}" }
    }

    private fun commitWeek(
        week: Int,
        quantity: Int,
    ) {
        val game = ctx.game
        Role.entries.forEach { role ->
            val saved = ctx.api.saveDecision(game.id, week, quantity.toString(), game.playerOf(role).cookie)
            expect(saved.status == HTTP_OK) { "保存できない: ${saved.status} ${saved.text}" }
        }
        val body = ctx.api.commitBody(week, ctx.basisOf(game))
        val committed = ctx.api.commitWeek(game.id, week, body, game.facilitator)
        expect(committed.status == HTTP_OK) { "確定できない: ${committed.status} ${committed.text}" }
    }
}
