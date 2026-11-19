package beergame.acceptance

import beergame.app.ServerConfig
import io.cucumber.java.en.Given
import io.cucumber.java.en.Then
import io.cucumber.java.en.When

private const val HTTP_FORBIDDEN = 403
private const val HTTP_TOO_MANY_REQUESTS = 429
private const val HTTP_UNPROCESSABLE = 422
private const val EXTRA = 2
private const val MISSING_NAME_BODY = """{"joinCode":"%s"}"""

/** 参加の専用のレート制限（NF-S11・NF-S19）のステップ定義。上限は、既定の設定値（失敗 10 回）を使う。薄く保つ。 */
class JoinRateLimitSteps {
    private val ctx get() = Scenario.current
    private val limit = ServerConfig.DEFAULT_ATTEMPT_MAX_FAILURES

    private val responses = mutableListOf<ApiResponse>()

    @Given("同じ接続元が、存在しない参加コードで、上限の回数まで参加に失敗している")
    fun failedUpToTheLimit() {
        repeat(limit) { i ->
            val response = ctx.api.join("ZZZZZZZZZZ%02d".format(i), "攻撃者")
            expect(response.status == HTTP_FORBIDDEN && response.code() == "game.invitation_invalid") {
                "失敗の応答が違う: ${response.status} ${response.text}"
            }
        }
    }

    @Given("同じ接続元が、表示名の無い参加を、上限を超える回数送っている")
    fun malformedBodiesBeyondTheLimit() {
        repeat(limit + EXTRA) {
            val response = ctx.api.post("/participations/join", MISSING_NAME_BODY.format(ctx.game.joinCode))
            expect(response.status == HTTP_UNPROCESSABLE) { "形式の誤りが 422 でない: ${response.status} ${response.text}" }
        }
    }

    @When("同じ接続元から、表示名の違う参加者が、上限を超える人数、有効な参加コードで参加する")
    fun joinBeyondTheLimit() {
        responses.clear()
        repeat(limit + EXTRA) { i -> responses += ctx.api.join(ctx.game.joinCode, "参加者%02d".format(i)) }
    }

    @Then("参加は、試行が多すぎるという理由で拒否される")
    fun rejectedAsTooManyAttempts() {
        val response = ctx.response()
        expect(response.status == HTTP_TOO_MANY_REQUESTS && response.code() == "app.rate_limited") {
            "試行が多すぎる（429）ではない: ${response.status} ${response.text}"
        }
        expect(response.credential() == null) { "拒否したのに資格が発行された" }
    }

    @Then("再試行までの待ち時間が示される")
    fun retryAfterIsShown() {
        val seconds = ctx.response().header("Retry-After")?.toIntOrNull()
        expect(seconds != null && seconds > 0) { "Retry-After が正の秒数でない: $seconds" }
    }

    @Then("どの参加も受け付けられる")
    fun everyJoinAccepted() {
        expect(responses.size == limit + EXTRA) { "参加の数が違う: ${responses.size}" }
        responses.forEach { expect(it.status == ScenarioContext.HTTP_OK) { "参加できない: ${it.status} ${it.text}" } }
    }

    @Then("参加は受け付けられる")
    fun joinAccepted() {
        val response = ctx.response()
        expect(response.status == ScenarioContext.HTTP_OK && response.credential() != null) {
            "参加できない: ${response.status} ${response.text}"
        }
    }
}
