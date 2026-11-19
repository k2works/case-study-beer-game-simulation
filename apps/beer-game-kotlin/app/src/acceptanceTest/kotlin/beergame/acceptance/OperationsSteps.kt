package beergame.acceptance

import io.cucumber.java.en.Given
import io.cucumber.java.en.Then
import io.cucumber.java.en.When

private const val HTTP_OK = 200
private const val HTTP_UNAVAILABLE = 503
private const val CORRELATION_HEADER = "x-correlation-id"

/** 運用と観測性のステップ定義（US6.1）。構造化ログは、アプリケーションが出力した記録を集めて確かめる。 */
class OperationsSteps {
    private val ctx get() = Scenario.current

    private var participant: Participant? = null

    @Given("参加者が表示名「{}」でゲームに参加している")
    fun participantJoinedGame(name: String) {
        if (ctx.games.isEmpty()) {
            expect(ctx.createGame().status == ScenarioContext.HTTP_CREATED) { "ゲームを作成できない" }
        }
        participant = ctx.join(ctx.game, name)
    }

    @When("状況を取得する要求を処理する")
    fun handleSituationRequest() {
        val player = checkNotNull(participant)
        ctx.last = ctx.api.gameState(ctx.game.id, player.cookie)
        expect(ctx.response().status == HTTP_OK) { "状況を取得できない: ${ctx.response().status} ${ctx.response().text}" }
    }

    @Then("相関 ID、操作、結果、所要時間を含む構造化ログが出力される")
    fun structuredLogIsEmitted() {
        val correlationId = checkNotNull(ctx.response().header(CORRELATION_HEADER)) { "応答に相関 ID がない" }
        val record =
            checkNotNull(
                ctx.app.logs
                    .all()
                    .firstOrNull { it.correlationId == correlationId },
            ) { "相関 ID $correlationId のログが出力されていない" }
        expect(record.operation.isNotBlank()) { "操作がない" }
        expect(record.result.isNotBlank()) { "結果がない" }
        expect(record.durationMillis >= 0) { "所要時間がない" }
        // 出力される形（1 行の JSON）にも、4 つの項目の名前がある。
        val line = record.toJsonLine()
        listOf("correlationId", "operation", "result", "durationMillis").forEach {
            expect("\"$it\"" in line) { "出力された行に $it がない: $line" }
        }
    }

    @Then("そのログに、資格、表示名「{}」、非公開の値は含まれない")
    fun logHasNoSecrets(name: String) {
        val text = ctx.app.logs.text()
        val secrets =
            ctx.game.participants.map { it.cookie } +
                ctx.game.facilitator +
                ctx.game.joinCode +
                name +
                "bg_session"
        secrets.forEach { secret -> expect(secret !in text) { "ログに、資格・表示名・非公開の値が含まれている: $secret" } }
    }

    @Given("アプリケーションが準備できている")
    fun applicationIsReady() {
        val response = ctx.api.ready()
        expect(response.status == HTTP_OK) { "準備できていない: ${response.status} ${response.text}" }
    }

    @When("データベースに接続できなくなる")
    fun databaseBecomesUnreachable() = ctx.app.loseDatabase()

    @Then("準備のヘルスチェックは準備できていないことを示す")
    fun readinessShowsNotReady() {
        val response = ctx.api.ready()
        expect(response.status == HTTP_UNAVAILABLE && response.code() == "app.not_ready") {
            "準備できていないことを示していない: ${response.status} ${response.text}"
        }
    }

    @Then("生存のヘルスチェックは成功のままである")
    fun livenessStaysOk() {
        val response = ctx.api.health()
        expect(response.status == HTTP_OK) { "生存の確認が失敗した: ${response.status}" }
    }
}
