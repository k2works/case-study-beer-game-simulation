package beergame.http

import beergame.application.MetricNames
import beergame.application.MetricSample
import beergame.application.MetricSink
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.io.PrintStream

/*
 * メトリクスの出力（BD9）。CloudWatch の Embedded Metric Format の JSON 行を、自前の小さな関数で標準出力へ出す
 * （追加のサーバーも依存も持たない）。コンテナのログドライバが CloudWatch Logs へ送り、CloudWatch がメトリクスに取り出す。
 * ディメンションは、`Environment` と、操作のあるものは `Environment` + `Operation` の 2 組。ゲーム ID・表示名・資格は、
 * [MetricSample] に持ち場所が無いので、出力にも入らない（NF-S14）。
 */

const val METRIC_NAMESPACE = "BeerGame/Kotlin"

private const val ENVIRONMENT = "Environment"
private const val OPERATION = "Operation"

private val EMF_JSON = Json { explicitNulls = false }

/** 1 秒の解像度で保存するメトリクス。10 秒の期間のアラーム（研修中の停止の検知。AC6.1.5）だけが使う（費用が高いので限る）。 */
private val HIGH_RESOLUTION = setOf(MetricNames.MAIN_OPERATION_SUCCESS)

/** 同じ時刻・同じ操作の観測を、名前が重ならないように 1 行ずつまとめる（EMF は 1 行に同じ名前を 2 回持てない）。 */
private fun chunks(samples: List<MetricSample>): List<List<MetricSample>> =
    samples.fold(mutableListOf<MutableList<MetricSample>>()) { lines, sample ->
        val target = lines.firstOrNull { line -> line.none { it.name == sample.name } }
        if (target != null) target.add(sample) else lines.add(mutableListOf(sample))
        lines
    }

private fun dimensions(operation: String?): JsonArray {
    val base = JsonArray(listOf(JsonPrimitive(ENVIRONMENT)))
    return if (operation == null) {
        JsonArray(listOf(base))
    } else {
        JsonArray(listOf(base, JsonArray(listOf(JsonPrimitive(ENVIRONMENT), JsonPrimitive(OPERATION)))))
    }
}

private fun line(
    environment: String,
    samples: List<MetricSample>,
): String {
    val first = samples.first()
    val definitions =
        samples.map { sample ->
            buildJsonObject {
                put("Name", sample.name)
                put("Unit", sample.unit.cloudWatch)
                if (sample.name in HIGH_RESOLUTION) put("StorageResolution", 1)
            }
        }
    val declaration =
        buildJsonObject {
            put("Namespace", METRIC_NAMESPACE)
            put("Dimensions", dimensions(first.operation))
            put("Metrics", JsonArray(definitions))
        }
    val body =
        buildJsonObject {
            put(
                "_aws",
                buildJsonObject {
                    put("Timestamp", first.at.toEpochMilli())
                    put("CloudWatchMetrics", JsonArray(listOf(declaration)))
                },
            )
            put(ENVIRONMENT, environment)
            first.operation?.let { put(OPERATION, it) }
            samples.forEach { put(it.name, it.value) }
        }
    return EMF_JSON.encodeToString(JsonObject.serializer(), body)
}

/** 観測を EMF の行にする。操作と時刻（ミリ秒）が同じものを 1 行にまとめる。純粋な関数。 */
fun emfLines(
    environment: String,
    samples: List<MetricSample>,
): List<String> =
    samples
        .groupBy { it.operation to it.at.toEpochMilli() }
        .values
        .flatMap { group -> chunks(group).map { line(environment, it) } }

/** EMF の行を [out] へ 1 行ずつ出す。出力の失敗は、処理に影響させない（PrintStream は例外を投げない）。 */
class EmfMetricSink(
    private val environment: String,
    private val out: PrintStream = System.out,
) : MetricSink {
    override fun record(samples: List<MetricSample>) {
        emfLines(environment, samples).forEach { out.println(it) }
        out.flush()
    }
}
