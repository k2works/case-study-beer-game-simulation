package beergame.persistence

import arrow.core.Either
import arrow.core.flatMap
import arrow.core.right
import beergame.application.AppFailure
import beergame.application.ProjectionWriter
import beergame.application.Tx
import beergame.domain.DomainEvent
import beergame.domain.EventEnvelope
import beergame.domain.GameId
import beergame.domain.GuidedTour
import beergame.domain.Projections
import beergame.domain.RowChange
import beergame.domain.StreamType
import beergame.domain.Value

/**
 * 同期投影の書き込み（ADR-003）。純粋な [Projections] が返した行の変更を、呼び出し側のトランザクションで適用し、
 * `projection_checkpoints` を更新する。更新の順序は、表の固定の順序（data-model.md L3）で、同じ表では発行の順。
 * Upsert は「UPDATE して、0 行なら INSERT」で、PostgreSQL と H2 の両方で同じ意味になる（部分の更新ができる）。
 */
@GuidedTour(
    name = "CQRS（コマンドと問い合わせの分離）",
    rank = 6,
    stage = "イベントと投影",
    description =
        "導いた行の変更を、追記と同じトランザクションで書く（同期投影）。" +
            "書いた版を projection_checkpoints に残し、問い合わせ側が古い表示を捨てられるようにする",
)
internal class JdbcProjectionWriter(
    private val dialect: Dialect,
) : ProjectionWriter {
    override suspend fun write(
        tx: Tx,
        gameId: GameId,
        events: List<EventEnvelope<DomainEvent>>,
    ): Either<AppFailure, Unit> =
        tx.jdbc(OP).flatMap { jdbcTx ->
            jdbcCall(OP) {
                events.forEach { event -> Projections.project(event).forEach { apply(jdbcTx, it) } }
                checkpoints(events).forEach { (stream, last) -> checkpoint(jdbcTx, gameId, stream, last) }
                Unit.right()
            }
        }

    private fun checkpoints(events: List<EventEnvelope<DomainEvent>>) =
        events.groupBy { it.streamType }.mapValues { (_, list) -> list.maxBy { it.streamVersion.value } }

    private fun apply(
        tx: JdbcTx,
        change: RowChange,
    ) {
        when (change) {
            is RowChange.Upsert -> upsert(tx, change)
            is RowChange.Delete -> delete(tx, change)
        }
    }

    private fun upsert(
        tx: JdbcTx,
        change: RowChange.Upsert,
    ) {
        val table = change.table.sqlName
        val keys =
            change.key.parts.entries
                .toList()
        val values = change.values.entries.toList()
        require(values.isNotEmpty()) { "Upsert の値が空: $table" }
        val setSql = values.joinToString(", ") { "${identifier(it.key.name)} = ${placeholder(it.value)}" }
        val whereSql = keys.joinToString(" AND ") { "${identifier(it.key.name)} = ?" }
        val updated =
            tx.connection.prepareStatement("UPDATE $table SET $setSql WHERE $whereSql").use { ps ->
                ps.params().also { p ->
                    values.forEach { p.value(it.value) }
                    keys.forEach { p.value(it.value) }
                }
                ps.executeUpdate()
            }
        if (updated == 0) {
            val all = keys + values
            val columns = all.joinToString(", ") { identifier(it.key.name) }
            val marks = all.joinToString(", ") { placeholder(it.value) }
            tx.connection.prepareStatement("INSERT INTO $table ($columns) VALUES ($marks)").use { ps ->
                ps.params().also { p -> all.forEach { p.value(it.value) } }
                ps.executeUpdate()
            }
        }
    }

    private fun delete(
        tx: JdbcTx,
        change: RowChange.Delete,
    ) {
        val keys =
            change.key.parts.entries
                .toList()
        val whereSql = keys.joinToString(" AND ") { "${identifier(it.key.name)} = ?" }
        tx.connection.prepareStatement("DELETE FROM ${change.table.sqlName} WHERE $whereSql").use { ps ->
            ps.params().also { p -> keys.forEach { p.value(it.value) } }
            ps.executeUpdate()
        }
    }

    private fun checkpoint(
        tx: JdbcTx,
        gameId: GameId,
        stream: StreamType,
        last: EventEnvelope<DomainEvent>,
    ) {
        val updated =
            tx.connection.prepareStatement(UPDATE_CHECKPOINT_SQL).use { ps ->
                ps
                    .params()
                    .long(
                        last.streamVersion.value,
                    ).instant(last.occurredAt)
                    .uuid(gameId.value)
                    .string(stream.name)
                ps.executeUpdate()
            }
        if (updated == 0) {
            tx.connection.prepareStatement(INSERT_CHECKPOINT_SQL).use { ps ->
                ps
                    .params()
                    .uuid(
                        gameId.value,
                    ).string(stream.name)
                    .long(last.streamVersion.value)
                    .instant(last.occurredAt)
                ps.executeUpdate()
            }
        }
    }

    private fun placeholder(value: Value): String = if (value is Value.Json) dialect.jsonParam else "?"

    /** 表名・列名は、このコードの定数（投影の定義）から来るが、SQL に連結するので形を検査する。 */
    private fun identifier(name: String): String {
        require(IDENTIFIER.matches(name)) { "列名が不正: $name" }
        return name
    }

    private companion object {
        const val OP = "projection.write"
        val IDENTIFIER = Regex("[a-z][a-z0-9_]*")
        const val UPDATE_CHECKPOINT_SQL =
            "UPDATE projection_checkpoints SET projected_version = ?, updated_at = ? " +
                "WHERE game_id = ? AND stream_type = ?"
        const val INSERT_CHECKPOINT_SQL =
            "INSERT INTO projection_checkpoints (game_id, stream_type, projected_version, updated_at) " +
                "VALUES (?, ?, ?, ?)"
    }
}
