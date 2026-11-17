package beergame.persistence

import arrow.core.Either
import arrow.core.left
import arrow.core.raise.either
import arrow.core.raise.ensureNotNull
import arrow.core.right
import beergame.application.AppFailure
import beergame.application.GameStatus
import beergame.application.PersistenceFailure
import beergame.application.ProjectedDecision
import beergame.application.ProjectedGame
import beergame.application.ProjectedParticipant
import beergame.application.ProjectedRoleState
import beergame.application.ProjectedSession
import beergame.application.ProjectedWeekResult
import beergame.application.ProjectionReader
import beergame.application.SessionStatus
import beergame.application.SettingsSummary
import beergame.application.Versions
import beergame.domain.Editor
import beergame.domain.GameId
import beergame.domain.ParticipantId
import beergame.domain.Role
import beergame.domain.StreamType
import beergame.domain.StreamVersion
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonPrimitive
import java.sql.Connection
import java.sql.ResultSet
import java.sql.SQLException
import java.util.UUID
import javax.sql.DataSource

/**
 * 投影の読み取り（問い合わせ側。イベントストアを経由しない）。1 回の読み取りは、**読み取り専用の REPEATABLE READ の
 * トランザクション**で行い、`projection_checkpoints` も同じトランザクションで読む。応答の版が、同じ応答の行より新しくならない
 * （行より新しい版を返すと、画面が通知を捨てて古い表示のまま残る）。
 * H2 でも同じ指定をするが、分離の動作の同一性は検証していない（検証は PostgreSQL の統合テストだけ）。
 * 読み取り専用のデータベースロール（観察者用の別の接続プールを含む）は B2・B9。B1 は 1 つの接続プールを使う。
 */
internal class JdbcProjectionReader(
    private val dataSource: DataSource,
    private val ioDispatcher: CoroutineDispatcher = Dispatchers.IO,
) : ProjectionReader {
    override suspend fun read(gameId: GameId): Either<AppFailure, ProjectedGame?> =
        withContext(ioDispatcher) {
            try {
                dataSource.connection.use { connection ->
                    connection.autoCommit = false
                    connection.isReadOnly = true
                    connection.transactionIsolation = Connection.TRANSACTION_REPEATABLE_READ
                    try {
                        readGame(connection, gameId)
                    } finally {
                        connection.rollback()
                    }
                }
            } catch (e: SQLException) {
                e.toAppFailure(OP).left()
            }
        }

    private fun readGame(
        c: Connection,
        gameId: GameId,
    ): Either<AppFailure, ProjectedGame?> =
        either {
            val head =
                c.query(
                    HEAD_SQL,
                    gameId,
                ) { rs ->
                    Head(
                        rs.getString("status"),
                        rs.getInt("final_week"),
                        rs.getString("join_code"),
                        SettingsSummary(
                            rs.getString("settings_kind"),
                            changesOf(rs.getString("settings_changes")),
                            rs.getString("commit_mode"),
                        ),
                    )
                }
            val first = head.firstOrNull()
            if (first == null) {
                null
            } else {
                val status =
                    ensureNotNull(GameStatus.entries.firstOrNull { it.name == first.status }) { failure("ゲームの状態が不正") }
                ProjectedGame(
                    gameId = gameId,
                    status = status,
                    finalWeek = first.finalWeek,
                    joinCode = first.joinCode,
                    settings = first.settings,
                    participants = participants(c, gameId).bind(),
                    session = session(c, gameId).bind(),
                    roleStates = roleStates(c, gameId).bind(),
                    decisions = decisions(c, gameId).bind(),
                    results = results(c, gameId).bind(),
                    versions = versions(c, gameId),
                    disclosure = ObservationRows.disclosure(c, gameId).bind(),
                    teamTotals = ObservationRows.teamTotals(c, gameId),
                    invitations = ObservationRows.invitations(c, gameId).bind(),
                    observers = ObservationRows.observers(c, gameId).bind(),
                    retention = RetentionRows.read(c, gameId),
                )
            }
        }

    private fun participants(
        c: Connection,
        gameId: GameId,
    ): Either<AppFailure, List<ProjectedParticipant>> =
        c
            .query(
                PARTICIPANTS_SQL,
                gameId,
            ) { rs ->
                ParticipantRow(
                    rs.getUuid("participant_id"),
                    rs.getString("role"),
                    rs.getString("display_name"),
                    rs.getBoolean("replaced"),
                )
            }.map { row ->
                val parsed = row.role?.let { roleOf(it) }
                when {
                    row.id == null -> failure("参加者の ID が無い").left()
                    row.role != null && parsed == null -> failure("役割が不正: ${row.role}").left()
                    else -> ProjectedParticipant(ParticipantId(row.id), row.name, parsed, row.replaced).right()
                }
            }.sequence()

    /** 参加者の 1 行。[replaced] は、役割の入れ替えで外された旧担当者（`replaced_at` がある）。 */
    private data class ParticipantRow(
        val id: UUID?,
        val role: String?,
        val name: String?,
        val replaced: Boolean,
    )

    private fun session(
        c: Connection,
        gameId: GameId,
    ): Either<AppFailure, ProjectedSession?> {
        val row =
            c
                .query(
                    SESSION_SQL,
                    gameId,
                ) { rs -> Triple(rs.getString("status"), rs.getInt("week"), rs.getInt("submitted_role_count")) }
                .firstOrNull() ?: return Either.Right(null)
        val status = SessionStatus.entries.firstOrNull { it.name == row.first }
        return if (status == null) {
            failure("セッションの状態が不正: ${row.first}").left()
        } else {
            ProjectedSession(status, row.second, row.third).right()
        }
    }

    private fun roleStates(
        c: Connection,
        gameId: GameId,
    ): Either<AppFailure, Map<Role, ProjectedRoleState>> =
        c
            .query(ROLE_STATES_SQL, gameId) { rs ->
                roleOf(rs.getString("role")) to
                    ProjectedRoleState(
                        rs.getInt("inventory"),
                        rs.getInt("backlog"),
                        rs.getInt("arrivals"),
                        rs.getInt("orders"),
                        rs.getLong("cumulative_cost_minor"),
                        rs.getInt("as_of_week"),
                    )
            }.map { (role, state) -> if (role == null) failure("役割が不正").left() else (role to state).right() }
            .sequence()
            .map { it.toMap() }

    private fun decisions(
        c: Connection,
        gameId: GameId,
    ): Either<AppFailure, Map<Role, ProjectedDecision>> =
        c
            .query(DECISIONS_SQL, gameId) { rs ->
                val role = roleOf(rs.getString("role"))
                val editor = editorOf(rs.getString("editor_kind"), rs.getUuid("editor_id"))
                if (role == null || editor == null) {
                    null
                } else {
                    role to
                        ProjectedDecision(
                            week = rs.getInt("week"),
                            quantity = rs.getInt("quantity"),
                            version = rs.getLong("decision_version"),
                            editor = editor,
                            savedAt = rs.getInstant("updated_at"),
                        )
                }
            }.map { it?.right() ?: failure("役割または入力者が不正").left() }
            .sequence()
            .map { it.toMap() }

    private fun results(
        c: Connection,
        gameId: GameId,
    ): Either<AppFailure, List<ProjectedWeekResult>> =
        c
            .query(RESULTS_SQL, gameId) { rs ->
                roleOf(rs.getString("role"))?.let { role ->
                    ProjectedWeekResult(
                        week = rs.getInt("week"),
                        role = role,
                        orders = rs.getInt("demand"),
                        shipped = rs.getInt("shipped"),
                        ordered = rs.getInt("ordered"),
                        endingInventory = rs.getInt("ending_inventory"),
                        endingBacklog = rs.getInt("ending_backlog"),
                        weeklyCostMinor = rs.getLong("weekly_cost_minor"),
                        cumulativeCostMinor = rs.getLong("cumulative_cost_minor"),
                    )
                }
            }.map { it?.right() ?: failure("役割が不正").left() }
            .sequence()

    private fun versions(
        c: Connection,
        gameId: GameId,
    ): Versions {
        val byStream =
            c
                .query(VERSIONS_SQL, gameId) { rs -> rs.getString("stream_type") to rs.getLong("projected_version") }
                .toMap()

        fun of(stream: StreamType): StreamVersion? = byStream[stream.name]?.let { StreamVersion.of(it).getOrNull() }
        return Versions(of(StreamType.GAME), of(StreamType.SESSION))
    }

    private data class Head(
        val status: String,
        val finalWeek: Int,
        val joinCode: String,
        val settings: SettingsSummary,
    )

    private companion object {
        const val HEAD_SQL =
            "SELECT o.status, o.final_week, o.settings_kind, o.settings_changes, o.commit_mode, j.join_code " +
                "FROM game_overview o " +
                "JOIN game_join_codes j ON j.game_id = o.game_id WHERE o.game_id = ?"
        const val PARTICIPANTS_SQL =
            "SELECT l.participant_id, l.role, d.display_name, (l.replaced_at IS NOT NULL) AS replaced " +
                "FROM lobby_participants l " +
                "LEFT JOIN display_profiles d ON d.game_id = l.game_id AND d.actor_kind = 'PARTICIPANT' " +
                "AND d.actor_id = l.participant_id WHERE l.game_id = ? ORDER BY l.joined_at, l.participant_id"
        const val SESSION_SQL = "SELECT status, week, submitted_role_count FROM session_overview WHERE game_id = ?"
        const val ROLE_STATES_SQL =
            "SELECT role, inventory, backlog, arrivals, orders, cumulative_cost_minor, as_of_week " +
                "FROM role_current_states WHERE game_id = ?"
        const val DECISIONS_SQL =
            "SELECT role, week, quantity, decision_version, editor_kind, editor_id, updated_at " +
                "FROM current_decisions WHERE game_id = ?"
        const val RESULTS_SQL =
            "SELECT role, week, demand, shipped, ordered, ending_inventory, ending_backlog, weekly_cost_minor, " +
                "cumulative_cost_minor FROM week_role_results WHERE game_id = ? ORDER BY week"
        const val VERSIONS_SQL = "SELECT stream_type, projected_version FROM projection_checkpoints WHERE game_id = ?"
    }
}

private const val OP = "projection.read"

/** `game_overview.settings_changes`（項目名の JSON 配列）を読む。読めなければ空（種別だけで足りる）。 */
private fun changesOf(raw: String?): List<String> =
    raw?.let { Json.parseToJsonElement(it).jsonArray.map { e -> e.jsonPrimitive.content } }.orEmpty()

private fun roleOf(name: String): Role? = Role.entries.firstOrNull { it.name == name }

/** `current_decisions.editor_kind`（`PARTICIPANT`・`FACILITATOR`）と `editor_id` から、入力者を復元する。不明な種別は null。 */
private fun editorOf(
    kind: String,
    id: UUID?,
): Editor? =
    when {
        id == null -> null
        kind == "PARTICIPANT" -> Editor.ByParticipant(ParticipantId(id))
        kind == "FACILITATOR" -> Editor.ByFacilitator(GameId(id))
        else -> null
    }

internal fun failure(message: String): AppFailure = AppFailure.Persistence(PersistenceFailure(OP, message))

/** 最初の Left で止めて返す。すべて Right なら、値の列。 */
private fun <T> List<Either<AppFailure, T>>.sequence(): Either<AppFailure, List<T>> = either { map { it.bind() } }

internal fun <T> Connection.query(
    sql: String,
    gameId: GameId,
    map: (ResultSet) -> T,
): List<T> =
    prepareStatement(sql).use { ps ->
        ps.params().uuid(gameId.value)
        ps.executeQuery().use { rs -> generateSequence { if (rs.next()) map(rs) else null }.toList() }
    }
