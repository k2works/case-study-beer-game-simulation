package beergame.acceptance

import beergame.application.AlarmCatalog
import beergame.application.AlarmState
import beergame.application.MetricNames
import beergame.application.MetricSample
import beergame.application.MetricUnit
import beergame.application.detectionDelay
import beergame.application.evaluateAlarms
import io.cucumber.java.en.Given
import io.cucumber.java.en.Then
import io.cucumber.java.en.When
import java.time.Duration
import java.time.Instant

private val EPOCH: Instant = Instant.parse("2026-11-16T10:00:00Z")
private const val SUCCESS_INTERVAL = 5L
private const val CANARY_INTERVAL = 60L
private const val CANARY_HORIZON = 1_200L
private const val RATE_SAMPLES = 100
private const val RATE_HORIZON = 900L
private const val PERCENT = 100.0
private const val HEAP_STEP = 60L
private const val EVALUATION_STEP = 10L
private const val CONFLICT_EVALUATED_AT = 600L

private fun at(seconds: Long): Instant = EPOCH.plusSeconds(seconds)

/**
 * アラームの訓練（AC6.1.3、AC6.1.5）のステップ定義。**模擬の時計**（基準からの秒数）と、故障を模擬したメトリクスの系列を、
 * 本番と同じ閾値の表（[AlarmCatalog]）の評価に与える。実際の待機はしない。
 */
class AlarmDrillSteps {
    private var training = true
    private var samples: List<MetricSample> = emptyList()
    private var faultAt = 0L
    private var stopAt = 0L

    private fun counts(
        name: String,
        value: Double,
        seconds: Long,
    ) = MetricSample(name, MetricUnit.COUNT, value, at(seconds))

    private fun mainSuccesses(
        until: Long,
        gap: LongRange = LongRange.EMPTY,
    ) = (0L until until step SUCCESS_INTERVAL)
        .filter { it !in gap }
        .map { counts(MetricNames.MAIN_OPERATION_SUCCESS, 1.0, it) }

    private fun state(
        name: String,
        seconds: Long,
    ): AlarmState = evaluateAlarms(listOf(AlarmCatalog.named(name)), samples, at(seconds), training).single().state

    // ---- 前提 ----

    @Given("研修中で、主要な操作が 5 秒ごとに成功している")
    fun trainingWithSuccesses() {
        training = true
    }

    @Given("研修中ではなく、主要な操作が 5 秒ごとに成功している")
    fun notTrainingWithSuccesses() {
        training = false
    }

    @Given("合成監視が 60 秒ごとに成功している")
    fun canaryHealthy() {
        training = true
    }

    @Given("コマンドの追記の競合率が平常（{int}%）である")
    fun conflictRateNormal(percent: Int) {
        samples = conflictSeries(percent.toDouble() / PERCENT, Long.MAX_VALUE, 0.0)
    }

    @Given("JVM のヒープの使用率が平常（{int}%）である")
    fun heapNormal(percent: Int) {
        expect(percent in 0..PERCENT.toInt()) { "使用率は 0〜100%" }
        samples = emptyList()
    }

    // ---- 操作 ----

    @When("時刻 {int} 秒にアプリケーションが停止する")
    fun stops(seconds: Int) {
        faultAt = seconds.toLong()
        stopAt = faultAt
        samples =
            mainSuccesses(until = faultAt) +
            (0L until CANARY_HORIZON step CANARY_INTERVAL).map {
                MetricSample("SuccessPercent", MetricUnit.PERCENT, if (it < faultAt) PERCENT else 0.0, at(it))
            }
    }

    @When("時刻 {int} 秒から {int} 秒だけ、主要な操作が成功しなくなる")
    fun gap(
        from: Int,
        length: Int,
    ) {
        faultAt = from.toLong()
        stopAt = faultAt + length
        samples = mainSuccesses(until = CANARY_HORIZON, gap = faultAt until stopAt)
    }

    @When("時刻 {int} 秒から、追記の競合率が {int}% に急増する")
    fun conflictSpike(
        from: Int,
        percent: Int,
    ) {
        samples = conflictSeries(0.01, from.toLong(), percent.toDouble() / PERCENT)
    }

    @When("時刻 {int} 秒から、ヒープの使用率が {int}% で {int} 分続く")
    fun heapHigh(
        from: Int,
        percent: Int,
        minutes: Int,
    ) {
        val end = from + minutes * HEAP_STEP
        samples =
            (from.toLong() until end step HEAP_STEP).map {
                MetricSample(MetricNames.JVM_HEAP_USED_PERCENT, MetricUnit.PERCENT, percent.toDouble(), at(it))
            }
        faultAt = end
    }

    private fun conflictSeries(
        before: Double,
        from: Long,
        after: Double,
    ): List<MetricSample> =
        (0L until RATE_HORIZON step SUCCESS_INTERVAL).flatMap { t ->
            val rate = if (t >= from) after else before
            (1..RATE_SAMPLES).map { i ->
                counts(
                    MetricNames.CONCURRENCY_CONFLICT,
                    if (i <=
                        rate * RATE_SAMPLES
                    ) {
                        1.0
                    } else {
                        0.0
                    },
                    t,
                )
            }
        }

    // ---- 確認 ----

    @Then("停止から {int} 秒以内に、重大のアラーム「{}」が発報する")
    fun firesWithin(
        seconds: Int,
        name: String,
    ) {
        val delay =
            detectionDelay(
                AlarmCatalog.named(name),
                samples,
                at(faultAt),
                at(faultAt + CANARY_HORIZON),
                training = training,
            )
        expect(delay != null && delay <= Duration.ofSeconds(seconds.toLong())) {
            "アラーム $name は停止から $seconds 秒以内に発報しない（検知までの時間: $delay）"
        }
    }

    @Then("アラーム「{}」は発報しない")
    fun doesNotFire(name: String) {
        if (samples.isEmpty()) {
            expect(!firedOnAppMetrics(name)) { "アラーム $name が発報した" }
        } else {
            val states = (faultAt..CANARY_HORIZON step EVALUATION_STEP).map { state(name, it) }
            expect(states.none { it == AlarmState.ALARM }) { "アラーム $name が発報した" }
        }
    }

    /** アプリケーションが実際に出したメトリクス（投影の整合の検査）を、最後の観測の期間が終わった時刻で評価する。 */
    private fun firedOnAppMetrics(name: String): Boolean {
        val rule = AlarmCatalog.named(name)
        val collected =
            Scenario.current.app.metrics
                .all()
        val latest = collected.maxOfOrNull { it.at } ?: error("メトリクスが出力されていない")
        val evaluatedAt = latest.plus(Duration.ofDays(1))
        return evaluateAlarms(listOf(rule), collected, evaluatedAt).single().state == AlarmState.ALARM
    }

    @Then("停止から {int} 秒が過ぎても、アラーム「{}」は発報しない")
    fun doesNotFireAfter(
        seconds: Int,
        name: String,
    ) {
        val delay =
            detectionDelay(AlarmCatalog.named(name), samples, at(faultAt), at(faultAt + seconds), training = training)
        expect(delay == null) { "アラーム $name が発報した（検知までの時間: $delay）" }
    }

    @Then("警告のアラーム「{}」と重大のアラーム「{}」が発報する")
    fun warningAndCritical(
        warning: String,
        critical: String,
    ) {
        expect(state(warning, CONFLICT_EVALUATED_AT) == AlarmState.ALARM) { "警告 $warning が発報しない" }
        expect(state(critical, CONFLICT_EVALUATED_AT) == AlarmState.ALARM) { "重大 $critical が発報しない" }
    }

    @Then("重大のアラーム「{}」が発報する")
    fun criticalFires(name: String) {
        val fired = if (samples.isEmpty()) firedOnAppMetrics(name) else state(name, faultAt) == AlarmState.ALARM
        expect(fired) { "重大 $name が発報しない" }
    }
}
