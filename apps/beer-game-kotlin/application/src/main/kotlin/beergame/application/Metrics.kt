package beergame.application

import java.time.Instant

/*
 * メトリクス（B13。NF-O3、NF-O12）。アプリケーションは、メトリクスの値を [MetricSink] へ渡すだけで、出力の形（EMF）は知らない。
 * **ゲーム ID・表示名・資格・参加コードは、型に持たない**（NF-S14。ログの `LogRecord` と同じ方針）。
 * ディメンションは、操作の名前（OpenAPI の operationId。固定の集合）だけ。環境の名前は、出力側が足す。
 */

/** メトリクスの単位（CloudWatch の単位）。 */
enum class MetricUnit(
    val cloudWatch: String,
) {
    COUNT("Count"),
    MILLISECONDS("Milliseconds"),
    PERCENT("Percent"),
}

/** 1 回の観測。[operation] があるときは、操作ごとの系列にもなる。 */
data class MetricSample(
    val name: String,
    val unit: MetricUnit,
    val value: Double,
    val at: Instant,
    val operation: String? = null,
)

/** メトリクスの出力先。呼び出しを遅くしない・失敗させないこと（出力の失敗は、処理に影響させない）。 */
fun interface MetricSink {
    fun record(samples: List<MetricSample>)

    companion object {
        /** 何も出さない（試験と、計測が要らない呼び出し）。 */
        val None: MetricSink = MetricSink { }
    }
}

/** メトリクスの名前。アラームの表（[AlarmCatalog]）、Terraform、ダッシュボードが、同じ名前を使う。 */
object MetricNames {
    const val REQUEST_COUNT = "RequestCount"
    const val REQUEST_DURATION_MILLIS = "RequestDurationMillis"

    /** 5xx なら 1、そうでなければ 0（平均が、5xx の割合になる）。 */
    const val SERVER_ERROR = "ServerError"

    /** 主要な操作が成功したとき 1（研修中の停止の検知）。 */
    const val MAIN_OPERATION_SUCCESS = "MainOperationSuccess"

    /** コマンドの試行ごとに、追記の競合なら 1、そうでなければ 0（平均が、自動再試行の前の競合率になる）。 */
    const val CONCURRENCY_CONFLICT = "ConcurrencyConflict"

    /** 自動再試行を使い切って、利用者へ失敗を返したとき 1。 */
    const val RETRY_EXHAUSTED = "RetryExhausted"

    const val PROJECTION_MISMATCH_GAMES = "ProjectionMismatchGames"
    const val PROJECTION_LAG_GAMES = "ProjectionLagGames"
    const val PROJECTION_UNCHECKED_GAMES = "ProjectionUncheckedGames"
    const val RETENTION_ABANDONED_GAMES = "RetentionAbandonedGames"
    const val RETENTION_DELETED_GAMES = "RetentionDeletedGames"
    const val JVM_HEAP_USED_PERCENT = "JvmHeapUsedPercent"
    const val JVM_GC_PAUSE_MILLIS = "JvmGcPauseMillis"
    const val DB_POOL_UTILIZATION_PERCENT = "DbPoolUtilizationPercent"
}

/** 主要な操作（研修中に 1 分間成功しないと通知する対象。AC6.1.5）。 */
object MainOperations {
    val names: Set<String> = setOf("createGame", "joinGame", "saveDecision", "commitWeek")

    fun isMain(operation: String): Boolean = operation in names
}

/** 1 回の HTTP 要求の結果。 */
data class RequestOutcome(
    val operation: String,
    val status: Int,
    val durationMillis: Long,
)

private const val SERVER_ERROR_FROM = 500
private const val CLIENT_ERROR_FROM = 400

/** HTTP 要求のメトリクス（応答時間、要求数、5xx の 0/1、主要な操作の成功）。 */
fun requestMetrics(
    outcome: RequestOutcome,
    at: Instant,
): List<MetricSample> {
    val op = outcome.operation
    val base =
        listOf(
            MetricSample(MetricNames.REQUEST_COUNT, MetricUnit.COUNT, 1.0, at, op),
            MetricSample(
                MetricNames.REQUEST_DURATION_MILLIS,
                MetricUnit.MILLISECONDS,
                outcome.durationMillis.toDouble(),
                at,
                op,
            ),
            MetricSample(
                MetricNames.SERVER_ERROR,
                MetricUnit.COUNT,
                if (outcome.status >= SERVER_ERROR_FROM) 1.0 else 0.0,
                at,
                op,
            ),
        )
    val success = outcome.status < CLIENT_ERROR_FROM && MainOperations.isMain(op)
    return if (success) base + MetricSample(MetricNames.MAIN_OPERATION_SUCCESS, MetricUnit.COUNT, 1.0, at, op) else base
}

/** 追記の試行の結果（競合の件数と、再試行の上限超過）。 */
enum class AttemptOutcome { PROCEEDED, CONFLICT, EXHAUSTED }

/** コマンドの試行ごとのメトリクス。競合は試行ごとに 0/1、上限超過は起きたときだけ 1。 */
fun attemptMetrics(
    outcome: AttemptOutcome,
    at: Instant,
): List<MetricSample> {
    val conflict = if (outcome == AttemptOutcome.PROCEEDED) 0.0 else 1.0
    val base = listOf(MetricSample(MetricNames.CONCURRENCY_CONFLICT, MetricUnit.COUNT, conflict, at))
    return if (outcome == AttemptOutcome.EXHAUSTED) {
        base + MetricSample(MetricNames.RETRY_EXHAUSTED, MetricUnit.COUNT, 1.0, at)
    } else {
        base
    }
}

/** 投影の整合の検査のメトリクス（不一致のゲーム数、進んだ版が遅れているゲーム数、検査できなかったゲーム数）。 */
fun verifyMetrics(
    report: VerifyReport,
    at: Instant,
): List<MetricSample> {
    val lagging =
        report.inconsistent.count { game -> game.findings.any { it is Inconsistency.CheckpointDrift } }
    val mismatching =
        report.inconsistent.count { game -> game.findings.any { it !is Inconsistency.CheckpointDrift } }
    return listOf(
        MetricSample(MetricNames.PROJECTION_MISMATCH_GAMES, MetricUnit.COUNT, mismatching.toDouble(), at),
        MetricSample(MetricNames.PROJECTION_LAG_GAMES, MetricUnit.COUNT, lagging.toDouble(), at),
        MetricSample(
            MetricNames.PROJECTION_UNCHECKED_GAMES,
            MetricUnit.COUNT,
            (report.skipped.size + report.failed.size).toDouble(),
            at,
        ),
    )
}

/** 保持削除の掃引のメトリクス（再試行をやめたゲーム数、削除したゲーム数）。 */
fun sweepMetrics(
    report: SweepReport,
    at: Instant,
): List<MetricSample> =
    listOf(
        MetricSample(MetricNames.RETENTION_ABANDONED_GAMES, MetricUnit.COUNT, report.abandoned.size.toDouble(), at),
        MetricSample(MetricNames.RETENTION_DELETED_GAMES, MetricUnit.COUNT, report.completed.size.toDouble(), at),
    )
