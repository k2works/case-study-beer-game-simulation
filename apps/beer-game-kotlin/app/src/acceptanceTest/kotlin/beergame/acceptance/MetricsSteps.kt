package beergame.acceptance

import beergame.application.MetricNames
import beergame.application.MetricSample
import io.cucumber.java.en.Then
import java.util.concurrent.TimeUnit

private const val WAIT_MILLIS = 3_000L
private const val POLL_MILLIS = 20L

/**
 * 応答の後に出るメトリクス（ResponseSent の後）を、出そろうまで少し待って返す。出なければ null。
 * 実際の待機は、本物のサーバーの非同期の出力を待つ短い間だけ（アラームの訓練は、模擬の時計で待たない）。
 */
internal fun <T : Any> eventually(find: () -> T?): T? {
    val deadline = System.currentTimeMillis() + WAIT_MILLIS
    var found = find()
    while (found == null && System.currentTimeMillis() < deadline) {
        TimeUnit.MILLISECONDS.sleep(POLL_MILLIS)
        found = find()
    }
    return found
}

/** メトリクスの出力（AC6.1.3、AC6.1.6）のステップ定義。出力は、アプリケーションが集めたもの（EMF の行にした全文）を確かめる。 */
class MetricsSteps {
    private val ctx get() = Scenario.current

    private fun samples(): List<MetricSample> = ctx.app.metrics.all()

    private fun named(
        name: String,
        operation: String? = null,
    ): List<MetricSample> = samples().filter { it.name == name && (operation == null || it.operation == operation) }

    @Then("操作「{}」の応答時間と要求数のメトリクスが EMF の行として出力される")
    fun requestMetricsAreEmitted(operation: String) {
        val found =
            eventually {
                named(MetricNames.REQUEST_DURATION_MILLIS, operation).firstOrNull()
            }
        expect(found != null) { "操作 $operation の応答時間のメトリクスが出力されていない: ${samples().map { it.name }}" }
        expect(named(MetricNames.REQUEST_COUNT, operation).isNotEmpty()) { "操作 $operation の要求数が無い" }
        val text = ctx.app.metrics.text()
        listOf("_aws", "CloudWatchMetrics", "RequestDurationMillis", "\"Operation\":\"$operation\"").forEach {
            expect(it in text) { "出力された EMF の行に $it が無い: $text" }
        }
    }

    @Then("メトリクスの出力に、資格、表示名「{}」、非公開の値は含まれない")
    fun metricsHaveNoSecrets(name: String) {
        val text = ctx.app.metrics.text()
        val secrets =
            ctx.game.participants.map { it.cookie } +
                ctx.game.facilitator +
                ctx.game.joinCode +
                ctx.game.id +
                name +
                "bg_session"
        secrets.forEach { secret -> expect(secret !in text) { "メトリクスに、資格・表示名・非公開の値が含まれている: $secret" } }
    }

    @Then("操作「{}」の 5xx のエラー率のメトリクスが {int} として出力される")
    fun serverErrorMetricIs(
        operation: String,
        value: Int,
    ) {
        val found =
            eventually {
                named(MetricNames.SERVER_ERROR, operation).firstOrNull { it.value == value.toDouble() }
            }
        expect(found != null) {
            "操作 $operation の 5xx が $value のメトリクスが無い: ${named(MetricNames.SERVER_ERROR, operation).map { it.value }}"
        }
    }

    @Then("投影の不一致のメトリクスが {int} 件として出力される")
    fun mismatchMetricIs(count: Int) = expectLatest(MetricNames.PROJECTION_MISMATCH_GAMES, count)

    @Then("投影の遅れのメトリクスが {int} 件として出力される")
    fun lagMetricIs(count: Int) = expectLatest(MetricNames.PROJECTION_LAG_GAMES, count)

    private fun expectLatest(
        name: String,
        count: Int,
    ) {
        val latest = named(name).lastOrNull()
        expect(latest != null && latest.value == count.toDouble()) {
            "$name が $count ではない: ${named(name).map { it.value }}"
        }
    }
}
