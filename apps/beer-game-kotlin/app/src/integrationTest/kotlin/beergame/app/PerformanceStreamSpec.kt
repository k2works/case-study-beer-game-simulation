package beergame.app

import arrow.core.getOrElse
import beergame.application.ProjectionMaintainer
import beergame.domain.GameId
import beergame.domain.SessionEvent
import beergame.domain.StreamType
import beergame.domain.replaySession
import beergame.http.beerGameModule
import io.kotest.core.spec.style.FunSpec
import io.kotest.matchers.collections.shouldBeEmpty
import io.kotest.matchers.comparables.shouldBeLessThanOrEqualTo
import io.kotest.matchers.shouldBe
import io.ktor.server.testing.runTestApplication
import org.testcontainers.postgresql.PostgreSQLContainer
import java.time.Instant
import java.util.UUID
import kotlin.time.Duration.Companion.minutes

/*
 * B15: ストリームの長さに対する計測（NF-P3 の最大の長さ、NF-P15 の再生、NF-P18 の再構築、NF-P19 の追記、NF-C8）。道具は PerformanceKit.kt。
 * 1000 件のストリームは、50 週 × 4 役割 × 5 回の保存 + 確定。最大の長さ（約 2000 件）は、9 回（保存の上限）の保存。
 * 上限は NFR の値と同じにすると環境差で落ちうるものがあるため、NF-P15・P18・P19 は、極端な遅さ（10 秒）だけを失敗にし、実測を記録する。
 */
private const val SAVES_TYPICAL = 5
private const val SAVES_MAX = 9
private const val SLOW_LIMIT_MILLIS = 10_000L
private const val LATE_COMMIT_LIMIT_MILLIS = 2_000L
private const val LATE_WEEKS = 10
private const val WARM_UP_RUNS = 5
private const val NANOS_PER_MILLI = 1_000_000L
private const val MANY_CONCURRENCY = 8
private const val MAX_STREAM_GAMES = 4

class PerformanceStreamSpec :
    FunSpec({
        val scale = Scale.current()
        val container = PostgreSQLContainer("postgres:18-alpine").withDatabaseName("beergame_perf_stream")
        lateinit var env: PostgresEnv
        timeout = 90.minutes.inWholeMilliseconds

        beforeSpec {
            container.start()
            env = PostgresEnv(container)
        }
        afterSpec {
            env.recordServerErrors(scale)
            PerformanceReport.write()
            env.close()
            container.stop()
        }

        suspend fun replayTimes(
            game: String,
            runs: Int,
        ): Triple<Int, Latencies, Latencies> {
            val id = GameId(UUID.fromString(game))
            val events = env.persistence.events
            val reads = Latencies()
            val folds = Latencies()
            var length = 0
            repeat(WARM_UP_RUNS + runs) { n ->
                val (stream, readMillis) =
                    measured {
                        events
                            .transaction { tx ->
                                events.read(tx, id, StreamType.SESSION)
                            }.getOrElse { error("読めない: $it") }
                    }
                val sessionEvents = stream.events.map { it.payload }.filterIsInstance<SessionEvent>()
                val start = System.nanoTime()
                replaySession(sessionEvents)
                val foldMillis = (System.nanoTime() - start) / NANOS_PER_MILLI
                length = sessionEvents.size
                if (n >= WARM_UP_RUNS) {
                    reads.add(readMillis)
                    folds.add(foldMillis)
                }
            }
            return Triple(length, reads, folds)
        }

        test("[B15/NF-P15・P18・C8] 1000 件のストリーム: 再生（読み込み + 畳み込み）と投影の再構築") {
            runTestApplication {
                application { beerGameModule(env.deps) }
                val table = client.newTable("typical", scale.longWeeks)
                val saves = Latencies()
                val commits = Latencies()
                client.playWeeks(table, 1..scale.longWeeks, SAVES_TYPICAL, saves, commits)

                val (length, reads, folds) = replayTimes(table.gameId, scale.replayRuns)
                PerformanceReport.record("NF-P15 再生: 読み込み（$length 件）", scale, reads.summary())
                PerformanceReport.record("NF-P15 再生: 畳み込みのみ（$length 件）", scale, folds.summary())

                val id = GameId(UUID.fromString(table.gameId))
                val rebuilds = Latencies()
                repeat(WARM_UP_RUNS + scale.rebuildRuns) { n ->
                    val (outcome, millis) = measured { env.persistence.maintenance.rebuild(id) }
                    outcome.getOrElse { error("再構築できない: $it") }
                    if (n >= WARM_UP_RUNS) rebuilds.add(millis)
                }
                env.persistence.maintenance
                    .verify(id)
                    .getOrElse { error("検査できない: $it") }
                    .shouldBeEmpty()
                PerformanceReport.record("NF-P18 再構築（1 ゲーム、$length 件）", scale, rebuilds.summary())

                reads.percentile(0.95) shouldBeLessThanOrEqualTo SLOW_LIMIT_MILLIS
                rebuilds.percentile(0.95) shouldBeLessThanOrEqualTo SLOW_LIMIT_MILLIS
                saves.failed shouldBe 0
            }
        }

        test("[B15/NF-P3・P15・P19] 最大の長さのストリーム（9 回の保存）での確定・保存と、再生") {
            runTestApplication {
                application { beerGameModule(env.deps) }
                val tables =
                    concurrently((1..MAX_STREAM_GAMES).toList()) { client.newTable("max-$it", scale.longWeeks) }
                val lateSaves = Latencies()
                val lateCommits = Latencies()
                val early = scale.longWeeks - LATE_WEEKS
                concurrently(tables) { table ->
                    client.playWeeks(table, 1..early, SAVES_MAX, Latencies(), Latencies())
                    client.playWeeks(table, (early + 1)..scale.longWeeks, SAVES_MAX, lateSaves, lateCommits)
                }
                val (length, reads, folds) = replayTimes(tables.first().gameId, scale.replayRuns)
                PerformanceReport.record("NF-P3 確定（最後の $LATE_WEEKS 週。$length 件に至る）", scale, lateCommits.summary())
                PerformanceReport.record("NF-P19 の上限 保存（最後の $LATE_WEEKS 週。HTTP 全体）", scale, lateSaves.summary())
                PerformanceReport.record("NF-P15 再生: 読み込み（$length 件）", scale, reads.summary())
                PerformanceReport.record("NF-P15 再生: 畳み込みのみ（$length 件）", scale, folds.summary())
                lateCommits.failed shouldBe 0
                lateSaves.failed shouldBe 0
                lateCommits.percentile(0.95) shouldBeLessThanOrEqualTo LATE_COMMIT_LIMIT_MILLIS
            }
        }

        test("[B15/NF-P18] 多数のゲームの再構築（保持中の全ゲーム）") {
            runTestApplication {
                application { beerGameModule(env.deps) }
                val tables =
                    concurrently((1..scale.manyGames).toList()) { client.newTable("many-$it", scale.manyGameWeeks) }
                tables.chunked(MANY_CONCURRENCY).forEach { chunk ->
                    concurrently(chunk) { client.playWeeks(it, 1..scale.manyGameWeeks, 1, Latencies(), Latencies()) }
                }
                val maintainer = ProjectionMaintainer(env.persistence.maintenance) { Instant.now() }
                val report = maintainer.rebuild(emptyList()).getOrElse { error("再構築できない: $it") }
                val events = report.rebuilt.sumOf { it.events }
                PerformanceReport.record(
                    "NF-P18 再構築（全 ${report.rebuilt.size} ゲーム、合計 $events 件）",
                    scale,
                    "所要 ${report.elapsed.toMillis()} ms、失敗 ${report.failed.size}",
                )
                report.failed.shouldBeEmpty()
                (report.elapsed.toMillis() <= 5.minutes.inWholeMilliseconds) shouldBe true
            }
        }
    })
