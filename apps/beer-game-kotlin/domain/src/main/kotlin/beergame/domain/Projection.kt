package beergame.domain

import java.time.Instant
import java.util.UUID

/*
 * 投影（読み取りモデル）。イベント 1 件から、行の変更の列を作る純粋関数（domain-model.md「投影」）。
 * SQL を知らず、他の投影も読まない。変更の適用（SQL）は adapter-persistence の責務。
 *
 * 判断項目 #12（B1）: 観察者向けの表（`lobby_observer_invitations`、`lobby_observers`）と、観察者向けの
 * `week_team_totals` は、表は作るが、B1 の投影は書かない（観察者のイベントが無く、B9 で公開範囲と一緒に書く）。
 */

/** 投影の表。宣言の順が、複数の行を更新するときの固定の順序（data-model.md L3）。 */
enum class ProjectionTable(
    val sqlName: String,
) {
    GAME_OVERVIEW("game_overview"),
    GAME_JOIN_CODES("game_join_codes"),
    GAME_SETTINGS("game_settings"),
    LOBBY_PARTICIPANTS("lobby_participants"),
    SESSION_OVERVIEW("session_overview"),
    ROLE_CURRENT_STATES("role_current_states"),
    CURRENT_DECISIONS("current_decisions"),
    WEEK_COMMITS("week_commits"),
    WEEK_ROLE_RESULTS("week_role_results"),
}

@JvmInline
value class Column(
    val name: String,
)

/** 行の値。SQL の型に対応する最小の集まり。JSON は、組み立て済みの JSON 文字列（[Json]）で持つ。 */
sealed interface Value {
    data class Text(
        val value: String,
    ) : Value

    data class Num(
        val value: Int,
    ) : Value

    data class Big(
        val value: Long,
    ) : Value

    data class Id(
        val value: UUID,
    ) : Value

    data class At(
        val value: Instant,
    ) : Value

    data class Json(
        val raw: String,
    ) : Value

    data object Null : Value
}

/** 主キーの列と値。 */
data class RowKey(
    val parts: Map<Column, Value>,
)

/** 行の変更。[Upsert] の [values] は主キー以外の列で、無い列は更新しない（部分の更新）。 */
sealed interface RowChange {
    val table: ProjectionTable
    val key: RowKey

    data class Upsert(
        override val table: ProjectionTable,
        override val key: RowKey,
        val values: Map<Column, Value>,
    ) : RowChange

    data class Delete(
        override val table: ProjectionTable,
        override val key: RowKey,
    ) : RowChange
}

/** 投影 1 本の形。イベントのペイロードと封筒だけから行の変更を作る。 */
fun interface Projection {
    fun project(event: EventEnvelope<DomainEvent>): List<RowChange>
}

/** ストリーム全体の変更を順に集める（再構築と検証に使う）。 */
fun Projection.replay(events: List<EventEnvelope<DomainEvent>>): List<RowChange> = events.flatMap { project(it) }

private fun col(name: String) = Column(name)

private fun text(s: String): Value = Value.Text(s)

private fun num(n: Int): Value = Value.Num(n)

private fun big(n: Long): Value = Value.Big(n)

private fun jsonInts(values: List<Int>): Value =
    Value.Json(values.joinToString(prefix = "[", postfix = "]", separator = ","))

private fun gameKey(event: EventEnvelope<DomainEvent>): Map<Column, Value> =
    mapOf(col("game_id") to Value.Id(event.gameId.value))

private fun upsert(
    table: ProjectionTable,
    key: Map<Column, Value>,
    vararg values: Pair<String, Value>,
): RowChange = RowChange.Upsert(table, RowKey(key), values.associate { (name, v) -> col(name) to v })

private fun roleKey(
    event: EventEnvelope<DomainEvent>,
    role: Role,
): Map<Column, Value> = gameKey(event) + (col("role") to text(role.name))

private fun nextWeekOrSame(week: Week): Int = week.next()?.value ?: week.value

object Projections {
    /** `game_overview`: 参加コードを持たない（M1）。 */
    val gameOverview =
        Projection { e ->
            when (val p = e.payload) {
                is GameEvent.GameCreated -> {
                    listOf(
                        upsert(
                            ProjectionTable.GAME_OVERVIEW,
                            gameKey(e),
                            "status" to text("PREPARING"),
                            "final_week" to num(p.settings.finalWeek.value),
                            "commit_mode" to text(p.settings.commitMode.name),
                            "settings_kind" to text(if (p.settings.changedFields().isEmpty()) "KIT" else "CUSTOM"),
                            "settings_changes" to settingsChangesJson(p.settings),
                            "retention_days" to num(p.retentionDays.value),
                            "created_at" to Value.At(e.occurredAt),
                        ),
                    )
                }

                is GameEvent.GameStarted -> {
                    listOf(
                        upsert(
                            ProjectionTable.GAME_OVERVIEW,
                            gameKey(e),
                            "status" to text("STARTED"),
                            "started_at" to Value.At(e.occurredAt),
                        ),
                    )
                }

                is SessionEvent.CommitModeChanged -> {
                    listOf(upsert(ProjectionTable.GAME_OVERVIEW, gameKey(e), "commit_mode" to text(p.commitMode.name)))
                }

                is SessionEvent.SessionEnded -> {
                    listOf(
                        upsert(
                            ProjectionTable.GAME_OVERVIEW,
                            gameKey(e),
                            "status" to text("ENDED"),
                            "ended_at" to Value.At(e.occurredAt),
                        ),
                    )
                }

                else -> {
                    emptyList()
                }
            }
        }

    /** `game_join_codes`: 進行役と参加の問い合わせだけが読む。 */
    val gameJoinCodes =
        Projection { e ->
            when (val p = e.payload) {
                is GameEvent.GameCreated -> {
                    listOf(upsert(ProjectionTable.GAME_JOIN_CODES, gameKey(e), "join_code" to text(p.joinCode.value)))
                }

                else -> {
                    emptyList()
                }
            }
        }

    /** `game_settings`: 需要系列、費用、初期条件、遅延、公開範囲（B7 でカスタム条件を足した。キット準拠はキットの値を書く）。 */
    val gameSettings =
        Projection { e ->
            when (val p = e.payload) {
                is GameEvent.GameCreated -> {
                    listOf(
                        upsert(
                            ProjectionTable.GAME_SETTINGS,
                            gameKey(e),
                            "demand" to jsonInts(p.settings.demand.asInts()),
                            "holding_cost_minor" to big(p.settings.costPolicy.holding.minor),
                            "backlog_cost_minor" to big(p.settings.costPolicy.backlog.minor),
                            "initial_conditions" to initialConditionsJson(p.settings.initial),
                            "order_delay_weeks" to num(p.settings.delays.order.weeks),
                            "shipment_delay_weeks" to num(p.settings.delays.shipment.weeks),
                            "production_delay_weeks" to num(p.settings.delays.production.weeks),
                            "disclosure_policy" to text(p.settings.disclosure.name),
                        ),
                    )
                }

                else -> {
                    emptyList()
                }
            }
        }

    /** `lobby_participants`: 共同担当のため `(game_id, role)` は一意ではない。 */
    val lobbyParticipants =
        Projection { e ->
            when (val p = e.payload) {
                is GameEvent.ParticipantJoined -> {
                    listOf(
                        upsert(
                            ProjectionTable.LOBBY_PARTICIPANTS,
                            mapOf(col("participant_id") to Value.Id(p.participantId.value)),
                            "game_id" to Value.Id(e.gameId.value),
                            "role" to Value.Null,
                            "joined_at" to Value.At(e.occurredAt),
                        ),
                    )
                }

                is GameEvent.RoleAssigned -> {
                    listOf(
                        upsert(
                            ProjectionTable.LOBBY_PARTICIPANTS,
                            mapOf(col("participant_id") to Value.Id(p.participantId.value)),
                            "role" to text(p.role.name),
                        ),
                    )
                }

                is GameEvent.RoleUnassigned -> {
                    listOf(
                        upsert(
                            ProjectionTable.LOBBY_PARTICIPANTS,
                            mapOf(col("participant_id") to Value.Id(p.participantId.value)),
                            "role" to Value.Null,
                        ),
                    )
                }

                // B5: 役割の入れ替えで外れた旧担当者の行は消さず（履歴と入力者のラベルのため）、role を NULL にして入れ替えられた時刻を書く。
                // `replaced_at` の列は、マイグレーション（B5 Step 5.5）で足す。資格のイベントは購読しない（正本は `credentials`。L5）
                is GameEvent.ParticipantReplaced -> {
                    listOf(
                        upsert(
                            ProjectionTable.LOBBY_PARTICIPANTS,
                            mapOf(col("participant_id") to Value.Id(p.participantId.value)),
                            "role" to Value.Null,
                            "replaced_at" to Value.At(e.occurredAt),
                        ),
                    )
                }

                else -> {
                    emptyList()
                }
            }
        }

    /**
     * `session_overview`。確定で `week` は次の週に進む。最終週（`finalWeek`）は封筒にもペイロードにも無いので、
     * 50 週未満の最終週の確定後は `week` が最終週 + 1 になる（設計の未決。判断はステップ記録）。
     */
    val sessionOverview =
        Projection { e ->
            when (val p = e.payload) {
                is SessionEvent.SessionStarted -> {
                    listOf(
                        upsert(
                            ProjectionTable.SESSION_OVERVIEW,
                            gameKey(e),
                            "status" to text("ACTIVE"),
                            "week" to num(Week.FIRST.value),
                            "submitted_role_count" to num(0),
                            "started_at" to Value.At(e.occurredAt),
                        ),
                    )
                }

                is SessionEvent.DecisionSaved -> {
                    listOf(
                        upsert(
                            ProjectionTable.SESSION_OVERVIEW,
                            gameKey(e),
                            "submitted_role_count" to num(p.submittedRoleCount),
                        ),
                    )
                }

                // B5: 代理入力も入力済みの役割数を更新する。確定はしない（週と status は変えない）
                is SessionEvent.ProxyDecisionSubmitted -> {
                    listOf(
                        upsert(
                            ProjectionTable.SESSION_OVERVIEW,
                            gameKey(e),
                            "submitted_role_count" to num(p.submittedRoleCount),
                        ),
                    )
                }

                is SessionEvent.SessionPaused -> {
                    listOf(upsert(ProjectionTable.SESSION_OVERVIEW, gameKey(e), "status" to text("PAUSED")))
                }

                is SessionEvent.SessionResumed -> {
                    listOf(upsert(ProjectionTable.SESSION_OVERVIEW, gameKey(e), "status" to text("ACTIVE")))
                }

                is SessionEvent.WeekCommitted -> {
                    listOf(
                        upsert(
                            ProjectionTable.SESSION_OVERVIEW,
                            gameKey(e),
                            "week" to num(nextWeekOrSame(p.week)),
                            "submitted_role_count" to num(0),
                        ),
                    )
                }

                is SessionEvent.SessionEnded -> {
                    listOf(
                        upsert(
                            ProjectionTable.SESSION_OVERVIEW,
                            gameKey(e),
                            "status" to text("ENDED"),
                            "ended_at" to Value.At(e.occurredAt),
                        ),
                    )
                }

                else -> {
                    emptyList()
                }
            }
        }

    private fun stateRows(
        e: EventEnvelope<DomainEvent>,
        states: RoleMap<RoleState>,
        asOfWeek: Int,
    ): List<RowChange> =
        Role.entries.map { role ->
            val s = states[role]
            upsert(
                ProjectionTable.ROLE_CURRENT_STATES,
                roleKey(e, role),
                "inventory" to num(s.inventory.value),
                "backlog" to num(s.backlog.value),
                "order_pipeline" to jsonInts(s.orderPipeline.weeks.map { it.value }),
                "shipment_pipeline" to jsonInts(s.deliveryPipeline.weeks.map { it.value }),
                "cumulative_cost_minor" to big(s.cumulativeCost.minor),
                "arrivals" to num(s.arrivals.value),
                "orders" to num(s.orders.value),
                "as_of_week" to num(asOfWeek),
            )
        }

    /** `role_current_states`: 進行中の各役割の状態。`production_pipeline` は、キットでは配送の待ち行列と同じなので書かない。 */
    val roleCurrentStates =
        Projection { e ->
            when (val p = e.payload) {
                is SessionEvent.SessionStarted -> stateRows(e, p.initialStates, Week.FIRST.value)
                is SessionEvent.WeekCommitted -> stateRows(e, p.nextStates, nextWeekOrSame(p.week))
                else -> emptyList()
            }
        }

    /** 保存と代理入力に共通の、当週の入力（最後の入力者つき）。 */
    private class DecisionInput(
        val role: Role,
        val week: Week,
        val quantity: Quantity,
        val version: DecisionVersion,
        val editor: Editor,
    )

    private fun decisionRow(
        e: EventEnvelope<DomainEvent>,
        input: DecisionInput,
    ): RowChange {
        val (editorKind, editorId) =
            when (val editor = input.editor) {
                is Editor.ByParticipant -> "PARTICIPANT" to editor.id.value
                is Editor.ByFacilitator -> "FACILITATOR" to editor.gameId.value
            }
        return upsert(
            ProjectionTable.CURRENT_DECISIONS,
            roleKey(e, input.role),
            "week" to num(input.week.value),
            "quantity" to num(input.quantity.value),
            "decision_version" to big(input.version.value),
            "editor_kind" to text(editorKind),
            "editor_id" to Value.Id(editorId),
            "updated_at" to Value.At(e.occurredAt),
        )
    }

    /** `current_decisions`: 当週の入力。確定で行を消す。代理入力（B5）は、進行役を入力者として同じ行に書く。 */
    val currentDecisions =
        Projection { e ->
            when (val p = e.payload) {
                is SessionEvent.DecisionSaved -> {
                    listOf(decisionRow(e, DecisionInput(p.role, p.week, p.quantity, p.decisionVersion, p.editor)))
                }

                is SessionEvent.ProxyDecisionSubmitted -> {
                    listOf(decisionRow(e, DecisionInput(p.role, p.week, p.quantity, p.decisionVersion, p.editor)))
                }

                is SessionEvent.WeekCommitted -> {
                    Role.entries.map { RowChange.Delete(ProjectionTable.CURRENT_DECISIONS, RowKey(roleKey(e, it))) }
                }

                else -> {
                    emptyList()
                }
            }
        }

    /** `week_commits`: 確定の事実。主キー `(game_id, week)` が、一度だけ確定されることを守る。 */
    val weekCommits =
        Projection { e ->
            when (val p = e.payload) {
                is SessionEvent.WeekCommitted -> {
                    listOf(
                        upsert(
                            ProjectionTable.WEEK_COMMITS,
                            gameKey(e) + (col("week") to num(p.week.value)),
                            "commit_kind" to text(p.commitKind.name),
                            "contributors" to num(p.contributors),
                            "stream_version" to big(e.streamVersion.value),
                            "committed_at" to Value.At(e.occurredAt),
                        ),
                    )
                }

                else -> {
                    emptyList()
                }
            }
        }

    /** `week_role_results`: 役割別の週結果。 */
    val weekRoleResults =
        Projection { e ->
            when (val p = e.payload) {
                is SessionEvent.WeekCommitted -> {
                    Role.entries.map { role ->
                        val r = p.results[role]
                        upsert(
                            ProjectionTable.WEEK_ROLE_RESULTS,
                            roleKey(e, role) + (col("week") to num(p.week.value)),
                            "demand" to num(r.orders.value),
                            "shipped" to num(r.shipped.value),
                            "ordered" to num(r.ordered.value),
                            "ending_inventory" to num(r.endingInventory.value),
                            "ending_backlog" to num(r.endingBacklog.value),
                            "weekly_cost_minor" to big(r.weeklyCost.minor),
                            "cumulative_cost_minor" to big(r.cumulativeCost.minor),
                        )
                    }
                }

                else -> {
                    emptyList()
                }
            }
        }

    /** B1 が書く投影。宣言の順は、表の順序（[ProjectionTable]）と同じ。 */
    val all: List<Projection> =
        listOf(
            gameOverview,
            gameJoinCodes,
            gameSettings,
            lobbyParticipants,
            sessionOverview,
            roleCurrentStates,
            currentDecisions,
            weekCommits,
            weekRoleResults,
        )

    /** 1 件のイベントの行の変更を、固定の順序（表の順。同じ表では発行の順＝役割の順）で返す。 */
    fun project(event: EventEnvelope<DomainEvent>): List<RowChange> =
        all.flatMap { it.project(event) }.sortedBy { it.table.ordinal }
}
