package beergame.http

import beergame.application.MetricNames
import beergame.application.MetricSample
import beergame.application.MetricSink
import beergame.application.MetricUnit
import io.kotest.core.spec.style.FunSpec
import io.kotest.matchers.shouldBe
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.double
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.io.ByteArrayOutputStream
import java.io.PrintStream
import java.time.Instant

/*
 * メトリクスの出力（BD9。AC6.1.3）。CloudWatch の Embedded Metric Format に従った JSON の 1 行になること。
 */

private val AT: Instant = Instant.parse("2026-11-16T10:00:00.123Z")

private fun sample(
    name: String,
    value: Double,
    unit: MetricUnit = MetricUnit.COUNT,
    operation: String? = null,
) = MetricSample(name, unit, value, AT, operation)

private fun parse(line: String): JsonObject = Json.parseToJsonElement(line).jsonObject

class EmfMetricSinkSpec :
    FunSpec({
        test("[AC6.1.3] Given 操作つきの 2 つの観測 When 行にする Then 1 行にまとまり、EMF の宣言と値を持つ") {
            val lines =
                emfLines(
                    "staging",
                    listOf(
                        sample(MetricNames.REQUEST_COUNT, 1.0, operation = "commitWeek"),
                        sample(MetricNames.REQUEST_DURATION_MILLIS, 12.0, MetricUnit.MILLISECONDS, "commitWeek"),
                    ),
                )

            lines.size shouldBe 1
            val json = parse(lines.single())
            val aws = json.getValue("_aws").jsonObject
            aws.getValue("Timestamp").jsonPrimitive.content shouldBe AT.toEpochMilli().toString()
            val declaration =
                aws
                    .getValue("CloudWatchMetrics")
                    .jsonArray
                    .single()
                    .jsonObject
            declaration.getValue("Namespace").jsonPrimitive.content shouldBe "BeerGame/Kotlin"
            declaration.getValue("Dimensions") shouldBe
                JsonArray(
                    listOf(
                        JsonArray(listOf(JsonPrimitive("Environment"))),
                        JsonArray(listOf(JsonPrimitive("Environment"), JsonPrimitive("Operation"))),
                    ),
                )
            declaration
                .getValue("Metrics")
                .jsonArray
                .map {
                    it.jsonObject
                        .getValue("Name")
                        .jsonPrimitive.content to
                        it.jsonObject
                            .getValue("Unit")
                            .jsonPrimitive.content
                }.shouldBe(listOf("RequestCount" to "Count", "RequestDurationMillis" to "Milliseconds"))
            json.getValue("Environment").jsonPrimitive.content shouldBe "staging"
            json.getValue("Operation").jsonPrimitive.content shouldBe "commitWeek"
            json.getValue("RequestDurationMillis").jsonPrimitive.double shouldBe 12.0
        }

        test("[AC6.1.3] Given 操作の無い観測 When 行にする Then ディメンションは Environment だけで、Operation を持たない") {
            val json =
                parse(
                    emfLines(
                        "production",
                        listOf(sample(MetricNames.JVM_HEAP_USED_PERCENT, 55.0, MetricUnit.PERCENT)),
                    ).single(),
                )

            val dimensions =
                json
                    .getValue("_aws")
                    .jsonObject
                    .getValue("CloudWatchMetrics")
                    .jsonArray
                    .single()
                    .jsonObject
                    .getValue("Dimensions")
            dimensions shouldBe JsonArray(listOf(JsonArray(listOf(JsonPrimitive("Environment")))))
            json.containsKey("Operation") shouldBe false
        }

        test("[AC6.1.3] Given 同じ名前の観測が 2 件 When 行にする Then 同じ行に 2 回入れず、2 行に分ける") {
            val lines =
                emfLines(
                    "staging",
                    listOf(
                        sample(MetricNames.CONCURRENCY_CONFLICT, 1.0),
                        sample(MetricNames.CONCURRENCY_CONFLICT, 0.0),
                    ),
                )

            lines.map { parse(it).getValue(MetricNames.CONCURRENCY_CONFLICT).jsonPrimitive.double } shouldBe
                listOf(1.0, 0.0)
        }

        test("[AC6.1.5] Given 主要な操作の成功 When 行にする Then 1 秒の解像度で宣言する。ほかは標準の解像度") {
            val json =
                parse(
                    emfLines(
                        "staging",
                        listOf(
                            sample(MetricNames.MAIN_OPERATION_SUCCESS, 1.0, operation = "commitWeek"),
                            sample(MetricNames.REQUEST_COUNT, 1.0, operation = "commitWeek"),
                        ),
                    ).single(),
                )

            val metrics =
                json
                    .getValue("_aws")
                    .jsonObject
                    .getValue("CloudWatchMetrics")
                    .jsonArray
                    .single()
                    .jsonObject
                    .getValue("Metrics")
                    .jsonArray
                    .map { it.jsonObject }
            metrics
                .first { it.getValue("Name").jsonPrimitive.content == "MainOperationSuccess" }
                .getValue("StorageResolution")
                .jsonPrimitive.content shouldBe "1"
            metrics
                .first { it.getValue("Name").jsonPrimitive.content == "RequestCount" }
                .containsKey("StorageResolution") shouldBe false
        }

        test("[AC6.1.3] Given 操作が違う観測 When 行にする Then 操作ごとに別の行") {
            val lines =
                emfLines(
                    "staging",
                    listOf(
                        sample(MetricNames.REQUEST_COUNT, 1.0, operation = "createGame"),
                        sample(MetricNames.REQUEST_COUNT, 1.0, operation = "joinGame"),
                    ),
                )

            lines.map { parse(it).getValue("Operation").jsonPrimitive.content } shouldBe
                listOf("createGame", "joinGame")
        }

        test("[AC6.1.3] Given シンク When 記録する Then 出力先へ 1 行ずつ書く") {
            val buffer = ByteArrayOutputStream()
            val sink: MetricSink = EmfMetricSink("staging", PrintStream(buffer, true, Charsets.UTF_8))

            sink.record(listOf(sample(MetricNames.RETENTION_ABANDONED_GAMES, 2.0)))

            val written = buffer.toString(Charsets.UTF_8).trim().lines()
            written.size shouldBe 1
            parse(written.single()).getValue(MetricNames.RETENTION_ABANDONED_GAMES).jsonPrimitive.double shouldBe 2.0
        }

        test("[NF-S14] MetricSample は、ゲーム ID・表示名・資格を持つ場所が無い（項目の許可リスト。足すと人が確かめる）") {
            MetricSample::class.java.declaredFields
                .map { it.name }
                .toSet() shouldBe setOf("name", "unit", "value", "at", "operation")
        }
    })
