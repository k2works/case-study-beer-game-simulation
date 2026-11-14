package beergame.persistence

import beergame.application.AppFailure
import beergame.application.PersistenceFailure
import org.postgresql.util.PSQLException
import java.sql.SQLException

private const val MESSAGE_LIMIT = 200

/**
 * 違反した制約の名前。PostgreSQL はサーバーのエラーの制約名のフィールド（`constraint`）を使う。
 * H2 には専用のフィールドが無く、メッセージに制約名（`DATABASE_TO_LOWER=TRUE` では小文字。実測）が含まれるので、
 * 大文字小文字を区別せずに探す。H2 のメッセージには行の値（VALUES）も含まれるので、メッセージ自体は保存しない。
 */
internal fun SQLException.violatedConstraint(): String? = serverConstraint() ?: constraintInMessage()

private fun SQLException.serverConstraint(): String? = (this as? PSQLException)?.serverErrorMessage?.constraint

private fun SQLException.constraintInMessage(): String? {
    val text = message.orEmpty()
    return ConstraintNames.retryable.firstOrNull { text.contains(it, ignoreCase = true) }
}

private fun SQLException.uniqueViolation(operation: String): AppFailure {
    val constraint = violatedConstraint()
    return if (constraint != null && constraint in ConstraintNames.retryable) {
        AppFailure.ConcurrencyConflict
    } else {
        AppFailure.Persistence(PersistenceFailure(operation, "SQLSTATE=$sqlState constraint=$constraint"))
    }
}

/**
 * 例外を境界で値にする。40001・40P01、再試行の対象の一意制約の違反は ConcurrencyConflict、55P03（ロックの待ちの上限）は RetryExhausted。
 * それ以外は Persistence（値を含みうるメッセージは、一意違反では載せない）。
 */
internal fun SQLException.toAppFailure(operation: String): AppFailure =
    when (sqlState) {
        SqlStates.SERIALIZATION_FAILURE, SqlStates.DEADLOCK -> {
            AppFailure.ConcurrencyConflict
        }

        SqlStates.LOCK_NOT_AVAILABLE -> {
            AppFailure.RetryExhausted
        }

        SqlStates.UNIQUE_VIOLATION -> {
            uniqueViolation(operation)
        }

        else -> {
            // 行の値を含みうるメッセージは載せない。PostgreSQL のサーバーの主メッセージ（詳細を除く）だけを載せる。
            val primary = (this as? PSQLException)?.serverErrorMessage?.message?.take(MESSAGE_LIMIT)
            AppFailure.Persistence(PersistenceFailure(operation, "SQLSTATE=$sqlState $primary"))
        }
    }
