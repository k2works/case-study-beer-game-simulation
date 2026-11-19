package beergame.application

import arrow.core.Either
import arrow.core.left
import arrow.core.right
import beergame.domain.GameId
import beergame.domain.StreamType
import java.time.Duration

/*
 * 投影の保守（B12。NF-R15、NF-P18）。投影は `events` からいつでも作り直せる（data-model.md「投影の再構築」）。
 * ポート [ProjectionMaintenance] は、1 ゲームの再構築と整合の検査を、永続化の側で行う（排他のロックの下で、1 トランザクション）。
 * サービス [ProjectionMaintainer] は、全ゲームを 1 ゲームずつ順に回し、1 ゲームの失敗が他のゲームに波及しないようにする。
 */

/** 1 ゲームの再構築の結果。[changedRows] は、再構築の前後で変わった投影の行数（0 なら、元と一致していた）。 */
data class RebuildOutcome(
    val gameId: GameId,
    val events: Int,
    val rows: Int,
    val changedRows: Int,
)

/** 投影と、イベントから作り直した内容の食い違い。 */
sealed interface Inconsistency {
    /** 進んだ版の記録（`projection_checkpoints`）が、イベントの最後の版と違う。記録が無いときは [projectedVersion] が null。 */
    data class CheckpointDrift(
        val streamType: StreamType,
        val projectedVersion: Long?,
        val headVersion: Long,
    ) : Inconsistency

    /** 投影の表の行が、作り直した行と違う。[missing] は作り直した行にあって投影に無い行、[unexpected] は投影にだけある行。 */
    data class RowDrift(
        val table: String,
        val missing: Int,
        val unexpected: Int,
    ) : Inconsistency
}

/** 投影の保守のポート。いずれも、ゲーム単位の排他のロックを待ちの上限まで待つ（取れなければ `RetryExhausted`）。 */
data class ProjectionMaintenance(
    val games: suspend () -> Either<AppFailure, List<GameId>>,
    /** 投影の行をすべて消し、イベントから作り直して確定する。 */
    val rebuild: suspend (GameId) -> Either<AppFailure, RebuildOutcome>,
    /** 作り直した結果と比べる。投影は変えない（比べたあとで取り消す）。 */
    val verify: suspend (GameId) -> Either<AppFailure, List<Inconsistency>>,
)

data class GameFailure(
    val gameId: GameId,
    val failure: AppFailure,
)

data class RebuildReport(
    val rebuilt: List<RebuildOutcome>,
    val failed: List<GameFailure>,
    val elapsed: Duration,
) {
    val changedGames: List<RebuildOutcome> get() = rebuilt.filter { it.changedRows > 0 }
}

data class GameInconsistency(
    val gameId: GameId,
    val findings: List<Inconsistency>,
)

data class VerifyReport(
    val checked: Int,
    val inconsistent: List<GameInconsistency>,
    /** ロックを取れず、検査できなかったゲーム（不一致には数えない）。 */
    val skipped: List<GameId>,
    val failed: List<GameFailure>,
    val elapsed: Duration,
)

class ProjectionMaintainer(
    private val port: ProjectionMaintenance,
    private val clock: Now,
) {
    /** [targets] が空なら、すべてのゲーム。一覧を読めないときだけ Left（1 ゲームの失敗は [RebuildReport.failed]）。 */
    suspend fun rebuild(targets: List<GameId>): Either<AppFailure, RebuildReport> {
        val started = clock()
        return when (val ids = targetsOf(targets)) {
            is Either.Left -> {
                ids.value.left()
            }

            is Either.Right -> {
                val results = ids.value.map { id -> id to port.rebuild(id) }
                RebuildReport(
                    rebuilt = results.mapNotNull { it.second.getOrNull() },
                    failed = results.mapNotNull { (id, r) -> r.leftOrNull()?.let { GameFailure(id, it) } },
                    elapsed = Duration.between(started, clock()),
                ).right()
            }
        }
    }

    suspend fun verify(targets: List<GameId> = emptyList()): Either<AppFailure, VerifyReport> {
        val started = clock()
        return when (val ids = targetsOf(targets)) {
            is Either.Left -> {
                ids.value.left()
            }

            is Either.Right -> {
                val results = ids.value.map { id -> id to port.verify(id) }
                VerifyReport(
                    checked = results.count { it.second.isRight() },
                    inconsistent =
                        results.mapNotNull { (id, r) ->
                            r.getOrNull()?.takeIf { it.isNotEmpty() }?.let { GameInconsistency(id, it) }
                        },
                    skipped = results.filter { it.second.leftOrNull() == AppFailure.RetryExhausted }.map { it.first },
                    failed =
                        results.mapNotNull { (id, r) ->
                            r.leftOrNull()?.takeIf { it != AppFailure.RetryExhausted }?.let { GameFailure(id, it) }
                        },
                    elapsed = Duration.between(started, clock()),
                ).right()
            }
        }
    }

    private suspend fun targetsOf(targets: List<GameId>): Either<AppFailure, List<GameId>> =
        if (targets.isEmpty()) port.games() else targets.right()
}
