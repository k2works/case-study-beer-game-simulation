package beergame.app

import arrow.core.Either
import beergame.application.AppFailure
import beergame.application.Now
import beergame.application.ProjectionMaintainer
import beergame.application.RebuildReport
import beergame.application.VerifyReport
import beergame.domain.GameId
import beergame.http.LEVEL_ERROR
import beergame.http.LEVEL_INFO
import beergame.http.LEVEL_WARN
import beergame.http.LogSink
import beergame.persistence.projectionMaintenance
import kotlinx.coroutines.runBlocking
import java.time.Instant
import java.util.UUID

/*
 * 起動モード `rebuild-projections` と `verify-projections`（B12。NF-R15）。
 * - `rebuild-projections [ゲーム ID ...]`: 投影を `events` から作り直す。ゲーム ID を省くと、すべてのゲーム。
 *   ゲームごとに排他のアドバイザリロックを取る（研修中は、運営者を通じて進行役に停止を依頼してから行う。運用の手順 B）。
 * - `verify-projections`: 投影が、イベントから作り直した結果と一致するかを検査する（日次の定期タスク）。投影は変えない。
 *   ロックを取れず検査できなかったゲームは、不一致に数えず、警告に残す。
 * 終了コード: 0 正常、1 再構築できなかったゲームがある・不一致が見つかった、64 ゲーム ID の誤り、70 一覧を読めない・接続できない。
 */

internal const val EXIT_PROJECTION_PROBLEM = 1
private const val EXIT_USAGE_ERROR = 64
private const val REBUILD = "rebuild-projections"
private const val VERIFY = "verify-projections"

private fun LogSink.log(
    level: String,
    operation: String,
    result: String,
    message: String,
) = emit(operationalRecord(level, operation, result, message))

/** 引数のゲーム ID を読む。形が不正なものがあれば、その文字列を Left で返す。 */
internal fun parseGameIds(args: List<String>): Either<String, List<GameId>> {
    val parsed = args.map { raw -> raw to Either.catch { GameId(UUID.fromString(raw)) }.getOrNull() }
    return parsed.firstOrNull { it.second == null }?.let { Either.Left(it.first) }
        ?: Either.Right(parsed.mapNotNull { it.second })
}

private fun maintainer(
    config: ServerConfig,
    now: Now,
    block: suspend (ProjectionMaintainer) -> Int,
): Int =
    openDataSource(config.database).use { dataSource ->
        val port = projectionMaintenance(dialectOf(config.database), dataSource)
        runBlocking { block(ProjectionMaintainer(port, now)) }
    }

internal fun runRebuild(
    config: ServerConfig,
    args: List<String>,
    logs: LogSink,
    now: Now = { Instant.now() },
): Int =
    when (val targets = parseGameIds(args)) {
        is Either.Left -> {
            logs.log(LEVEL_ERROR, REBUILD, "usage", "ゲーム ID の形が不正です: ${targets.value}")
            EXIT_USAGE_ERROR
        }

        is Either.Right -> {
            maintainer(config, now) { reportRebuild(it.rebuild(targets.value), logs) }
        }
    }

internal fun runVerify(
    config: ServerConfig,
    logs: LogSink,
    now: Now = { Instant.now() },
): Int = maintainer(config, now) { reportVerify(it.verify(), logs) }

internal fun reportRebuild(
    result: Either<AppFailure, RebuildReport>,
    logs: LogSink,
): Int =
    when (result) {
        is Either.Left -> {
            logs.log(LEVEL_ERROR, REBUILD, "failed", "ゲームの一覧を読めません: ${result.value}")
            EXIT_SOFTWARE
        }

        is Either.Right -> {
            val report = result.value
            report.failed.forEach {
                logs.log(
                    LEVEL_ERROR,
                    REBUILD,
                    "game.failed",
                    "ゲーム ${it.gameId.value} を再構築できません（投影は元のまま）: ${it.failure}",
                )
            }
            report.changedGames.forEach {
                logs.log(
                    LEVEL_INFO,
                    REBUILD,
                    "game.changed",
                    "ゲーム ${it.gameId.value} の投影の ${it.changedRows} 行が、再構築で変わりました",
                )
            }
            val summary =
                "再構築 ${report.rebuilt.size} ゲーム（変わったゲーム ${report.changedGames.size}）、" +
                    "失敗 ${report.failed.size}、所要 ${report.elapsed.toMillis()} ミリ秒"
            logs.log(LEVEL_INFO, REBUILD, "ok", summary)
            if (report.failed.isEmpty()) 0 else EXIT_PROJECTION_PROBLEM
        }
    }

internal fun reportVerify(
    result: Either<AppFailure, VerifyReport>,
    logs: LogSink,
): Int =
    when (result) {
        is Either.Left -> {
            logs.log(LEVEL_ERROR, VERIFY, "failed", "ゲームの一覧を読めません: ${result.value}")
            EXIT_SOFTWARE
        }

        is Either.Right -> {
            val report = result.value
            report.inconsistent.forEach {
                logs.log(LEVEL_ERROR, VERIFY, "inconsistent", "ゲーム ${it.gameId.value} の投影が、イベントと一致しません: ${it.findings}")
            }
            report.failed.forEach {
                logs.log(LEVEL_ERROR, VERIFY, "game.failed", "ゲーム ${it.gameId.value} を検査できません: ${it.failure}")
            }
            if (report.skipped.isNotEmpty()) {
                val note = "ロックを取れず検査できなかったゲーム ${report.skipped.size} 件（再構築中か、コマンドの実行中）"
                logs.log(LEVEL_WARN, VERIFY, "skipped", note)
            }
            val summary =
                "検査 ${report.checked} ゲーム、不一致 ${report.inconsistent.size}、検査できず ${report.skipped.size}、" +
                    "失敗 ${report.failed.size}、所要 ${report.elapsed.toMillis()} ミリ秒"
            logs.log(LEVEL_INFO, VERIFY, "ok", summary)
            if (report.inconsistent.isEmpty() && report.failed.isEmpty()) 0 else EXIT_PROJECTION_PROBLEM
        }
    }
