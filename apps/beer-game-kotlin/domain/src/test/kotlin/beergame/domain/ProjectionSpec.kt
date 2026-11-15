package beergame.domain

import io.kotest.core.spec.style.FunSpec
import io.kotest.matchers.collections.shouldBeSortedWith
import io.kotest.matchers.collections.shouldContainExactly
import io.kotest.matchers.shouldBe
import java.time.Instant
import java.util.UUID

private fun <E : DomainEvent> envelope(
    payload: E,
    stream: StreamType,
    version: Long,
    at: Instant = t0,
): EventEnvelope<DomainEvent> =
    EventEnvelope(
        UUID(0L, version),
        gid,
        stream,
        sv(version),
        1,
        ActorRef(ActorKind.ANONYMOUS, null),
        UUID(1L, version),
        UUID(2L, version),
        at,
        payload,
    )

private fun RowChange.valueOf(name: String): Value? = (this as? RowChange.Upsert)?.values?.get(Column(name))

private fun RowChange.keyOf(name: String): Value? = key.parts[Column(name)]

private fun List<RowChange>.of(table: ProjectionTable): List<RowChange> = filter { it.table == table }

private val settings = gameSettings(listOf(4, 5, 6))
private val outcome = simulateWeek(settings.simulation(), w(1), KitPreset.initialStates(settings.demand), same(4))
private val weekCommitted =
    SessionEvent.WeekCommitted(w(1), CommitKind.MANUAL, same(4), outcome.results, outcome.nextStates, 4)

class ProjectionSpec :
    FunSpec({
        test(
            "[7.2] Given GameCreated When 投影する Then 3 つの表の行になる（参加コードは overview に無い）",
        ) {
            val rows = Projections.project(envelope(gameCreated(settings), StreamType.GAME, 1))

            rows.map { it.table } shouldContainExactly
                listOf(ProjectionTable.GAME_OVERVIEW, ProjectionTable.GAME_JOIN_CODES, ProjectionTable.GAME_SETTINGS)
            val overview = rows.of(ProjectionTable.GAME_OVERVIEW).single()
            overview.keyOf("game_id") shouldBe Value.Id(gid.value)
            overview.valueOf("status") shouldBe Value.Text("PREPARING")
            overview.valueOf("final_week") shouldBe Value.Num(3)
            overview.valueOf("settings_kind") shouldBe Value.Text("KIT")
            overview.valueOf("retention_days") shouldBe Value.Num(90)
            overview.valueOf("join_code") shouldBe null
            rows.of(ProjectionTable.GAME_JOIN_CODES).single().valueOf("join_code") shouldBe Value.Text("K7M2Q9XW")
            val gs = rows.of(ProjectionTable.GAME_SETTINGS).single()
            gs.valueOf("demand") shouldBe Value.Json("[4,5,6]")
            gs.valueOf("holding_cost_minor") shouldBe Value.Big(50)
            gs.valueOf("backlog_cost_minor") shouldBe Value.Big(100)
        }

        test("[7.2] Given 参加・割り当て・付け替えの解除 When 投影する Then lobby_participants の role が入り、解除で NULL に戻る") {
            val joined =
                Projections.project(
                    envelope(GameEvent.ParticipantJoined(pid(1), credentialExpiry), StreamType.GAME, 2),
                )
            val assigned =
                Projections.project(
                    envelope(GameEvent.RoleAssigned(pid(1), Role.RETAILER), StreamType.GAME, 3),
                )
            val unassigned =
                Projections.project(
                    envelope(GameEvent.RoleUnassigned(pid(1), Role.RETAILER), StreamType.GAME, 4),
                )

            joined.single().valueOf("role") shouldBe Value.Null
            joined.single().valueOf("game_id") shouldBe Value.Id(gid.value)
            joined.single().keyOf("participant_id") shouldBe Value.Id(pid(1).value)
            assigned.single().valueOf("role") shouldBe Value.Text("RETAILER")
            unassigned.single().valueOf("role") shouldBe Value.Null
        }

        test("[7.2] Given GameStarted と SessionEnded When 投影する Then game_overview の状態だけを部分的に更新する") {
            val started = Projections.project(envelope(GameEvent.GameStarted(gid), StreamType.GAME, 9, t0)).single()
            val ended =
                Projections.project(
                    envelope(SessionEvent.SessionEnded(EndReason.FINAL_WEEK), StreamType.SESSION, 9, t0),
                )

            started.valueOf("status") shouldBe Value.Text("STARTED")
            started.valueOf("started_at") shouldBe Value.At(t0)
            started.valueOf("final_week") shouldBe null
            ended.of(ProjectionTable.GAME_OVERVIEW).single().valueOf("status") shouldBe Value.Text("ENDED")
            ended.of(ProjectionTable.SESSION_OVERVIEW).single().valueOf("status") shouldBe Value.Text("ENDED")
        }

        test("[7.2] Given SessionStarted When 投影する Then session_overview は ACTIVE の第 1 週で、4 役割の状態が as_of_week 1 で入る") {
            val started =
                SessionEvent.SessionStarted(
                    gid,
                    settings,
                    RoleMap.of {
                        setOf(pid(it.ordinal + 1))
                    },
                    KitPreset.initialStates(settings.demand),
                    CommitMode.MANUAL,
                )

            val rows = Projections.project(envelope(started, StreamType.SESSION, 1))

            val overview = rows.of(ProjectionTable.SESSION_OVERVIEW).single()
            overview.valueOf("status") shouldBe Value.Text("ACTIVE")
            overview.valueOf("week") shouldBe Value.Num(1)
            overview.valueOf("submitted_role_count") shouldBe Value.Num(0)
            val states = rows.of(ProjectionTable.ROLE_CURRENT_STATES)
            states.map { it.keyOf("role") } shouldContainExactly Role.entries.map { Value.Text(it.name) }
            val retailer = states.last()
            retailer.valueOf("inventory") shouldBe Value.Num(12)
            retailer.valueOf("orders") shouldBe Value.Num(4)
            retailer.valueOf("order_pipeline") shouldBe Value.Json("[4]")
            retailer.valueOf("shipment_pipeline") shouldBe Value.Json("[4]")
            retailer.valueOf("as_of_week") shouldBe Value.Num(1)
            states.first().valueOf("order_pipeline") shouldBe Value.Json("[]")
        }

        test("[7.2] Given DecisionSaved When 投影する Then current_decisions に最後の保存者つきで入り、入力済みの役割数が session_overview に入る") {
            val saved = SessionEvent.DecisionSaved(w(1), Role.WHOLESALER, q(7), dv(2), Editor.ByParticipant(pid(3)), 2)

            val rows = Projections.project(envelope(saved, StreamType.SESSION, 5))

            val decision = rows.of(ProjectionTable.CURRENT_DECISIONS).single()
            decision.keyOf("role") shouldBe Value.Text("WHOLESALER")
            decision.valueOf("quantity") shouldBe Value.Num(7)
            decision.valueOf("decision_version") shouldBe Value.Big(2)
            decision.valueOf("editor_kind") shouldBe Value.Text("PARTICIPANT")
            decision.valueOf("editor_id") shouldBe Value.Id(pid(3).value)
            rows.of(ProjectionTable.SESSION_OVERVIEW).single().valueOf("submitted_role_count") shouldBe Value.Num(2)
        }

        test("[B5/4.7] Given 停止・再開（SessionPaused・SessionResumed） When 投影する Then status だけを PAUSED・ACTIVE に更新する") {
            val paused = Projections.project(envelope(SessionEvent.SessionPaused, StreamType.SESSION, 6))
            val resumed = Projections.project(envelope(SessionEvent.SessionResumed, StreamType.SESSION, 7))

            paused.map { it.table } shouldContainExactly listOf(ProjectionTable.SESSION_OVERVIEW)
            paused.single().valueOf("status") shouldBe Value.Text("PAUSED")
            paused.single().keyOf("game_id") shouldBe Value.Id(gid.value)
            (paused.single() as RowChange.Upsert).values.keys shouldBe setOf(Column("status"))
            resumed.map { it.table } shouldContainExactly listOf(ProjectionTable.SESSION_OVERVIEW)
            resumed.single().valueOf("status") shouldBe Value.Text("ACTIVE")
            (resumed.single() as RowChange.Upsert).values.keys shouldBe setOf(Column("status"))
        }

        test(
            "[B5/4.7] Given ProxyDecisionSubmitted When 投影する Then current_decisions に進行役の入力者つきで入り、入力済みの役割数も更新する",
        ) {
            val proxy = SessionEvent.ProxyDecisionSubmitted(w(1), Role.FACTORY, q(6), dv(2), facilitatorEditor, 3)

            val rows = Projections.project(envelope(proxy, StreamType.SESSION, 8))

            val decision = rows.of(ProjectionTable.CURRENT_DECISIONS).single()
            decision.keyOf("role") shouldBe Value.Text("FACTORY")
            decision.valueOf("week") shouldBe Value.Num(1)
            decision.valueOf("quantity") shouldBe Value.Num(6)
            decision.valueOf("decision_version") shouldBe Value.Big(2)
            decision.valueOf("editor_kind") shouldBe Value.Text("FACILITATOR")
            decision.valueOf("editor_id") shouldBe Value.Id(gid.value)
            val overview = rows.of(ProjectionTable.SESSION_OVERVIEW).single()
            overview.valueOf("submitted_role_count") shouldBe Value.Num(3)
            overview.valueOf("status") shouldBe null
            rows.map { it.table }.toSet() shouldBe
                setOf(ProjectionTable.CURRENT_DECISIONS, ProjectionTable.SESSION_OVERVIEW)
        }

        test(
            "[B5/4.7][L5] Given 資格のイベント（失効・再発行・復帰） When 投影する Then どの表の行も作らない（正本は credentials）",
        ) {
            val subject = CredentialSubject.Participant(pid(1))
            val events =
                listOf<DomainEvent>(
                    GameEvent.CredentialRevoked(subject),
                    GameEvent.CredentialReissued(subject, credentialExpiry),
                    GameEvent.ParticipationRecovered(subject, credentialExpiry),
                )

            events.forEachIndexed { i, event ->
                Projections.project(envelope(event, StreamType.GAME, 20L + i)) shouldBe emptyList()
            }
        }

        test(
            "[B5/4.7] Given ParticipantReplaced When 投影する Then 旧担当者の行は、role を NULL にして replaced_at を入れる（行は消さない）",
        ) {
            val replaced = GameEvent.ParticipantReplaced(pid(1), Role.RETAILER, pid(2))

            val rows = Projections.project(envelope(replaced, StreamType.GAME, 30, t0))

            val row = rows.single()
            row.table shouldBe ProjectionTable.LOBBY_PARTICIPANTS
            row.keyOf("participant_id") shouldBe Value.Id(pid(1).value)
            row.valueOf("role") shouldBe Value.Null
            row.valueOf("replaced_at") shouldBe Value.At(t0)
            (row as RowChange.Upsert).values.keys shouldBe setOf(Column("role"), Column("replaced_at"))
        }

        test(
            "[B5/4.7] Given 入れ替えの追記（旧 2 人の ParticipantReplaced・CredentialRevoked、新担当者の RoleAssigned、" +
                "session の RoleHolderReplaced） When 投影する Then ロビーは旧担当者に replaced_at・新担当者に role を書き、" +
                "session 側の投影は何も書かない",
        ) {
            val gameEvents =
                listOf(
                    GameEvent.ParticipantReplaced(pid(1), Role.RETAILER, pid(3)),
                    GameEvent.CredentialRevoked(CredentialSubject.Participant(pid(1))),
                    GameEvent.ParticipantReplaced(pid(2), Role.RETAILER, pid(3)),
                    GameEvent.CredentialRevoked(CredentialSubject.Participant(pid(2))),
                    GameEvent.RoleAssigned(pid(3), Role.RETAILER),
                ).mapIndexed { i, event -> envelope(event, StreamType.GAME, 40L + i) }
            val sessionEvent =
                envelope(
                    SessionEvent.RoleHolderReplaced(Role.RETAILER, setOf(pid(1), pid(2)), pid(3)),
                    StreamType.SESSION,
                    41,
                )

            val lobby = Projections.lobbyParticipants.replay(gameEvents)

            lobby.map { it.keyOf("participant_id") } shouldContainExactly
                listOf(Value.Id(pid(1).value), Value.Id(pid(2).value), Value.Id(pid(3).value))
            lobby.map { it.valueOf("role") } shouldContainExactly
                listOf(Value.Null, Value.Null, Value.Text("RETAILER"))
            lobby.map { it.valueOf("replaced_at") } shouldContainExactly
                listOf(Value.At(t0), Value.At(t0), null)
            // 入れ替えの割り当て（RoleAssigned）は、新担当者の replaced_at を変えない（列を書かない）。
            // session 側の割り当ての写しは、イベントの再生が持つ状態で、読み取りモデルの表を持たない
            Projections.project(sessionEvent) shouldBe emptyList()
            gameEvents.flatMap { Projections.project(it) }.map { it.table }.toSet() shouldBe
                setOf(ProjectionTable.LOBBY_PARTICIPANTS)
        }

        test("[B5] 入力者が進行役のとき、current_decisions の入力者の種別は FACILITATOR（ID はゲーム）") {
            val saved = SessionEvent.DecisionSaved(w(1), Role.FACTORY, q(6), dv(1), facilitatorEditor, 1)

            val decision =
                Projections
                    .project(
                        envelope(saved, StreamType.SESSION, 5),
                    ).of(ProjectionTable.CURRENT_DECISIONS)
                    .single()

            decision.valueOf("editor_kind") shouldBe Value.Text("FACILITATOR")
            decision.valueOf("editor_id") shouldBe Value.Id(gid.value)
        }

        test("[7.2] Given WeekCommitted When 投影する Then 確定の事実・役割別の結果・次週の状態が入り、入力はクリアされ、チーム合計は書かない（#12）") {
            val rows = Projections.project(envelope(weekCommitted, StreamType.SESSION, 12))

            val commit = rows.of(ProjectionTable.WEEK_COMMITS).single()
            commit.keyOf("week") shouldBe Value.Num(1)
            commit.valueOf("commit_kind") shouldBe Value.Text("MANUAL")
            commit.valueOf("contributors") shouldBe Value.Num(4)
            commit.valueOf("stream_version") shouldBe Value.Big(12)
            val results = rows.of(ProjectionTable.WEEK_ROLE_RESULTS)
            results.map { it.keyOf("role") } shouldContainExactly Role.entries.map { Value.Text(it.name) }
            results.last().valueOf("ordered") shouldBe Value.Num(4)
            results.last().valueOf("demand") shouldBe Value.Num(outcome.results.retailer.orders.value)
            results.last().valueOf("cumulative_cost_minor") shouldBe
                Value.Big(outcome.results.retailer.cumulativeCost.minor)
            rows.of(ProjectionTable.ROLE_CURRENT_STATES).map { it.valueOf("as_of_week") }.toSet() shouldBe
                setOf(Value.Num(2))
            rows.of(ProjectionTable.CURRENT_DECISIONS).all { it is RowChange.Delete } shouldBe true
            rows.of(ProjectionTable.CURRENT_DECISIONS).size shouldBe 4
            val overview = rows.of(ProjectionTable.SESSION_OVERVIEW).single()
            overview.valueOf("week") shouldBe Value.Num(2)
            overview.valueOf("submitted_role_count") shouldBe Value.Num(0)
            ProjectionTable.entries.map { it.sqlName }.contains("week_team_totals") shouldBe false
        }

        test("[7.2] Given 1 件のイベントの変更 When 並べる Then 表の固定の順序（L3）で、同じ表では役割の順") {
            val rows = Projections.project(envelope(weekCommitted, StreamType.SESSION, 12))

            rows.map { it.table.ordinal } shouldBeSortedWith compareBy { it }
        }

        test("[7.2] Given 同じイベント列 When 2 回投影する Then 同じ変更（純粋で、他の投影を読まない）") {
            val events =
                listOf(
                    envelope(gameCreated(settings), StreamType.GAME, 1),
                    envelope(weekCommitted, StreamType.SESSION, 12),
                )

            Projections.all.map { it.replay(events) } shouldBe Projections.all.map { it.replay(events) }
        }

        context("[7.2] 個々の投影は、自分の表の行だけを作る（all の順序と表の順序が対応する）") {
            val saved = SessionEvent.DecisionSaved(w(1), Role.WHOLESALER, q(7), dv(2), Editor.ByParticipant(pid(3)), 2)
            val events =
                listOf(
                    envelope(gameCreated(settings), StreamType.GAME, 1),
                    envelope(GameEvent.ParticipantJoined(pid(1), credentialExpiry), StreamType.GAME, 2),
                    envelope(saved, StreamType.SESSION, 5),
                    envelope(weekCommitted, StreamType.SESSION, 12),
                )
            val expected =
                listOf(
                    Projections.gameOverview to ProjectionTable.GAME_OVERVIEW,
                    Projections.gameJoinCodes to ProjectionTable.GAME_JOIN_CODES,
                    Projections.gameSettings to ProjectionTable.GAME_SETTINGS,
                    Projections.lobbyParticipants to ProjectionTable.LOBBY_PARTICIPANTS,
                    Projections.sessionOverview to ProjectionTable.SESSION_OVERVIEW,
                    Projections.roleCurrentStates to ProjectionTable.ROLE_CURRENT_STATES,
                    Projections.currentDecisions to ProjectionTable.CURRENT_DECISIONS,
                    Projections.weekCommits to ProjectionTable.WEEK_COMMITS,
                    Projections.weekRoleResults to ProjectionTable.WEEK_ROLE_RESULTS,
                )
            expected.forEach { (projection, table) ->
                test("${table.sqlName} の投影は、その表の行だけを 1 行以上作る") {
                    val rows = projection.replay(events)

                    rows.isNotEmpty() shouldBe true
                    rows.map { it.table }.toSet() shouldBe setOf(table)
                }
            }
            test("all は、個々の投影を表の順序で並べたもの") {
                Projections.all shouldBe expected.map { it.first }
                expected.map { it.second } shouldBe ProjectionTable.entries
            }
        }
    })
