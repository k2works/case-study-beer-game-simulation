package beergame.application

import beergame.domain.GameId
import beergame.domain.Role
import io.kotest.core.spec.style.FunSpec
import io.kotest.matchers.collections.shouldBeEmpty
import io.kotest.matchers.shouldBe
import java.time.Duration
import java.util.UUID

/*
 * メトリクス（B13。NF-O3、NF-O12）。要求・コマンドの試行・保守・保持・JVM の各収集点が、設計どおりの値を作る。
 * 値の型には、ゲーム ID・表示名・資格を持つ場所が無い（[MetricSample] の項目は名前・単位・値・時刻・操作だけ）。
 */

private fun List<MetricSample>.valueOf(name: String): Double? = firstOrNull { it.name == name }?.value

private val GAME = GameId(UUID(1L, 1L))

class MetricsSpec :
    FunSpec({
        context("要求のメトリクス") {
            test("[AC6.1.3] Given 200 の応答 When 作る Then 応答時間・要求数・5xx=0 が、操作ごとの系列で得られる") {
                val samples = requestMetrics(RequestOutcome("getGameState", 200, 12), T0)

                samples.valueOf(MetricNames.REQUEST_DURATION_MILLIS) shouldBe 12.0
                samples.valueOf(MetricNames.REQUEST_COUNT) shouldBe 1.0
                samples.valueOf(MetricNames.SERVER_ERROR) shouldBe 0.0
                samples.all { it.operation == "getGameState" } shouldBe true
            }

            test("[AC6.1.3] Given 503 の応答 When 作る Then 5xx=1 で、主要な操作の成功にはならない") {
                val samples = requestMetrics(RequestOutcome("commitWeek", 503, 40), T0)

                samples.valueOf(MetricNames.SERVER_ERROR) shouldBe 1.0
                samples.valueOf(MetricNames.MAIN_OPERATION_SUCCESS) shouldBe null
            }

            test("[AC6.1.5] Given 主要な操作の成功 When 作る Then 主要な操作の成功が 1。主要でない操作と 4xx は数えない") {
                requestMetrics(RequestOutcome("commitWeek", 200, 5), T0)
                    .valueOf(MetricNames.MAIN_OPERATION_SUCCESS) shouldBe 1.0
                requestMetrics(RequestOutcome("getGameState", 200, 5), T0)
                    .valueOf(MetricNames.MAIN_OPERATION_SUCCESS) shouldBe null
                requestMetrics(RequestOutcome("saveDecision", 409, 5), T0)
                    .valueOf(MetricNames.MAIN_OPERATION_SUCCESS) shouldBe null
            }
        }

        context("コマンドの追記の競合") {
            test("[AC6.1.3] Given 追記が 2 回競合して 3 回目で成功 When 実行する Then 競合は 1,1,0 の 3 件で、上限超過は無い") {
                val world = World(testSettings(maxAttempts = 3))
                val game = world.started()
                world.recordedMetrics.clear()
                world.conflictsToInject = 2

                world.ports
                    .saveDecision(
                        game.gameId,
                        SaveDecisionInput(Role.DISTRIBUTOR, 1, 8, 0),
                        meta("metrics-retry", game.seats[Role.DISTRIBUTOR].credential),
                    ).ok()

                world.recordedMetrics.filter { it.name == MetricNames.CONCURRENCY_CONFLICT }.map { it.value } shouldBe
                    listOf(1.0, 1.0, 0.0)
                world.recordedMetrics.filter { it.name == MetricNames.RETRY_EXHAUSTED }.shouldBeEmpty()
            }

            test("[AC6.1.3] Given 競合が続く When 上限（2 回）に達する Then 競合 1,1 と、再試行の上限超過 1 件") {
                val world = World(testSettings(maxAttempts = 2))
                val game = world.started()
                world.recordedMetrics.clear()
                world.conflictsToInject = 10

                world.ports
                    .saveDecision(
                        game.gameId,
                        SaveDecisionInput(Role.DISTRIBUTOR, 1, 8, 0),
                        meta("metrics-exhaust", game.seats[Role.DISTRIBUTOR].credential),
                    ).err() shouldBe AppFailure.RetryExhausted

                world.recordedMetrics.filter { it.name == MetricNames.CONCURRENCY_CONFLICT }.map { it.value } shouldBe
                    listOf(1.0, 1.0)
                world.recordedMetrics.filter { it.name == MetricNames.RETRY_EXHAUSTED }.map { it.value } shouldBe
                    listOf(1.0)
            }
        }

        context("保守と保持のメトリクス") {
            val ok = VerifyReport(5, emptyList(), emptyList(), emptyList(), Duration.ofSeconds(1))

            test("[AC6.1.6] Given 整合した検査 When 作る Then 不一致・遅れ・検査できず がすべて 0") {
                val samples = verifyMetrics(ok, T0)

                samples.valueOf(MetricNames.PROJECTION_MISMATCH_GAMES) shouldBe 0.0
                samples.valueOf(MetricNames.PROJECTION_LAG_GAMES) shouldBe 0.0
                samples.valueOf(MetricNames.PROJECTION_UNCHECKED_GAMES) shouldBe 0.0
            }

            test("[AC6.1.6] Given 行の不一致 1 件と版の遅れ 1 件と、検査できなかったゲーム When 作る Then それぞれ数える") {
                val rowDrift = Inconsistency.RowDrift("game_overview", 1, 0)
                val drift = Inconsistency.CheckpointDrift(beergame.domain.StreamType.SESSION, 3L, 4L)
                val report =
                    ok.copy(
                        inconsistent =
                            listOf(
                                GameInconsistency(GAME, listOf(rowDrift)),
                                GameInconsistency(GameId(UUID(1L, 2L)), listOf(drift)),
                            ),
                        skipped = listOf(GameId(UUID(1L, 3L))),
                    )

                val samples = verifyMetrics(report, T0)

                samples.valueOf(MetricNames.PROJECTION_MISMATCH_GAMES) shouldBe 1.0
                samples.valueOf(MetricNames.PROJECTION_LAG_GAMES) shouldBe 1.0
                samples.valueOf(MetricNames.PROJECTION_UNCHECKED_GAMES) shouldBe 1.0
            }

            test("[AC6.1.6] Given 削除が 1 件完了し、放棄は無い When 作る Then 放棄 0、削除 1 を数える") {
                val report = SweepReport(listOf(GAME), emptyList(), 0)

                val samples = sweepMetrics(report, T0)

                samples.valueOf(MetricNames.RETENTION_ABANDONED_GAMES) shouldBe 0.0
                samples.valueOf(MetricNames.RETENTION_DELETED_GAMES) shouldBe 1.0
            }
        }

        context("JVM と接続プールのメトリクス（NF-O12）") {
            val before = JvmReading(400, 1000, gcCount = 10, gcTimeMillis = 100, poolActive = 2, poolMax = 10)

            test("[NF-O12] Given 前回から GC が 4 回・200 ミリ秒 When 作る Then ヒープ 90%、GC の停止は 1 回 50 ミリ秒、プール 70%") {
                val now = JvmReading(900, 1000, gcCount = 14, gcTimeMillis = 300, poolActive = 7, poolMax = 10)

                val samples = jvmMetrics(before, now, T0)

                samples.valueOf(MetricNames.JVM_HEAP_USED_PERCENT) shouldBe 90.0
                samples.valueOf(MetricNames.JVM_GC_PAUSE_MILLIS) shouldBe 50.0
                samples.valueOf(MetricNames.DB_POOL_UTILIZATION_PERCENT) shouldBe 70.0
            }

            test("[NF-O12] Given 最初の読み取り（前回なし）で GC もプールも無い When 作る Then GC の停止は 0、プールは出さない") {
                val first = JvmReading(100, 1000, gcCount = 3, gcTimeMillis = 30)

                val samples = jvmMetrics(null, first, T0)

                samples.valueOf(MetricNames.JVM_GC_PAUSE_MILLIS) shouldBe 0.0
                samples.valueOf(MetricNames.DB_POOL_UTILIZATION_PERCENT) shouldBe null
            }

            test("[NF-O12] Given ヒープの上限が不明（0） When 作る Then 使用率は 0 で、割り算しない") {
                jvmMetrics(null, JvmReading(10, 0, 0, 0), T0).valueOf(MetricNames.JVM_HEAP_USED_PERCENT) shouldBe 0.0
            }
        }
    })
