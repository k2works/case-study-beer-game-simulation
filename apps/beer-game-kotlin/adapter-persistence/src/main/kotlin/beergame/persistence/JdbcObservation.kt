package beergame.persistence

import arrow.core.Either
import arrow.core.left
import arrow.core.raise.either
import arrow.core.raise.ensureNotNull
import arrow.core.right
import beergame.application.AppFailure
import beergame.application.GameStatus
import beergame.application.ObservationReader
import beergame.application.ProjectedInvitation
import beergame.application.ProjectedObservation
import beergame.application.ProjectedObserver
import beergame.application.ProjectedSession
import beergame.application.ProjectedTeamTotal
import beergame.application.SessionStatus
import beergame.domain.DisclosurePolicy
import beergame.domain.GameId
import beergame.domain.InvitationId
import beergame.domain.ObserverId
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.sql.Connection
import java.sql.ResultSet
import java.sql.SQLException
import java.time.OffsetDateTime
import javax.sql.DataSource

/*
 * 観察者（B9）の投影の読み取り。
 * - [ObservationRows]: 主の読み取り（[JdbcProjectionReader]）が使う、チーム合計・観察用の招待・観察者・公開範囲の行。
 * - [JdbcObservationReader]: 観察者用の読み取り。**`game_overview`・`session_overview`・`week_team_totals` の 3 表だけ**を読む
 *   （DB ロール `beergame_observer` の SELECT と同じ。`game_join_codes`・役割別の表・`game_settings` には触れない）。
 *   観察者用の接続プール（`SET ROLE beergame_observer`）の [DataSource] を渡すと、DB の権限でも、この 3 表に限られる。
 */

internal object ObservationRows {
    private const val TOTALS_SQL =
        "SELECT week, total_ordered, total_inventory, total_backlog, contributors " +
            "FROM week_team_totals WHERE game_id = ? ORDER BY week"
    private const val INVITATIONS_SQL =
        "SELECT invitation_id, expires_at, revoked_at, created_at FROM lobby_observer_invitations " +
            "WHERE game_id = ? ORDER BY created_at, invitation_id"
    private const val OBSERVERS_SQL =
        "SELECT o.observer_id, d.display_name, o.joined_at FROM lobby_observers o " +
            "LEFT JOIN display_profiles d ON d.game_id = o.game_id AND d.actor_kind = 'OBSERVER' " +
            "AND d.actor_id = o.observer_id WHERE o.game_id = ? ORDER BY o.joined_at, o.observer_id"
    private const val DISCLOSURE_SQL = "SELECT disclosure_policy FROM game_settings WHERE game_id = ?"

    fun teamTotals(
        c: Connection,
        gameId: GameId,
    ): List<ProjectedTeamTotal> =
        c.query(TOTALS_SQL, gameId) { rs ->
            ProjectedTeamTotal(
                week = rs.getInt("week"),
                ordered = rs.getInt("total_ordered"),
                inventory = rs.getInt("total_inventory"),
                backlog = rs.getInt("total_backlog"),
                contributors = rs.getInt("contributors"),
            )
        }

    fun invitations(
        c: Connection,
        gameId: GameId,
    ): Either<AppFailure, List<ProjectedInvitation>> =
        c
            .query(INVITATIONS_SQL, gameId) { rs ->
                rs.getUuid("invitation_id")?.let {
                    ProjectedInvitation(
                        InvitationId(it),
                        rs.getInstant("expires_at"),
                        rs.getObject("revoked_at", OffsetDateTime::class.java)?.toInstant(),
                        rs.getInstant("created_at"),
                    )
                }
            }.map { it?.right() ?: failure("招待の ID が無い").left() }
            .let { rows -> either { rows.map { it.bind() } } }

    fun observers(
        c: Connection,
        gameId: GameId,
    ): Either<AppFailure, List<ProjectedObserver>> =
        c
            .query(OBSERVERS_SQL, gameId) { rs ->
                rs.getUuid("observer_id")?.let {
                    ProjectedObserver(ObserverId(it), rs.getString("display_name"), rs.getInstant("joined_at"))
                }
            }.map { it?.right() ?: failure("観察者の ID が無い").left() }
            .let { rows -> either { rows.map { it.bind() } } }

    /** 公開範囲。行が無い（古い行）か、NULL なら、既定（チーム合計）。不明な値は失敗。 */
    fun disclosure(
        c: Connection,
        gameId: GameId,
    ): Either<AppFailure, DisclosurePolicy> {
        val raw = c.query(DISCLOSURE_SQL, gameId) { rs -> rs.getString("disclosure_policy") }.firstOrNull()
        return if (raw == null) {
            DisclosurePolicy.TEAM_TOTAL.right()
        } else {
            DisclosurePolicy.entries.firstOrNull { it.name == raw }?.right() ?: failure("公開範囲が不正: $raw").left()
        }
    }
}

class JdbcObservationReader(
    private val dataSource: DataSource,
    private val ioDispatcher: CoroutineDispatcher = Dispatchers.IO,
) : ObservationReader {
    override suspend fun read(gameId: GameId): Either<AppFailure, ProjectedObservation?> =
        withContext(ioDispatcher) {
            try {
                dataSource.connection.use { connection ->
                    connection.autoCommit = false
                    connection.isReadOnly = true
                    connection.transactionIsolation = Connection.TRANSACTION_REPEATABLE_READ
                    try {
                        readObservation(connection, gameId)
                    } finally {
                        connection.rollback()
                    }
                }
            } catch (e: SQLException) {
                e.toAppFailure(OP).left()
            }
        }

    private fun readObservation(
        c: Connection,
        gameId: GameId,
    ): Either<AppFailure, ProjectedObservation?> =
        either {
            val head = c.query(HEAD_SQL, gameId, ::headOf).firstOrNull()
            if (head == null) {
                null
            } else {
                val status = ensureNotNull(GameStatus.entries.firstOrNull { it.name == head.first }) { statusFailure }
                ProjectedObservation(
                    status,
                    head.second,
                    session(c, gameId).bind(),
                    ObservationRows.teamTotals(c, gameId),
                )
            }
        }

    private fun session(
        c: Connection,
        gameId: GameId,
    ): Either<AppFailure, ProjectedSession?> {
        val row =
            c
                .query(SESSION_SQL, gameId) { rs ->
                    Triple(rs.getString("status"), rs.getInt("week"), rs.getInt("submitted_role_count"))
                }.firstOrNull() ?: return Either.Right(null)
        val status = SessionStatus.entries.firstOrNull { it.name == row.first }
        return status?.let { ProjectedSession(it, row.second, row.third).right() }
            ?: failure("セッションの状態が不正: ${row.first}").left()
    }

    private fun headOf(rs: ResultSet): Pair<String, Int> = rs.getString("status") to rs.getInt("final_week")

    private companion object {
        val statusFailure: AppFailure = failure("ゲームの状態が不正")
        const val OP = "observation.read"
        const val HEAD_SQL = "SELECT status, final_week FROM game_overview WHERE game_id = ?"
        const val SESSION_SQL = "SELECT status, week, submitted_role_count FROM session_overview WHERE game_id = ?"
    }
}
