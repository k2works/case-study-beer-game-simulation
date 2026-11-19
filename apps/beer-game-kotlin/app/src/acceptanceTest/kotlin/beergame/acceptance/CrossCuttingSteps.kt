package beergame.acceptance

import io.cucumber.java.en.Then
import io.cucumber.java.en.When

/** 横断の受入条件（X-3: ログに秘密を残さない、X-5: セキュリティヘッダー）のステップ定義。薄く保ち、HTTP を呼んで確かめるだけ。 */
class CrossCuttingSteps {
    private val ctx get() = Scenario.current

    private val responses = mutableListOf<ApiResponse>()

    @Then("構造化ログの全体に、資格・参加コード・復帰コード・参加者の表示名は含まれない")
    fun logHasNoSecrets() {
        val text = ctx.app.logs.text()
        val gameSecrets = ctx.games.map { listOfNotNull(it.facilitator, it.joinCode, it.recovery, it.recoveryCode) }
        val participantSecrets =
            ctx.games.map { game -> game.participants.map { listOfNotNull(it.cookie, it.recovery, it.name) } }
        val secrets = gameSecrets.flatten() + participantSecrets.flatten().flatten()
        expect(secrets.isNotEmpty()) { "確かめる対象の秘密が空" }
        expect(text.isNotBlank()) { "構造化ログが空（確認にならない）" }
        secrets.forEach { secret -> expect(secret !in text) { "ログに秘密が含まれている: $secret" } }
        listOf("bg_session", "bg_recovery").forEach { name -> expect(name !in text) { "ログに Cookie 名が含まれている: $name" } }
    }

    @When("進行役の状況の取得、資格の無い状況の取得、存在しない経路の要求を、それぞれ送る")
    fun sendThreeKindsOfRequests() {
        val game = ctx.game
        responses += ctx.api.gameState(game.id, game.facilitator)
        responses += ctx.api.gameState(game.id, null)
        responses += ctx.api.get("/no-such-route")
    }

    @Then("どの応答にも、CSP・HSTS・nosniff・Referrer-Policy・キャッシュ無効のヘッダーが付く")
    fun everyResponseHasSecurityHeaders() {
        expect(responses.size == EXPECTED_RESPONSES) { "応答の数が違う: ${responses.size}" }
        responses.forEach { response ->
            REQUIRED_HEADERS.forEach { (name, expected) ->
                val actual = response.header(name)
                expect(actual != null && expected in actual) {
                    "応答（${response.status}）に $name が無い、または値が違う: $actual（期待 $expected を含む）"
                }
            }
        }
        // HSTS は 1 年以上（CloudFront と同じ値。ProductionDefinitionSpec が、2 つの値の一致を検査する）
        expect(responses.all { it.header("Strict-Transport-Security")?.contains("max-age=31536000") == true }) {
            "HSTS の max-age が 1 年でない"
        }
    }

    private companion object {
        const val EXPECTED_RESPONSES = 3
        val REQUIRED_HEADERS =
            mapOf(
                "Content-Security-Policy" to "default-src 'none'",
                "Strict-Transport-Security" to "max-age=",
                "X-Content-Type-Options" to "nosniff",
                "Referrer-Policy" to "no-referrer",
                "Cache-Control" to "no-store",
            )
    }
}
