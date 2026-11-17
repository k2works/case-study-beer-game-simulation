package beergame.persistence

import arrow.core.Either
import arrow.core.left
import beergame.application.AppFailure
import beergame.application.PersistenceFailure
import beergame.application.Tx
import beergame.domain.Value
import java.sql.PreparedStatement
import java.sql.ResultSet
import java.sql.SQLException
import java.sql.Types
import java.time.Instant
import java.time.OffsetDateTime
import java.time.ZoneOffset
import java.util.UUID

/** このアダプターが作った [JdbcTx] だけを受け取る。別の実装の Tx は、設計上渡らないので Persistence の失敗にする。 */
internal fun Tx.jdbc(operation: String): Either<AppFailure, JdbcTx> =
    (this as? JdbcTx)?.let { Either.Right(it) }
        ?: AppFailure.Persistence(PersistenceFailure(operation, "JDBC のトランザクションではない")).left()

/** JDBC の呼び出しを、SQLException を値にして返す境界。キャンセル（CancellationException）は捕まえない。 */
internal inline fun <A> jdbcCall(
    operation: String,
    block: () -> Either<AppFailure, A>,
): Either<AppFailure, A> =
    try {
        block()
    } catch (e: SQLException) {
        e.toAppFailure(operation).left()
    }

/** プレースホルダへ、先頭から順に値を結びつける（添字を数えない）。 */
internal class Params(
    private val ps: PreparedStatement,
) {
    private var next = 1

    fun uuid(value: UUID?) =
        apply {
            if (value ==
                null
            ) {
                ps.setNull(next++, Types.OTHER)
            } else {
                ps.setObject(next++, value)
            }
        }

    fun string(value: String) = apply { ps.setString(next++, value) }

    fun int(value: Int) = apply { ps.setInt(next++, value) }

    fun long(value: Long) = apply { ps.setLong(next++, value) }

    fun bytes(value: ByteArray) = apply { ps.setBytes(next++, value) }

    fun instant(value: Instant) = apply { ps.setObject(next++, value.atOffset(ZoneOffset.UTC)) }

    /** 時刻（無ければ NULL）。 */
    fun instantOrNull(value: Instant?) =
        apply {
            if (value == null) {
                ps.setNull(next++, Types.TIMESTAMP_WITH_TIMEZONE)
            } else {
                instant(value)
            }
        }

    /** 投影の値。JSON は文字列として結び、方言ごとの式（[Dialect.jsonParam]）が列へ書く。 */
    fun value(value: Value) =
        apply {
            when (value) {
                is Value.Text -> ps.setString(next++, value.value)
                is Value.Num -> ps.setInt(next++, value.value)
                is Value.Big -> ps.setLong(next++, value.value)
                is Value.Id -> ps.setObject(next++, value.value)
                is Value.At -> ps.setObject(next++, value.value.atOffset(ZoneOffset.UTC))
                is Value.Json -> ps.setString(next++, value.raw)
                is Value.Null -> ps.setNull(next++, Types.NULL)
            }
        }
}

internal fun PreparedStatement.params(): Params = Params(this)

internal fun ResultSet.getInstant(label: String): Instant = getObject(label, OffsetDateTime::class.java).toInstant()

internal fun ResultSet.getUuid(label: String): UUID? = getObject(label, UUID::class.java)
