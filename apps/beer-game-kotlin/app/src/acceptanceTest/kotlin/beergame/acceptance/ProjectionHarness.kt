package beergame.acceptance

import beergame.application.MetricSink
import beergame.application.ProjectionMaintainer
import beergame.application.ProjectionMaintenance
import beergame.application.RebuildReport
import beergame.application.VerifyReport
import beergame.application.verifyMetrics
import beergame.domain.GameId
import kotlinx.coroutines.runBlocking
import java.time.Instant
import java.util.UUID
import javax.sql.DataSource

/** 投影の表（宣言の順）。子の表を後ろに置く。進んだ版の記録（`projection_checkpoints`）は、最後。 */
private val PROJECTION_TABLES =
    listOf(
        "game_overview",
        "game_join_codes",
        "game_settings",
        "lobby_participants",
        "lobby_observer_invitations",
        "lobby_observers",
        "session_overview",
        "role_current_states",
        "current_decisions",
        "week_commits",
        "week_role_results",
        "week_team_totals",
        "retention_policies",
        "projection_checkpoints",
    )

/**
 * 投影の再構築と整合の検査（B12）の試験用の窓口。本番の `rebuild-projections`・`verify-projections` モードと同じサービス
 * （[ProjectionMaintainer]）を、同じ永続化の実装に対して呼ぶ。投影の破壊（行を空にする・書き換える）は、試験が保存先を直接書く
 * （本番のコードではない）。
 */
class ProjectionHarness(
    private val dataSource: DataSource,
    port: ProjectionMaintenance,
    private val metrics: MetricSink = MetricSink.None,
) {
    private val maintainer = ProjectionMaintainer(port) { Instant.now() }

    var lastRebuild: RebuildReport? = null
        private set
    var lastVerify: VerifyReport? = null
        private set

    fun rebuild(gameId: String) {
        lastRebuild = runBlocking { maintainer.rebuild(listOf(id(gameId))) }.fold({ error("再構築を呼べない: $it") }, { it })
    }

    fun verify(gameId: String) {
        val report = runBlocking { maintainer.verify(listOf(id(gameId))) }.fold({ error("検査を呼べない: $it") }, { it })
        lastVerify = report
        // 本番の `verify-projections` モード（reportVerify）と同じ関数で、検査の結果をメトリクスにする。
        metrics.record(verifyMetrics(report, Instant.now()))
    }

    /** 1 ゲームの投影の全行を、表ごとの文字列の列にする（比較用。DB の返す文字列のまま、並べ替える）。 */
    fun snapshot(gameId: String): Map<String, List<String>> =
        dataSource.connection.use { connection ->
            PROJECTION_TABLES.associateWith { table ->
                connection.prepareStatement("SELECT * FROM $table WHERE game_id = ?").use { ps ->
                    ps.setObject(1, UUID.fromString(gameId))
                    ps.executeQuery().use { rs ->
                        val labels = (1..rs.metaData.columnCount).map { rs.metaData.getColumnLabel(it).lowercase() }
                        buildList {
                            while (rs.next()) {
                                add(
                                    labels.indices.joinToString("|") { "${labels[it]}=${rs.getString(it + 1)}" },
                                )
                            }
                        }.sorted()
                    }
                }
            }
        }

    /** 投影の行と、進んだ版の記録を、すべて消す（子の表から）。 */
    fun wipe(gameId: String) =
        PROJECTION_TABLES.reversed().forEach { execute("DELETE FROM $it WHERE game_id = ?", gameId) }

    fun deleteRetentionPolicy(gameId: String) = execute("DELETE FROM retention_policies WHERE game_id = ?", gameId)

    fun corruptOverview(gameId: String) =
        execute("UPDATE game_overview SET retention_days = 7 WHERE game_id = ?", gameId)

    fun rewindSessionCheckpoint(gameId: String) =
        execute(
            "UPDATE projection_checkpoints SET projected_version = projected_version - 1 " +
                "WHERE game_id = ? AND stream_type = 'SESSION'",
            gameId,
        )

    private fun id(gameId: String) = GameId(UUID.fromString(gameId))

    private fun execute(
        sql: String,
        gameId: String,
    ) = dataSource.connection.use { connection ->
        connection.prepareStatement(sql).use { ps ->
            ps.setObject(1, UUID.fromString(gameId))
            ps.executeUpdate()
        }
    }
}
