package beergame.app

import arrow.core.Either
import beergame.application.AlarmCatalog
import beergame.application.AlarmRule
import beergame.application.AppFailure
import beergame.application.Comparison
import beergame.application.GameInconsistency
import beergame.application.Inconsistency
import beergame.application.JvmReading
import beergame.application.MetricNames
import beergame.application.MetricSample
import beergame.application.MetricSink
import beergame.application.MissingData
import beergame.application.Severity
import beergame.application.Statistic
import beergame.application.SweepReport
import beergame.application.VerifyReport
import beergame.domain.GameId
import beergame.domain.StreamType
import beergame.http.LogRecord
import beergame.http.LogSink
import io.kotest.core.spec.style.FunSpec
import io.kotest.matchers.shouldBe
import java.io.File
import java.time.Duration
import java.time.Instant
import java.util.UUID

/*
 * B13 の定義の検査。アラームの表（AlarmCatalog）と Terraform（alarms.tf）が同じ値であること、保守・保持モードがメトリクスを出すこと、
 * JVM の定期の読み取りが出すこと。
 */

private val ALARMS_TF = File("../infra/modules/observability/alarms.tf")
private val AT: Instant = Instant.parse("2026-11-16T10:00:00Z")
private val GAME = GameId(UUID(2L, 2L))

private class CollectingMetrics : MetricSink {
    val samples = mutableListOf<MetricSample>()

    override fun record(samples: List<MetricSample>) {
        this.samples += samples
    }
}

private object NoLogs : LogSink {
    override fun emit(record: LogRecord) = Unit
}

/** alarms.tf の `"名前" = merge(` から次の同じ書式までを、アラーム 1 件の定義として切り出す。 */
private fun terraformBlocks(text: String): Map<String, String> {
    val header = Regex("""^\s+"([a-z0-9-]+)" = merge\(""", RegexOption.MULTILINE)
    val matches = header.findAll(text).toList()
    val closing = Regex("""^\s{4}\}\)""", RegexOption.MULTILINE)
    return matches
        .associate { match ->
            val end = closing.find(text, match.range.last)?.range?.last ?: text.length
            match.groupValues[1] to text.substring(match.range.first, end)
        }
}

private fun String.attribute(key: String): String? =
    Regex("""^\s*$key\s*=\s*(.+?)\s*$""", RegexOption.MULTILINE)
        .find(this)
        ?.groupValues
        ?.get(1)
        ?.trim('"')

private fun Comparison.terraform(): String =
    when (this) {
        Comparison.GREATER_THAN -> "GreaterThanThreshold"
        Comparison.LESS_THAN -> "LessThanThreshold"
    }

private fun Statistic.terraform(): String =
    when (this) {
        Statistic.SUM -> "Sum"
        Statistic.AVERAGE -> "Average"
        Statistic.MAXIMUM -> "Maximum"
        Statistic.P95 -> "Maximum"
    }

private fun check(
    rule: AlarmRule,
    block: String,
) {
    block.attribute("metric_name") shouldBe rule.metric.name
    block.attribute("comparison") shouldBe rule.condition.comparison.terraform()
    block.attribute("threshold")?.toDouble() shouldBe rule.condition.threshold
    block.attribute("period")?.toInt() shouldBe rule.window.periodSeconds
    block.attribute("evaluation_periods")?.toInt() shouldBe rule.window.evaluationPeriods
    rule.window.evaluationPeriods shouldBe rule.window.datapointsToAlarm
    block.attribute("severity") shouldBe rule.severity.name.lowercase()
    (block.attribute("missing") ?: "notBreaching") shouldBe
        if (rule.window.missingData == MissingData.BREACHING) "breaching" else "notBreaching"
    (block.attribute("training_only") ?: "false") shouldBe rule.trainingOnly.toString()
    if (rule.metric.statistic == Statistic.P95) {
        block.attribute("extended_statistic") shouldBe "p95"
    } else if (rule.metric.name != "ProjectionMismatchGames" && block.attribute("statistic") != null) {
        block.attribute("statistic") shouldBe rule.metric.statistic.terraform()
    }
    rule.metric.namespace?.let { block.contains("local.synthetics") shouldBe true }
}

class ObservabilityDefinitionSpec :
    FunSpec({
        context("アラームの表と Terraform の一致（NF-O4）") {
            val blocks = terraformBlocks(ALARMS_TF.readText())

            test("[NF-O4] Given 表と alarms.tf When 名前を比べる Then 同じ集合") {
                blocks.keys shouldBe AlarmCatalog.rules.map { it.name }.toSet()
            }

            AlarmCatalog.rules.forEach { rule ->
                test("[NF-O4] Given アラーム ${rule.name} When 閾値・期間・評価・欠測・重大度を比べる Then Terraform と同じ") {
                    check(rule, blocks.getValue(rule.name))
                }
            }

            test("[NF-O4] Given 重大のアラーム When 数える Then 表と同じ数（通知は 重大 と 警告 の 2 系統）") {
                blocks.values.count { it.attribute("severity") == "critical" } shouldBe
                    AlarmCatalog.rules.count { it.severity == Severity.CRITICAL }
            }
        }

        context("保守・保持モードのメトリクス（AC6.1.6）") {
            test("[AC6.1.6] Given 投影の不一致 When verify の結果を記録する Then メトリクスが出て、終了コードは 1") {
                val metrics = CollectingMetrics()
                val drift = GameInconsistency(GAME, listOf(Inconsistency.RowDrift("game_overview", 1, 0)))
                val report = VerifyReport(1, listOf(drift), emptyList(), emptyList(), Duration.ZERO)

                reportVerify(Either.Right(report), NoLogs, metrics, AT) shouldBe 1

                metrics.samples.first { it.name == MetricNames.PROJECTION_MISMATCH_GAMES }.value shouldBe 1.0
                metrics.samples.all { it.at == AT } shouldBe true
            }

            test("[AC6.1.6] Given 一覧を読めない When verify の結果を記録する Then メトリクスは出さない") {
                val metrics = CollectingMetrics()

                reportVerify(Either.Left(AppFailure.RetryExhausted), NoLogs, metrics, AT) shouldBe 70

                metrics.samples.size shouldBe 0
            }

            test("[AC6.1.6] Given 削除が 1 件・放棄が 0 件 When 掃引の結果を記録する Then 放棄 0・削除 1 のメトリクスが出る") {
                val metrics = CollectingMetrics()

                reportSweep(Either.Right(SweepReport(listOf(GAME), emptyList(), 0)), NoLogs, metrics, AT) shouldBe 0

                metrics.samples.first { it.name == MetricNames.RETENTION_ABANDONED_GAMES }.value shouldBe 0.0
                metrics.samples.first { it.name == MetricNames.RETENTION_DELETED_GAMES }.value shouldBe 1.0
            }
        }

        context("JVM の定期の読み取り（NF-O12）") {
            test("[NF-O12] Given 2 回の読み取り When 1 周期ずつ記録する Then 2 回目は GC の差から停止時間を出す") {
                val metrics = CollectingMetrics()
                val readings =
                    ArrayDeque(
                        listOf(
                            JvmReading(100, 1000, 1, 10),
                            JvmReading(500, 1000, 3, 50),
                        ),
                    )
                val sampler = JvmSampler(metrics, { readings.removeFirst() }, { AT })

                sampler.sampleOnce()
                sampler.sampleOnce()
                sampler.close()

                metrics.samples
                    .filter { it.name == MetricNames.JVM_GC_PAUSE_MILLIS }
                    .map { it.value } shouldBe listOf(0.0, 20.0)
                metrics.samples
                    .filter { it.name == MetricNames.JVM_HEAP_USED_PERCENT }
                    .map { it.value } shouldBe listOf(10.0, 50.0)
            }

            test("[NF-O12] Given 読み取りが失敗する When 記録する Then 例外を出さず、次の周期で読み直す") {
                val metrics = CollectingMetrics()
                var calls = 0
                val sampler =
                    JvmSampler(metrics, {
                        calls++
                        if (calls == 1) error("読めない") else JvmReading(100, 1000, 0, 0)
                    }, { AT })

                sampler.sampleOnce()
                sampler.sampleOnce()
                sampler.close()

                metrics.samples.count { it.name == MetricNames.JVM_HEAP_USED_PERCENT } shouldBe 1
            }

            test("[NF-O12] Given この JVM When 読む Then ヒープの上限と使用量が正の値") {
                val reading = readJvm(null)

                (reading.heapUsedBytes > 0) shouldBe true
                (reading.heapMaxBytes > 0) shouldBe true
                reading.poolActive shouldBe null
            }
        }
    })
