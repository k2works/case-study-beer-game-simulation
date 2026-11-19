package beergame.application

/*
 * アラームの閾値の表（設計書 operation.md「監視項目と閾値」）。Terraform（`infra/modules/observability/alarms.tf`）と同じ値で、
 * 食い違いは `AlarmCatalogSpec` が検出する。「提案」と書かれた閾値は、実装後の実測で見直す（設計書のとおり）。
 */
object AlarmCatalog {
    /** CloudWatch Synthetics の名前空間（合成監視の `SuccessPercent`）。 */
    const val SYNTHETICS_NAMESPACE = "CloudWatchSynthetics"

    private const val MINUTE = 60
    private const val FIVE_MINUTES = 300
    private const val TEN_MINUTES = 600
    private const val HOUR = 3_600
    private const val DAY = 86_400
    private const val STALL_PERIOD = 10
    private const val STALL_PERIODS = 5

    private fun app(
        name: String,
        statistic: Statistic,
    ) = MetricSpec(name, statistic)

    private fun above(threshold: Double) = Condition(Comparison.GREATER_THAN, threshold)

    private fun window(
        period: Int,
        periods: Int,
        missing: MissingData = MissingData.NOT_BREACHING,
    ) = AlarmWindow(period, periods, periods, missing)

    private fun rule(
        name: String,
        metric: MetricSpec,
        condition: Condition,
        window: AlarmWindow,
        severity: Severity,
    ) = AlarmRule(name, metric, condition, window, severity)

    private val availability =
        listOf(
            AlarmRule(
                name = "main-operation-stall",
                metric = app(MetricNames.MAIN_OPERATION_SUCCESS, Statistic.SUM),
                condition = Condition(Comparison.LESS_THAN, threshold = 1.0),
                window = window(STALL_PERIOD, STALL_PERIODS, MissingData.BREACHING),
                severity = Severity.CRITICAL,
                trainingOnly = true,
            ),
            rule(
                "synthetic-failure",
                MetricSpec("SuccessPercent", Statistic.AVERAGE, SYNTHETICS_NAMESPACE),
                Condition(Comparison.LESS_THAN, threshold = 100.0),
                window(MINUTE, 1, MissingData.BREACHING),
                Severity.CRITICAL,
            ),
            rule(
                "http-5xx-rate-warning",
                app(MetricNames.SERVER_ERROR, Statistic.AVERAGE),
                above(threshold = 0.01),
                window(FIVE_MINUTES, 1),
                Severity.WARNING,
            ),
            rule(
                "http-5xx-rate-critical",
                app(MetricNames.SERVER_ERROR, Statistic.AVERAGE),
                above(threshold = 0.05),
                window(MINUTE, 1),
                Severity.CRITICAL,
            ),
            rule(
                "api-latency-p95-warning",
                app(MetricNames.REQUEST_DURATION_MILLIS, Statistic.P95),
                above(threshold = 800.0),
                window(FIVE_MINUTES, 1),
                Severity.WARNING,
            ),
            rule(
                "api-latency-p95-critical",
                app(MetricNames.REQUEST_DURATION_MILLIS, Statistic.P95),
                above(threshold = 1000.0),
                window(FIVE_MINUTES, 1),
                Severity.CRITICAL,
            ),
        )

    private val appends =
        listOf(
            rule(
                "append-conflict-rate-warning",
                app(MetricNames.CONCURRENCY_CONFLICT, Statistic.AVERAGE),
                above(threshold = 0.05),
                window(FIVE_MINUTES, 1),
                Severity.WARNING,
            ),
            rule(
                "append-conflict-rate-critical",
                app(MetricNames.CONCURRENCY_CONFLICT, Statistic.AVERAGE),
                above(threshold = 0.20),
                window(FIVE_MINUTES, 1),
                Severity.CRITICAL,
            ),
            rule(
                "retry-exhausted-warning",
                app(MetricNames.RETRY_EXHAUSTED, Statistic.SUM),
                above(threshold = 0.0),
                window(FIVE_MINUTES, 1),
                Severity.WARNING,
            ),
            rule(
                "retry-exhausted-critical",
                app(MetricNames.RETRY_EXHAUSTED, Statistic.SUM),
                above(threshold = 4.0),
                window(FIVE_MINUTES, 1),
                Severity.CRITICAL,
            ),
        )

    private val batch =
        listOf(
            rule(
                "projection-mismatch",
                app(MetricNames.PROJECTION_MISMATCH_GAMES, Statistic.MAXIMUM),
                above(threshold = 0.0),
                window(DAY, 1),
                Severity.CRITICAL,
            ),
            rule(
                "projection-lag",
                app(MetricNames.PROJECTION_LAG_GAMES, Statistic.MAXIMUM),
                above(threshold = 0.0),
                window(DAY, 1),
                Severity.CRITICAL,
            ),
            rule(
                "retention-abandoned",
                app(MetricNames.RETENTION_ABANDONED_GAMES, Statistic.MAXIMUM),
                above(threshold = 0.0),
                window(FIVE_MINUTES, 1),
                Severity.CRITICAL,
            ),
            // 心拍（B14）: 定期タスクが動くたびに出るメトリクスが、期間の中に 1 つも無い（欠測）なら発報する。
            // 値は 0 以上なので、「0 未満」は決して成り立たない。発報の理由は欠測だけ（欠測を超過とみなす）。
            rule(
                "projection-verify-heartbeat",
                app(MetricNames.PROJECTION_MISMATCH_GAMES, Statistic.MAXIMUM),
                Condition(Comparison.LESS_THAN, threshold = 0.0),
                window(DAY, 1, MissingData.BREACHING),
                Severity.WARNING,
            ),
            rule(
                "retention-heartbeat",
                app(MetricNames.RETENTION_ABANDONED_GAMES, Statistic.MAXIMUM),
                Condition(Comparison.LESS_THAN, threshold = 0.0),
                window(HOUR, 1, MissingData.BREACHING),
                Severity.WARNING,
            ),
        )

    private val runtime =
        listOf(
            rule(
                "jvm-heap-warning",
                app(MetricNames.JVM_HEAP_USED_PERCENT, Statistic.MAXIMUM),
                above(threshold = 70.0),
                window(MINUTE, TEN_MINUTES / MINUTE),
                Severity.WARNING,
            ),
            rule(
                "jvm-heap-critical",
                app(MetricNames.JVM_HEAP_USED_PERCENT, Statistic.MAXIMUM),
                above(threshold = 85.0),
                window(MINUTE, TEN_MINUTES / MINUTE),
                Severity.CRITICAL,
            ),
            rule(
                "jvm-gc-pause-warning",
                app(MetricNames.JVM_GC_PAUSE_MILLIS, Statistic.MAXIMUM),
                above(threshold = 200.0),
                window(MINUTE, FIVE_MINUTES / MINUTE),
                Severity.WARNING,
            ),
            rule(
                "jvm-gc-pause-critical",
                app(MetricNames.JVM_GC_PAUSE_MILLIS, Statistic.MAXIMUM),
                above(threshold = 500.0),
                window(MINUTE, FIVE_MINUTES / MINUTE),
                Severity.CRITICAL,
            ),
            rule(
                "db-pool-utilization-warning",
                app(MetricNames.DB_POOL_UTILIZATION_PERCENT, Statistic.MAXIMUM),
                above(threshold = 70.0),
                window(MINUTE, TEN_MINUTES / MINUTE),
                Severity.WARNING,
            ),
            rule(
                "db-pool-utilization-critical",
                app(MetricNames.DB_POOL_UTILIZATION_PERCENT, Statistic.MAXIMUM),
                above(threshold = 80.0),
                window(MINUTE, TEN_MINUTES / MINUTE),
                Severity.CRITICAL,
            ),
        )

    val rules: List<AlarmRule> = availability + appends + batch + runtime

    fun named(name: String): AlarmRule = rules.first { it.name == name }
}
