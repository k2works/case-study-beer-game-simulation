package beergame.app

import beergame.application.JvmReading
import beergame.application.MetricSink
import beergame.application.jvmMetrics
import com.zaxxer.hikari.HikariDataSource
import java.lang.management.ManagementFactory
import java.time.Instant
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

/*
 * JVM と接続プールのメトリクスの定期の読み取り（NF-O12）。60 秒ごとに MXBean とプールを読み、差から [jvmMetrics] を作って出す。
 * 読み取りが失敗しても、API には影響させない（次の周期で読み直す）。
 */

private const val SAMPLE_INTERVAL_SECONDS = 60L

/** MXBean とプール（無ければ null）から、いまの読み取りを作る。 */
internal fun readJvm(pool: HikariDataSource?): JvmReading {
    val heap = ManagementFactory.getMemoryMXBean().heapMemoryUsage
    val collectors = ManagementFactory.getGarbageCollectorMXBeans()
    val poolBean = pool?.hikariPoolMXBean
    return JvmReading(
        heapUsedBytes = heap.used,
        heapMaxBytes = heap.max,
        gcCount = collectors.sumOf { it.collectionCount.coerceAtLeast(0L) },
        gcTimeMillis = collectors.sumOf { it.collectionTime.coerceAtLeast(0L) },
        poolActive = poolBean?.activeConnections,
        poolMax = pool?.maximumPoolSize,
    )
}

/** 起動したら定期に読み取る。[close] で止める。デーモンのスレッドなので、止め忘れてもプロセスの終了を妨げない。 */
internal class JvmSampler(
    private val sink: MetricSink,
    private val read: () -> JvmReading,
    private val now: () -> Instant = Instant::now,
) : AutoCloseable {
    private val executor: ScheduledExecutorService =
        Executors.newSingleThreadScheduledExecutor { task ->
            Thread(task, "beergame-jvm-sampler").apply { isDaemon = true }
        }
    private val previous = AtomicReference<JvmReading?>(null)

    fun start(): JvmSampler {
        executor.scheduleAtFixedRate(::sampleOnce, SAMPLE_INTERVAL_SECONDS, SAMPLE_INTERVAL_SECONDS, TimeUnit.SECONDS)
        return this
    }

    /** 1 回読んで出す。失敗しても、例外で周期を止めず、次の周期に読み直す（失敗した周期は、メトリクスが欠測になる）。 */
    internal fun sampleOnce() {
        runCatching {
            val current = read()
            sink.record(jvmMetrics(previous.get(), current, now()))
            previous.set(current)
        }
    }

    override fun close() {
        executor.shutdownNow()
    }
}
