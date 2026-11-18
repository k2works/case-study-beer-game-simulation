package beergame.application

import io.kotest.core.spec.style.FunSpec
import io.kotest.matchers.shouldBe
import java.time.Duration
import java.time.Instant

/*
 * アラームの評価と、アラームの訓練（B13。AC6.1.3、AC6.1.5）。時刻は、基準（T0）からの秒数で表す模擬の時計で、
 * 実際の待機はしない。故障は、メトリクスの系列の欠け・急増として与える。
 */

private val EPOCH: Instant = Instant.parse("2026-11-16T10:00:00Z")

private fun at(seconds: Long): Instant = EPOCH.plusSeconds(seconds)

private fun sample(
    name: String,
    value: Double,
    seconds: Long,
) = MetricSample(name, MetricUnit.COUNT, value, at(seconds))

/** 5 秒ごとの成功。[stopAt] の時刻より前だけ。[gap] の区間は成功しない。 */
private fun successes(
    stopAt: Long,
    from: Long = 0,
    gap: LongRange = LongRange.EMPTY,
): List<MetricSample> =
    (from until stopAt step 5)
        .filter { it !in gap }
        .map { sample(MetricNames.MAIN_OPERATION_SUCCESS, 1.0, it) }

/** 合成監視。60 秒ごとに実行し、[stopAt] 以降は失敗（0）を報告する。 */
private fun canary(
    stopAt: Long,
    until: Long,
): List<MetricSample> = (0L until until step 60).map { sample("SuccessPercent", if (it < stopAt) 100.0 else 0.0, it) }

private fun delayOf(
    name: String,
    samples: List<MetricSample>,
    faultAt: Long,
    until: Long = faultAt + 600,
    training: Boolean = true,
): Duration? = detectionDelay(AlarmCatalog.named(name), samples, at(faultAt), at(until), training = training)

/** 発報して（null でなく）、その時間が [seconds] 秒以内であること。 */
private infix fun Duration?.within(seconds: Long) {
    (this != null && this <= Duration.ofSeconds(seconds)) shouldBe true
}

private fun stateOf(
    name: String,
    samples: List<MetricSample>,
    seconds: Long,
): AlarmState = evaluateAlarms(listOf(AlarmCatalog.named(name)), samples, at(seconds)).single().state

class AlarmsSpec :
    FunSpec({
        context("アラームの評価（CloudWatch と同じ意味）") {
            val rule =
                AlarmRule(
                    name = "x",
                    metric = MetricSpec("M", Statistic.SUM),
                    condition = Condition(Comparison.GREATER_THAN, 2.0),
                    window = AlarmWindow(60, 3, 2, MissingData.NOT_BREACHING),
                    severity = Severity.WARNING,
                )

            fun state(
                samples: List<MetricSample>,
                seconds: Long,
                r: AlarmRule = rule,
            ) = evaluateAlarms(listOf(r), samples, at(seconds)).single().state

            test("Given 3 期間のうち 2 期間が超過 When 評価する Then 発報する。1 期間だけなら OK") {
                val two = listOf(sample("M", 3.0, 70), sample("M", 3.0, 130))
                val one = listOf(sample("M", 3.0, 130))

                state(two, 180) shouldBe AlarmState.ALARM
                state(one, 180) shouldBe AlarmState.OK
            }

            test("Given 閾値ちょうど When 評価する Then 超過ではない（GREATER_THAN は厳密に大きい）") {
                state(listOf(sample("M", 2.0, 70), sample("M", 2.0, 130)), 180) shouldBe AlarmState.OK
            }

            test("Given 期間の途中の時刻 When 評価する Then 直前に終わった期間までを見る（未完の期間は見ない）") {
                val samples = listOf(sample("M", 3.0, 70), sample("M", 3.0, 130))

                state(samples, 185) shouldBe AlarmState.ALARM
                state(samples, 179) shouldBe AlarmState.OK
                state(samples, 119) shouldBe AlarmState.OK
            }

            test("Given 欠測 When 欠測を超過とみなす設定 Then 観測が無いだけで発報する") {
                val breaching = rule.copy(window = rule.window.copy(missingData = MissingData.BREACHING))

                state(emptyList(), 180, breaching) shouldBe AlarmState.ALARM
                state(emptyList(), 180) shouldBe AlarmState.OK
            }

            test("Given 統計が平均・最大・p95 When 評価する Then それぞれの値で比べる") {
                val values = (1..20).map { sample("M", it.toDouble(), 10L) }
                val one = rule.window.copy(evaluationPeriods = 1, datapointsToAlarm = 1)

                fun fires(
                    statistic: Statistic,
                    threshold: Double,
                ) = state(
                    values,
                    60,
                    rule.copy(
                        metric = MetricSpec("M", statistic),
                        condition = Condition(Comparison.GREATER_THAN, threshold),
                        window = one,
                    ),
                )

                fires(Statistic.AVERAGE, 10.0) shouldBe AlarmState.ALARM
                fires(Statistic.AVERAGE, 10.5) shouldBe AlarmState.OK
                fires(Statistic.MAXIMUM, 19.0) shouldBe AlarmState.ALARM
                fires(Statistic.P95, 18.0) shouldBe AlarmState.ALARM
                fires(Statistic.P95, 19.0) shouldBe AlarmState.OK
            }

            test("Given 研修中だけの規則 When 研修中でない Then 評価しても発報しない") {
                val stalled = AlarmCatalog.named("main-operation-stall")

                evaluateAlarms(listOf(stalled), emptyList(), at(600), training = false).single().state shouldBe
                    AlarmState.OK
                evaluateAlarms(listOf(stalled), emptyList(), at(600), training = true).single().state shouldBe
                    AlarmState.ALARM
            }
        }

        context("訓練: 研修中の停止を 1 分以内に検知できるか（AC6.1.5）") {
            test("Given 5 秒ごとに成功 When 時刻 120 秒に停止 Then 停止から 60 秒以内に発報する（実際は 50 秒）") {
                val delay = delayOf("main-operation-stall", successes(stopAt = 120), faultAt = 120)

                delay shouldBe Duration.ofSeconds(50)
                delay within 60
            }

            test("Given 10 秒の期間の境界に合わない停止の時刻 When どの時刻に止まっても Then 停止から 60 秒以内に発報する") {
                (121L..130L).forEach { stop ->
                    val delay = delayOf("main-operation-stall", successes(stopAt = stop), faultAt = stop)

                    delay within 60
                }
            }

            test("Given 成功が止まっている間 When 停止の前 Then 発報しない（誤報なし）") {
                stateOf("main-operation-stall", successes(stopAt = 400), 300) shouldBe AlarmState.OK
            }

            test("Given 成功が 40 秒だけ途切れる When 回復する Then 発報しない") {
                val samples = successes(stopAt = 400, gap = 120L..159L)

                (120L..400L step 10).map { stateOf("main-operation-stall", samples, it) }.toSet() shouldBe
                    setOf(AlarmState.OK)
            }

            test("Given 研修中でない When 停止する Then 600 秒たっても発報しない") {
                delayOf("main-operation-stall", successes(stopAt = 120), faultAt = 120, training = false) shouldBe null
            }

            test("Given 合成監視（60 秒ごと）When 停止する Then 最悪でも 120 秒以内に発報する（1 分では保証できない）") {
                val worst = delayOf("synthetic-failure", canary(stopAt = 121, until = 600), faultAt = 121)
                val best = delayOf("synthetic-failure", canary(stopAt = 120, until = 600), faultAt = 120)

                worst within 120
                ((worst?.seconds ?: 0L) > 60L) shouldBe true
                best within 60
            }
        }

        context("訓練: 劣化の検知（AC6.1.3）") {
            fun conflicts(
                rateAfter: Double,
                from: Long,
            ): List<MetricSample> =
                (0L until 900 step 5).flatMap { t ->
                    val rate = if (t >= from) rateAfter else 0.01
                    (1..100).map { i -> sample(MetricNames.CONCURRENCY_CONFLICT, if (i <= rate * 100) 1.0 else 0.0, t) }
                }

            test("Given 競合率が 1% から 30% に急増 When 5 分の期間が終わる Then 警告と重大が発報する。平常は OK") {
                val samples = conflicts(0.30, from = 300)

                stateOf("append-conflict-rate-warning", samples, 300) shouldBe AlarmState.OK
                stateOf("append-conflict-rate-warning", samples, 600) shouldBe AlarmState.ALARM
                stateOf("append-conflict-rate-critical", samples, 600) shouldBe AlarmState.ALARM
            }

            test("Given 競合率が 10% When 評価する Then 警告だけが発報し、重大は発報しない") {
                val samples = conflicts(0.10, from = 0)

                stateOf("append-conflict-rate-warning", samples, 300) shouldBe AlarmState.ALARM
                stateOf("append-conflict-rate-critical", samples, 300) shouldBe AlarmState.OK
            }

            test("Given 5xx が 10% 続く When 1 分の期間が終わる Then 重大が 60 秒以内に発報する") {
                val errors =
                    (0L until 600 step 1).flatMap { t ->
                        (1..10).map { i ->
                            sample(MetricNames.SERVER_ERROR, if (t >= 120 && i == 1) 1.0 else 0.0, t)
                        }
                    }

                delayOf("http-5xx-rate-critical", errors, faultAt = 120) within 60
            }

            test("Given 再試行の上限超過が 1 件 When 評価する Then 警告のみ。5 件で重大") {
                val one = listOf(sample(MetricNames.RETRY_EXHAUSTED, 1.0, 10))
                val five = (1..5).map { sample(MetricNames.RETRY_EXHAUSTED, 1.0, it.toLong()) }

                stateOf("retry-exhausted-warning", one, 300) shouldBe AlarmState.ALARM
                stateOf("retry-exhausted-critical", one, 300) shouldBe AlarmState.OK
                stateOf("retry-exhausted-critical", five, 300) shouldBe AlarmState.ALARM
            }

            test("Given 投影の不一致が 1 件 When 評価する Then 重大が発報し、0 件なら発報しない") {
                val broken = listOf(sample(MetricNames.PROJECTION_MISMATCH_GAMES, 1.0, 100))
                val clean = listOf(sample(MetricNames.PROJECTION_MISMATCH_GAMES, 0.0, 100))

                stateOf("projection-mismatch", broken, 86_400) shouldBe AlarmState.ALARM
                stateOf("projection-mismatch", clean, 86_400) shouldBe AlarmState.OK
            }

            test("Given 削除を放棄したゲームが 1 件 When 評価する Then 重大が発報する") {
                val abandoned = listOf(sample(MetricNames.RETENTION_ABANDONED_GAMES, 1.0, 10))

                stateOf("retention-abandoned", abandoned, 300) shouldBe AlarmState.ALARM
            }

            test("Given ヒープが 75% で 10 分 When 評価する Then 警告だけ。90% なら重大") {
                fun heap(percent: Double) =
                    (0L until 660 step 60).map { sample(MetricNames.JVM_HEAP_USED_PERCENT, percent, it) }

                stateOf("jvm-heap-warning", heap(75.0), 660) shouldBe AlarmState.ALARM
                stateOf("jvm-heap-critical", heap(75.0), 660) shouldBe AlarmState.OK
                stateOf("jvm-heap-critical", heap(90.0), 660) shouldBe AlarmState.ALARM
            }

            test("Given ヒープが 90% で 5 分だけ When 評価する Then 10 分に満たないので発報しない（一時的な上昇を通知しない）") {
                val short = (0L until 300 step 60).map { sample(MetricNames.JVM_HEAP_USED_PERCENT, 90.0, it) }

                stateOf("jvm-heap-critical", short, 600) shouldBe AlarmState.OK
            }
        }

        context("アラームの表") {
            test("Given 表 When 数える Then 規則の名前は一意で、警告と重大が対になる項目がある") {
                val names = AlarmCatalog.rules.map { it.name }

                names.toSet().size shouldBe names.size
                AlarmCatalog.rules.count { it.severity == Severity.CRITICAL } shouldBe 12
                AlarmCatalog.rules.count { it.severity == Severity.WARNING } shouldBe 9
            }
        }

        context("心拍: 定期タスクが止まったことを、メトリクスの欠測で知る（B14）") {
            val day = 86_400L

            test("Given 日次の検査が昨日の期間に 1 回動いた When 評価する Then 発報しない") {
                val ran = listOf(sample(MetricNames.PROJECTION_MISMATCH_GAMES, 0.0, day + 3_600))

                stateOf("projection-verify-heartbeat", ran, 2 * day) shouldBe AlarmState.OK
            }

            test("Given 日次の検査が 1 日以上動いていない When 評価する Then 欠測を超過とみなして発報する") {
                val stale = listOf(sample(MetricNames.PROJECTION_MISMATCH_GAMES, 0.0, 3_600))

                stateOf("projection-verify-heartbeat", stale, 2 * day) shouldBe AlarmState.ALARM
            }

            test("Given 保持の掃引が 5 分ごとに動いている When 評価する Then 発報しない。1 時間止まると発報する") {
                val running = (0L until 7_200L step 300).map { sample(MetricNames.RETENTION_ABANDONED_GAMES, 0.0, it) }

                stateOf("retention-heartbeat", running, 7_200) shouldBe AlarmState.OK
                stateOf("retention-heartbeat", running, 7_200 + 3_600) shouldBe AlarmState.ALARM
            }

            test("Given 検査の結果が 0 件でない When 評価する Then 心拍は発報しない（異常の通知は別の規則）") {
                val drift = listOf(sample(MetricNames.PROJECTION_MISMATCH_GAMES, 3.0, day + 3_600))

                stateOf("projection-verify-heartbeat", drift, 2 * day) shouldBe AlarmState.OK
                stateOf("projection-mismatch", drift, 2 * day) shouldBe AlarmState.ALARM
            }
        }
    })
