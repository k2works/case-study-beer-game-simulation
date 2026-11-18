package beergame.application

import java.time.Instant

/*
 * JVM と接続プールのメトリクス（NF-O12）。読み取り（MXBean、プール）は `app` が行い、ここは、読み取った値から
 * メトリクスを作る純粋な関数だけを持つ。
 */

/** ある時点の JVM とプールの読み取り。GC の値は起動からの累計。プールの値が無い（プールを持たない）ときは null。 */
data class JvmReading(
    val heapUsedBytes: Long,
    val heapMaxBytes: Long,
    val gcCount: Long,
    val gcTimeMillis: Long,
    val poolActive: Int? = null,
    val poolMax: Int? = null,
)

private const val PERCENT = 100.0

/**
 * 読み取りの差から、ヒープの使用率、GC の 1 回あたりの停止時間（前回からの区間の平均。GC が無ければ 0）、
 * 接続プールの使用率を作る。GC の停止時間の p99 は、MXBean からは得られないので、区間の平均で近似する。
 */
fun jvmMetrics(
    previous: JvmReading?,
    current: JvmReading,
    at: Instant,
): List<MetricSample> {
    val heap =
        if (current.heapMaxBytes > 0) PERCENT * current.heapUsedBytes / current.heapMaxBytes else 0.0
    val collections = current.gcCount - (previous?.gcCount ?: current.gcCount)
    val gcMillis = current.gcTimeMillis - (previous?.gcTimeMillis ?: current.gcTimeMillis)
    val pause = if (collections > 0) gcMillis.toDouble() / collections else 0.0
    val base =
        listOf(
            MetricSample(MetricNames.JVM_HEAP_USED_PERCENT, MetricUnit.PERCENT, heap, at),
            MetricSample(MetricNames.JVM_GC_PAUSE_MILLIS, MetricUnit.MILLISECONDS, pause, at),
        )
    val active = current.poolActive
    val max = current.poolMax
    return if (active != null && max != null && max > 0) {
        base + MetricSample(MetricNames.DB_POOL_UTILIZATION_PERCENT, MetricUnit.PERCENT, PERCENT * active / max, at)
    } else {
        base
    }
}
