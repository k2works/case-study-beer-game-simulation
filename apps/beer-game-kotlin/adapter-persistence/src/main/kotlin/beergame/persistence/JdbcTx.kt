package beergame.persistence

import beergame.application.Tx
import java.sql.Connection

/** JDBC の接続を持つトランザクション。コミット後・終了時（COMMIT でも ROLLBACK でも）の後始末を積める。 */
class JdbcTx(
    val connection: Connection,
) : Tx {
    private val commitHooks = mutableListOf<() -> Unit>()
    private val endHooks = mutableListOf<() -> Unit>()

    /** COMMIT が成功したときだけ呼ぶ（ROLLBACK では捨てる）。 */
    fun afterCommit(hook: () -> Unit) {
        commitHooks += hook
    }

    /** COMMIT でも ROLLBACK でも、トランザクションの終了で 1 回だけ呼ぶ（ロックの解放など）。 */
    fun afterEnd(hook: () -> Unit) {
        endHooks += hook
    }

    internal fun runCommitHooks() = drain(commitHooks)

    internal fun runEndHooks() = drain(endHooks)

    private fun drain(hooks: MutableList<() -> Unit>) {
        val pending = hooks.toList()
        hooks.clear()
        pending.forEach { it() }
    }
}
