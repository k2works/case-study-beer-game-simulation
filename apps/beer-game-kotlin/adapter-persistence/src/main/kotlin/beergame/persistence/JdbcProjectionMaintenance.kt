package beergame.persistence

import arrow.core.Either
import arrow.core.flatMap
import arrow.core.left
import arrow.core.raise.either
import arrow.core.raise.ensure
import arrow.core.right
import beergame.application.AppFailure
import beergame.application.Inconsistency
import beergame.application.PersistenceFailure
import beergame.application.ProjectionLock
import beergame.application.ProjectionMaintenance
import beergame.application.ProjectionWriter
import beergame.application.RebuildOutcome
import beergame.application.TransactionRunner
import beergame.application.Tx
import beergame.domain.DomainEvent
import beergame.domain.EventEnvelope
import beergame.domain.GameId
import beergame.domain.GuidedTour
import beergame.domain.ProjectionTable
import beergame.domain.StreamType
import beergame.domain.StreamVersion
import java.sql.Connection
import java.sql.ResultSet
import javax.sql.DataSource

/*
 * 投影の再構築と整合の検査（B12。data-model.md「投影の再構築」、NF-R15）。
 * 再構築は、ゲームごとに 1 トランザクション: 排他のロックを先頭で取り、投影の行と進んだ版の記録を消し、`events` を追記順に読み直して、
 * 同期投影と同じ書き込み（[ProjectionWriter]）で作り直す。コマンドが見るのは、再構築の前後のどちらかだけ（途中の投影は見えない）。
 * 検査は、同じ手順を行って比べたあと、**取り消す**（投影を変えない）。
 */
@GuidedTour(
    name = "イベントソーシング（事実が状態の正本）",
    rank = 9,
    stage = "状態を取り戻す",
    description =
        "事実を追記順に読み直して、投影を作り直す。投影が壊れても、事実から復元できる。" +
            "ゲームごとに 1 トランザクションで行い、検査は同じ手順を行って比べたあと取り消す",
)
internal class JdbcProjectionMaintenance(
    private val runner: TransactionRunner,
    private val lock: ProjectionLock,
    private val writer: ProjectionWriter,
    private val events: JdbcEventReplay,
) {
    fun port(): ProjectionMaintenance = ProjectionMaintenance(::games, ::rebuild, ::verify)

    private suspend fun games(): Either<AppFailure, List<GameId>> =
        runner { tx ->
            tx.jdbc(OP_GAMES).flatMap { jdbcTx ->
                jdbcCall(OP_GAMES) {
                    jdbcTx.connection.createStatement().use { st ->
                        st.executeQuery("SELECT game_id FROM game_roots ORDER BY created_at, game_id").use { rs ->
                            buildList { while (rs.next()) add(GameId(checkNotNull(rs.getUuid("game_id")))) }.right()
                        }
                    }
                }
            }
        }

    private suspend fun rebuild(gameId: GameId): Either<AppFailure, RebuildOutcome> =
        runner { tx ->
            either {
                lock.acquireExclusive(tx, gameId).bind()
                rebuildIn(tx, gameId).bind().outcome(gameId)
            }
        }

    /** 検査: 作り直して比べ、必ず取り消す。取り消しは、トランザクションに Left を返して行う（結果は外へ持ち出す）。 */
    private suspend fun verify(gameId: GameId): Either<AppFailure, List<Inconsistency>> {
        var findings: List<Inconsistency>? = null
        val result =
            runner { tx ->
                either<AppFailure, Unit> {
                    lock.acquireExclusive(tx, gameId).bind()
                    val drift = checkpointDrift(tx, gameId).bind()
                    val rebuilt = rebuildIn(tx, gameId).bind()
                    findings = drift + rebuilt.before.differences(rebuilt.after)
                    raise(ROLLBACK)
                }
            }
        return findings?.right() ?: result.fold({ it.left() }, { emptyList<Inconsistency>().right() })
    }

    /** 再構築の前後の内容。 */
    private class Rebuilt(
        val eventCount: Int,
        val before: ProjectionDump,
        val after: ProjectionDump,
    ) {
        fun outcome(gameId: GameId) =
            RebuildOutcome(
                gameId,
                eventCount,
                after.totalRows,
                before.differences(after).sumOf {
                    it.missing +
                        it.unexpected
                },
            )
    }

    private suspend fun rebuildIn(
        tx: Tx,
        gameId: GameId,
    ): Either<AppFailure, Rebuilt> =
        either {
            val jdbc = tx.jdbc(OP_REBUILD).bind()
            val history = events.readAllInAppendOrder(tx, gameId).bind()
            ensure(
                history.isNotEmpty(),
            ) { AppFailure.Persistence(PersistenceFailure(OP_REBUILD, "イベントが無いゲーム: ${gameId.value}")) }
            val before = jdbcCall(OP_REBUILD) { ProjectionDump.read(jdbc.connection, gameId).right() }.bind()
            jdbcCall(OP_REBUILD) { deleteProjection(jdbc.connection, gameId).right() }.bind()
            writer.write(tx, gameId, history).bind()
            val after = jdbcCall(OP_REBUILD) { ProjectionDump.read(jdbc.connection, gameId).right() }.bind()
            Rebuilt(history.size, before, after)
        }

    /** 子の表（`week_role_results`・`week_team_totals` は `week_commits` を参照）を先に消す。宣言の逆順。 */
    private fun deleteProjection(
        connection: Connection,
        gameId: GameId,
    ) {
        (ProjectionTable.entries.reversed().map { it.sqlName } + CHECKPOINTS).forEach { table ->
            connection.prepareStatement("DELETE FROM $table WHERE game_id = ?").use { ps ->
                ps.setObject(1, gameId.value)
                ps.executeUpdate()
            }
        }
    }

    /** ストリームごとに、進んだ版の記録がイベントの最後の版と一致するか。 */
    private fun checkpointDrift(
        tx: Tx,
        gameId: GameId,
    ): Either<AppFailure, List<Inconsistency>> =
        tx.jdbc(OP_VERIFY).flatMap { jdbc ->
            jdbcCall(OP_VERIFY) {
                val heads = versions(jdbc.connection, HEADS_SQL, gameId)
                val projected = versions(jdbc.connection, PROJECTED_SQL, gameId)
                heads
                    .filter { (stream, head) -> projected[stream] != head }
                    .map { (stream, head) -> Inconsistency.CheckpointDrift(stream, projected[stream], head) }
                    .right()
            }
        }

    private fun versions(
        connection: Connection,
        sql: String,
        gameId: GameId,
    ): Map<StreamType, Long> =
        connection.prepareStatement(sql).use { ps ->
            ps.setObject(1, gameId.value)
            ps.executeQuery().use { rs -> readVersions(rs) }
        }

    private fun readVersions(rs: ResultSet): Map<StreamType, Long> =
        buildMap { while (rs.next()) put(StreamType.valueOf(rs.getString(1)), rs.getLong(2)) }

    private companion object {
        const val OP_GAMES = "projection.games"
        const val OP_REBUILD = "projection.rebuild"
        const val OP_VERIFY = "projection.verify"
        const val CHECKPOINTS = "projection_checkpoints"
        const val HEADS_SQL =
            "SELECT stream_type, MAX(stream_version) FROM events WHERE game_id = ? GROUP BY stream_type"
        const val PROJECTED_SQL = "SELECT stream_type, projected_version FROM projection_checkpoints WHERE game_id = ?"
        val ROLLBACK: AppFailure = AppFailure.Persistence(PersistenceFailure(OP_VERIFY, "取り消し（検査は投影を変えない）"))
    }
}

/**
 * 投影の保守のポート（`rebuild-projections`・`verify-projections` モードが使う）。通知の受信（LISTEN）は要らないので、
 * [Persistence] を開かずに、接続プールだけで組み立てる。再構築のロックは、方言ごとの実装（PostgreSQL はアドバイザリロック。
 * H2 はプロセス内のロックで、API とは直列にならない。ローカルでは API を止めてから行う）。
 */
fun projectionMaintenance(
    dialect: Dialect,
    dataSource: DataSource,
    lockTimeoutMillis: Long = PersistenceConfig.DEFAULT_LOCK_TIMEOUT_MILLIS,
): ProjectionMaintenance =
    projectionMaintenance(
        dialect,
        dataSource,
        when (dialect) {
            Dialect.POSTGRES -> PostgresProjectionLock(lockTimeoutMillis).port()
            Dialect.H2 -> LocalProjectionLock(lockTimeoutMillis).port()
        },
    )

internal fun projectionMaintenance(
    dialect: Dialect,
    dataSource: DataSource,
    lock: ProjectionLock,
): ProjectionMaintenance =
    JdbcProjectionMaintenance(
        JdbcTransactionRunner(dataSource),
        lock,
        JdbcProjectionWriter(dialect),
        JdbcEventReplay(),
    ).port()

/** 1 ゲームの全イベントを追記順に読む（再構築の入力）。2 本のストリームを、元の更新の順に混ぜる。 */
internal class JdbcEventReplay {
    fun readAllInAppendOrder(
        tx: Tx,
        gameId: GameId,
    ): Either<AppFailure, List<EventEnvelope<DomainEvent>>> =
        tx.jdbc(OP).flatMap { jdbcTx ->
            jdbcCall(OP) {
                jdbcTx.connection.prepareStatement(SELECT_SQL).use { ps ->
                    ps.params().uuid(gameId.value)
                    ps.executeQuery().use { rs -> readInOrder(rs, gameId) }
                }
            }
        }

    /** 版の連続は、ストリームごとに確かめる（欠番があれば、再構築は失敗する）。 */
    private fun readInOrder(
        rs: ResultSet,
        gameId: GameId,
    ): Either<AppFailure, List<EventEnvelope<DomainEvent>>> =
        either {
            val last = mutableMapOf<StreamType, StreamVersion>()
            val result = mutableListOf<EventEnvelope<DomainEvent>>()
            while (rs.next()) {
                val stream = StreamType.valueOf(rs.getString("stream_type"))
                val next = (last[stream] ?: StreamVersion.ZERO).next()
                val actual = rs.getLong("stream_version")
                ensure(actual == next.value) { readFailure("ストリームの版に欠番がある: $stream 期待 ${next.value}、実際 $actual") }
                last[stream] = next
                result += rs.toEnvelope(gameId, stream, next).bind()
            }
            result.toList()
        }

    private companion object {
        const val OP = "events.replay"
        const val SELECT_SQL =
            "SELECT event_id, stream_type, stream_version, event_type, schema_version, " +
                "CAST(payload AS VARCHAR) AS payload_json, actor_kind, actor_id, correlation_id, command_id, " +
                "occurred_at " +
                "FROM events WHERE game_id = ? ORDER BY seq"
    }
}
