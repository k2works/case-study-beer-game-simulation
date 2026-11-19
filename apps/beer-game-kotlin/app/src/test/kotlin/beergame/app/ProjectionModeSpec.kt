package beergame.app

import arrow.core.Either
import beergame.application.AppFailure
import beergame.application.GameFailure
import beergame.application.GameInconsistency
import beergame.application.Inconsistency
import beergame.application.RebuildOutcome
import beergame.application.RebuildReport
import beergame.application.VerifyReport
import beergame.domain.GameId
import beergame.domain.StreamType
import beergame.http.LogRecord
import beergame.http.LogSink
import io.kotest.core.spec.style.FunSpec
import io.kotest.matchers.collections.shouldContainExactly
import io.kotest.matchers.shouldBe
import io.kotest.matchers.string.shouldContain
import java.time.Duration
import java.util.UUID

private class Sink : LogSink {
    val records = mutableListOf<LogRecord>()

    override fun emit(record: LogRecord) {
        records += record
    }
}

private val GAME = GameId(UUID.fromString("00000000-0000-0000-0000-00000000abcd"))
private val OTHER = GameId(UUID.fromString("00000000-0000-0000-0000-00000000abce"))

/** 起動モード rebuild-projections・verify-projections の結果の記録と、終了コード（B12）。 */
class ProjectionModeSpec :
    FunSpec({
        test("[B12] Given 形が正しいゲーム ID と不正な文字列 When 読む Then 正しい列は Right、最初の不正な文字列は Left") {
            parseGameIds(listOf(GAME.value.toString())) shouldBe Either.Right(listOf(GAME))
            parseGameIds(emptyList()) shouldBe Either.Right(emptyList())
            parseGameIds(listOf(GAME.value.toString(), "x", "y")) shouldBe Either.Left("x")
        }

        test("[B12] Given 変わった行のあるゲームと失敗したゲーム When 再構築の結果を記録する Then 失敗は ERROR、変更は INFO、終了コード 1") {
            val sink = Sink()
            val report =
                RebuildReport(
                    rebuilt = listOf(RebuildOutcome(GAME, 10, 5, 2), RebuildOutcome(OTHER, 3, 3, 0)),
                    failed = listOf(GameFailure(OTHER, AppFailure.RetryExhausted)),
                    elapsed = Duration.ofMillis(120),
                )

            reportRebuild(Either.Right(report), sink) shouldBe 1

            sink.records.map { it.result } shouldContainExactly listOf("game.failed", "game.changed", "ok")
            sink.records.first().level shouldBe "ERROR"
            sink.records.last().message shouldContain "変わったゲーム 1"
        }

        test("[B12] Given すべて成功した再構築 When 記録する Then 終了コード 0。一覧を読めなければ 70") {
            val ok = RebuildReport(listOf(RebuildOutcome(GAME, 1, 1, 0)), emptyList(), Duration.ZERO)

            reportRebuild(Either.Right(ok), Sink()) shouldBe 0
            reportRebuild(Either.Left(AppFailure.RetryExhausted), Sink()) shouldBe 70
        }

        test("[B12/NF-R15] Given 不一致と検査できなかったゲーム When 検査の結果を記録する Then 不一致は ERROR、検査できずは WARN、終了コード 1") {
            val sink = Sink()
            val report =
                VerifyReport(
                    checked = 3,
                    inconsistent =
                        listOf(
                            GameInconsistency(GAME, listOf(Inconsistency.CheckpointDrift(StreamType.SESSION, 3, 4))),
                        ),
                    skipped = listOf(OTHER),
                    failed = emptyList(),
                    elapsed = Duration.ofMillis(5),
                )

            reportVerify(Either.Right(report), sink) shouldBe 1

            sink.records.map { it.result to it.level } shouldContainExactly
                listOf("inconsistent" to "ERROR", "skipped" to "WARN", "ok" to "INFO")
        }

        test("[B12/NF-R15] Given 不一致 0 件で、検査できなかったゲームだけがある When 記録する Then 終了コード 0（検査できなかった旨は警告に残る）") {
            val sink = Sink()
            val report = VerifyReport(2, emptyList(), listOf(OTHER), emptyList(), Duration.ZERO)

            reportVerify(Either.Right(report), sink) shouldBe 0

            sink.records.map { it.result } shouldContainExactly listOf("skipped", "ok")
        }

        test("[B12] Given 検査に失敗したゲーム When 記録する Then 終了コード 1。一覧を読めなければ 70") {
            val failed =
                VerifyReport(
                    1,
                    emptyList(),
                    emptyList(),
                    listOf(GameFailure(GAME, AppFailure.ConcurrencyConflict)),
                    Duration.ZERO,
                )

            reportVerify(Either.Right(failed), Sink()) shouldBe 1
            reportVerify(Either.Left(AppFailure.RetryExhausted), Sink()) shouldBe 70
        }
    })
