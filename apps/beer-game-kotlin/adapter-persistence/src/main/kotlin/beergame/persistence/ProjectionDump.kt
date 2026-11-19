package beergame.persistence

import beergame.application.Inconsistency
import beergame.domain.GameId
import beergame.domain.ProjectionTable
import java.sql.Connection

/**
 * 1 ゲームの投影の全行を、比較のための文字列にしたもの（表ごと。行は並べ替え済み）。
 * 値の表現（JSON の整形、時刻の書式）の違いを避けるため、**DB が返す文字列**を、再構築の前後で比べる
 * （同じ DB・同じ列から読むので、表現が同じになる）。
 */
internal class ProjectionDump(
    val tables: Map<String, List<String>>,
) {
    val totalRows: Int get() = tables.values.sumOf { it.size }

    /** [expected] を作り直した結果として、この内容との差を表ごとに数える。 */
    fun differences(expected: ProjectionDump): List<Inconsistency.RowDrift> =
        tables.keys.mapNotNull { table ->
            val actualRows = tables.getValue(table).groupingBy { it }.eachCount()
            val expectedRows =
                expected.tables[table]
                    .orEmpty()
                    .groupingBy { it }
                    .eachCount()
            val missing = surplus(expectedRows, actualRows)
            val unexpected = surplus(actualRows, expectedRows)
            if (missing == 0 && unexpected == 0) null else Inconsistency.RowDrift(table, missing, unexpected)
        }

    private fun surplus(
        left: Map<String, Int>,
        right: Map<String, Int>,
    ): Int = left.entries.sumOf { (row, count) -> (count - right.getOrDefault(row, 0)).coerceAtLeast(0) }

    companion object {
        fun read(
            connection: Connection,
            gameId: GameId,
        ): ProjectionDump =
            ProjectionDump(ProjectionTable.entries.associate { it.sqlName to rows(connection, it, gameId) })

        private fun rows(
            connection: Connection,
            table: ProjectionTable,
            gameId: GameId,
        ): List<String> =
            connection.prepareStatement("SELECT * FROM ${table.sqlName} WHERE game_id = ?").use { ps ->
                ps.setObject(1, gameId.value)
                ps.executeQuery().use { rs ->
                    val columns = (1..rs.metaData.columnCount).map { rs.metaData.getColumnLabel(it).lowercase() }
                    buildList {
                        while (rs.next()) {
                            add(columns.indices.joinToString("|") { "${columns[it]}=${rs.getString(it + 1)}" })
                        }
                    }.sorted()
                }
            }
    }
}
