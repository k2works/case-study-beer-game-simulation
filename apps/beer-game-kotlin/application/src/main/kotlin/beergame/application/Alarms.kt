package beergame.application

import java.time.Duration
import java.time.Instant

/*
 * アラームの評価（B13。NF-O4）。CloudWatch のアラームと同じ意味（期間、評価の回数、超過の回数、欠測の扱い、統計）を、
 * 純粋な関数で表す。時計は引数で受け取る（模擬の時計で、訓練を実際の待機なしに行う）。
 * 閾値の表は [AlarmCatalog]（設計書の「監視項目と閾値」）で、Terraform の定義と同じ値でなければならない
 * （`AlarmCatalogSpec` が `.tf` を読んで突き合わせる）。
 */

enum class Severity { WARNING, CRITICAL }

enum class Statistic { SUM, AVERAGE, MAXIMUM, P95 }

enum class Comparison { GREATER_THAN, LESS_THAN }

/** 欠測（その期間に観測が無い）の扱い。停止の検知は、欠測を超過とみなす。 */
enum class MissingData { BREACHING, NOT_BREACHING }

/** 評価する系列。[namespace] が null なら、アプリのメトリクス（`BeerGame/Kotlin`）。 */
data class MetricSpec(
    val name: String,
    val statistic: Statistic,
    val namespace: String? = null,
)

data class Condition(
    val comparison: Comparison,
    val threshold: Double,
)

/** [datapointsToAlarm] は、直近の [evaluationPeriods] 期間のうち、超過が何期間で発報するか。 */
data class AlarmWindow(
    val periodSeconds: Int,
    val evaluationPeriods: Int,
    val datapointsToAlarm: Int,
    val missingData: MissingData,
)

/** [trainingOnly] は、研修中だけ通知する（研修のない時間は、操作が無くて当然）。 */
data class AlarmRule(
    val name: String,
    val metric: MetricSpec,
    val condition: Condition,
    val window: AlarmWindow,
    val severity: Severity,
    val trainingOnly: Boolean = false,
)

enum class AlarmState { OK, ALARM }

data class AlarmEvaluation(
    val rule: AlarmRule,
    val state: AlarmState,
)

/** 評価の対象の系列（[MetricSpec.name] が同じものだけ使う）を、直近の期間に区切って、超過の期間数を数える。 */
private fun breachingPeriods(
    rule: AlarmRule,
    samples: List<MetricSample>,
    at: Instant,
): Int {
    val window = rule.window
    val period = window.periodSeconds.toLong()
    val end = Math.floorDiv(at.epochSecond, period) * period
    val named = samples.filter { it.name == rule.metric.name }
    return (0 until window.evaluationPeriods).count { index ->
        val to = end - index * period
        val from = to - period
        val values =
            named.filter { it.at.epochSecond in from until to }.map { it.value }
        val statistic = statisticOf(rule.metric.statistic, values)
        if (statistic == null) {
            window.missingData == MissingData.BREACHING
        } else {
            compare(rule.condition, statistic)
        }
    }
}

private const val P95 = 0.95

private fun statisticOf(
    statistic: Statistic,
    values: List<Double>,
): Double? =
    if (values.isEmpty()) {
        null
    } else {
        when (statistic) {
            Statistic.SUM -> values.sum()
            Statistic.AVERAGE -> values.average()
            Statistic.MAXIMUM -> values.max()
            Statistic.P95 -> values.sorted()[kotlin.math.ceil(P95 * values.size).toInt() - 1]
        }
    }

private fun compare(
    condition: Condition,
    value: Double,
): Boolean =
    when (condition.comparison) {
        Comparison.GREATER_THAN -> value > condition.threshold
        Comparison.LESS_THAN -> value < condition.threshold
    }

/**
 * 時刻 [at] での、すべての規則の状態。期間は、エポックの秒を期間の長さで割った境界に揃え、[at] の直前に終わった期間から
 * さかのぼって [AlarmWindow.evaluationPeriods] 個を見る。[training] が false のとき、研修中だけの規則は常に OK。
 */
fun evaluateAlarms(
    rules: List<AlarmRule>,
    samples: List<MetricSample>,
    at: Instant,
    training: Boolean = true,
): List<AlarmEvaluation> =
    rules.map { rule ->
        val active = training || !rule.trainingOnly
        val fired = active && breachingPeriods(rule, samples, at) >= rule.window.datapointsToAlarm
        AlarmEvaluation(rule, if (fired) AlarmState.ALARM else AlarmState.OK)
    }

/**
 * 訓練。[faultAt] から [until] まで、10 秒（高解像度のアラームの評価の間隔）ごとに評価し、[rule] が最初に発報した時刻と
 * [faultAt] の差を返す。発報しなければ null。**実際の待機はしない**（時刻は引数）。
 */
fun detectionDelay(
    rule: AlarmRule,
    samples: List<MetricSample>,
    faultAt: Instant,
    until: Instant,
    training: Boolean = true,
): Duration? =
    generateSequence(faultAt) { it.plusSeconds(EVALUATION_STEP_SECONDS) }
        .takeWhile { !it.isAfter(until) }
        .firstOrNull { evaluateAlarms(listOf(rule), samples, it, training).single().state == AlarmState.ALARM }
        ?.let { Duration.between(faultAt, it) }

const val EVALUATION_STEP_SECONDS = 10L
