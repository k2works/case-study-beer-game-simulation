package beergame.domain

import arrow.core.Either
import io.kotest.core.spec.style.FunSpec
import io.kotest.matchers.collections.shouldContain
import io.kotest.matchers.collections.shouldContainAll
import io.kotest.matchers.shouldBe
import io.kotest.property.Arb
import io.kotest.property.arbitrary.int
import io.kotest.property.arbitrary.list
import io.kotest.property.arbitrary.map
import io.kotest.property.checkAll

private const val ITERATIONS = 500
private const val MAX_QUANTITY = 1000

/** 共同担当（各役割に 2 人）の Session に対する乱数の 1 手。有効な手と、古い版・担当でない人・代理入力・確定・停止を含む。 */
private sealed interface Move {
    /** [holder] は 0 = 担当者、1 = 共同担当、2 = その役割の担当でない参加者。 */
    data class Save(
        val role: Role,
        val holder: Int,
        val quantity: Int,
        val stale: Boolean,
    ) : Move

    data class Proxy(
        val role: Role,
        val quantity: Int,
    ) : Move

    data class Commit(
        val stale: Boolean,
    ) : Move

    data object Pause : Move

    data object Resume : Move
}

private val moveArb: Arb<Move> =
    Arb.list(Arb.int(0..99), 6..6).map { d ->
        val role = Role.entries[d[0] % Role.entries.size]
        when (d[4]) {
            in 0..59 -> Move.Save(role, d[1] % 3, d[2] * MAX_QUANTITY / 100, d[3] < 25)
            in 60..71 -> Move.Proxy(role, d[2] * MAX_QUANTITY / 100)
            in 72..86 -> Move.Commit(d[3] < 25)
            in 87..93 -> Move.Pause
            else -> Move.Resume
        }
    }

private val settings = gameSettings(List(5) { 4 })

private fun SessionState.dataOrNull(): SessionData? =
    when (this) {
        is SessionState.Active -> data
        is SessionState.Paused -> data
        is SessionState.Ended -> data
        is SessionState.NotStarted -> null
    }

private fun holderActorOf(
    role: Role,
    holder: Int,
): Actor =
    when (holder) {
        0 -> participantActor(role.ordinal + 1)
        1 -> coHolderActor(role)
        else -> participantActor((role.ordinal + 1) % Role.entries.size + 1)
    }

private fun commandFor(
    move: Move,
    data: SessionData,
): SessionCommand =
    when (move) {
        is Move.Save -> {
            val current = data.decisionVersions[move.role]
            val expected = if (move.stale) current.next() else current
            SessionCommand.SaveDecision(
                holderActorOf(move.role, move.holder),
                t0,
                move.role,
                data.week,
                q(move.quantity),
                expected,
            )
        }

        is Move.Proxy -> {
            SessionCommand.SubmitProxyDecision(facilitatorActor, t0, move.role, data.week, q(move.quantity))
        }

        is Move.Commit -> {
            SessionCommand.CommitWeek(
                facilitatorActor,
                t0,
                data.week,
                if (move.stale) RoleMap.all(dv(10)) else data.decisionVersions,
            )
        }

        is Move.Pause -> {
            pauseSession()
        }

        is Move.Resume -> {
            resumeSession()
        }
    }

/** 進行中で、担当者（共同担当を含む）が、最新の版を指定し、当週の上限に達していない役割へする保存。必ず受理される。 */
private fun Move.mustBeAccepted(
    state: SessionState,
    data: SessionData,
): Boolean = this is Move.Save && !stale && holder < 2 && state is SessionState.Active && data.hasSaveCapacity(role)

/** 古い版を指定した保存。受理されない。 */
private fun Move.mustBeRejected(): Boolean = this is Move.Save && stale

/** [expected] は、受理された最後の書き込みだけから作る参照（週が確定したら空に戻る）。 */
private data class CoRun(
    val state: SessionState,
    val history: List<SessionEvent>,
    val expected: Map<Role, DecisionEntry>,
    val accepted: Int,
    val rejected: List<SessionError>,
)

private fun writeOf(event: SessionEvent): Pair<Role, DecisionEntry>? =
    when (event) {
        is SessionEvent.DecisionSaved -> {
            event.role to DecisionEntry(event.quantity, event.decisionVersion, event.editor)
        }

        is SessionEvent.ProxyDecisionSubmitted -> {
            event.role to DecisionEntry(event.quantity, event.decisionVersion, event.editor)
        }

        else -> {
            null
        }
    }

/** 受理された書き込み 1 件が、(1) 状態の最新値になり、(2) その役割の版だけを 1 増やし、(4) 上限を超えないことを検査する。 */
private fun checkWrite(
    before: SessionData,
    after: SessionData,
    role: Role,
    entry: DecisionEntry,
) {
    after.decisions[role] shouldBe entry
    after.decisionVersions[role] shouldBe before.decisionVersions[role].next()
    entry.version shouldBe after.decisionVersions[role]
    Role.entries.filter { it != role }.forEach { other ->
        after.decisionVersions[other] shouldBe before.decisionVersions[other]
        after.decisions[other] shouldBe before.decisions[other]
    }
    (after.decisionVersions[role].value <= SAVE_LIMIT_PER_ROLE_WEEK) shouldBe true
}

private fun runMoves(moves: List<Move>): CoRun {
    val started = sessionStarted(settings, coAssignedParticipants)
    val initial = CoRun(sessionOf(started), listOf(started), emptyMap(), 0, emptyList())
    return moves.fold(initial) { acc, move ->
        val before = checkNotNull(acc.state.dataOrNull())
        when (val decided = decideSession(acc.state, commandFor(move, before))) {
            is Either.Left -> {
                // (7) 進行中で、担当者（共同担当を含む）が、最新の版を指定し、上限に達していない保存は、拒否されない
                move.mustBeAccepted(acc.state, before) shouldBe false
                // (6) 競合の拒否は、受理された最後の書き込み（最新値と保存者）を返す
                val error = decided.value
                if (error is SessionError.DecisionConflict) {
                    error.latest shouldBe acc.expected[error.role]
                }
                acc.copy(rejected = acc.rejected + error)
            }

            is Either.Right -> {
                // (8) 古い版を指定した保存は、受理されない（更新を黙って上書きしない）
                move.mustBeRejected() shouldBe false
                val events = decided.value
                val next = events.fold(acc.state, ::evolveSession)
                next.version.value shouldBe acc.state.version.value + events.size
                val after = checkNotNull(next.dataOrNull())
                val writes = events.mapNotNull(::writeOf)
                writes.forEach { (role, entry) -> checkWrite(before, after, role, entry) }
                val committed = events.any { it is SessionEvent.WeekCommitted }
                acc.copy(
                    state = next,
                    history = acc.history + events,
                    expected = if (committed) emptyMap() else acc.expected + writes,
                    accepted = acc.accepted + 1,
                )
            }
        }
    }
}

/** 進行中で、上限に達していない役割へ、最新の版を指定した、担当者の保存は、必ず受理される（拒否の残りかすが無い）。 */
private fun acceptsFreshSave(run: CoRun) {
    val data = run.state.dataOrNull()
    if (run.state is SessionState.Active && data != null) {
        Role.entries.filter { data.hasSaveCapacity(it) }.forEach { role ->
            val command =
                SessionCommand.SaveDecision(
                    holderActorOf(role, 1),
                    t0,
                    role,
                    data.week,
                    q(1),
                    data.decisionVersions[role],
                )
            decideSession(run.state, command).isRight() shouldBe true
        }
    }
}

class CoInputPropertySpec :
    FunSpec({
        context("[US2.2/AC2.2.3] 共同担当の乱数の手の列（有効・古い版・担当でない人・代理入力・確定・停止）の性質") {
            test("(1) 更新を失わない: 状態の入力は、受理された最後の書き込み（値・版・保存者）と一致する") {
                checkAll(ITERATIONS, Arb.list(moveArb, 0..60)) { moves ->
                    val run = runMoves(moves)
                    val data = checkNotNull(run.state.dataOrNull())
                    data.decisions shouldBe run.expected
                }
            }
            test("(2) 版は受理のたびに、その役割だけが 1 増える（連続）。(4) 保存回数（版）は 9 を超えない") {
                checkAll(ITERATIONS, Arb.list(moveArb, 0..60)) { moves ->
                    // 検査は runMoves の中（checkWrite）。最後の状態でも上限を確かめる
                    val data = checkNotNull(runMoves(moves).state.dataOrNull())
                    data.decisionVersions.values.all { it.value <= SAVE_LIMIT_PER_ROLE_WEEK } shouldBe true
                }
            }
            test("(3) 拒否は状態を変えない: 拒否の後も、上限に達していない役割へ、最新の版の保存が受理される") {
                checkAll(ITERATIONS, Arb.list(moveArb, 0..60)) { moves -> acceptsFreshSave(runMoves(moves)) }
            }
            test("(5) 再生が InvalidTransition を出さず、再生した状態が一致する") {
                checkAll(ITERATIONS, Arb.list(moveArb, 0..60)) { moves ->
                    val run = runMoves(moves)
                    val replayed = replaySession(run.history)
                    replayed.invalid shouldBe emptyList()
                    replayed.state shouldBe run.state
                }
            }
            test("同じ列を 2 回回すと、同じ結果になる（純粋）") {
                checkAll(ITERATIONS, Arb.list(moveArb, 0..30)) { moves -> runMoves(moves) shouldBe runMoves(moves) }
            }
        }

        context("性質テストが空振りでない確認（手が、受理・競合・上限・権限・停止の各経路を実際に通る）") {
            test("担当者と共同担当の交互の保存は、同じ版を指定すれば受理され、古い版なら競合する") {
                val run =
                    runMoves(
                        listOf(
                            Move.Save(Role.RETAILER, 0, 5, false),
                            Move.Save(Role.RETAILER, 1, 7, false),
                            Move.Save(Role.RETAILER, 0, 9, true),
                        ),
                    )
                run.accepted shouldBe 2
                run.rejected.map { it::class } shouldBe listOf(SessionError.DecisionConflict::class)
                run.expected[Role.RETAILER]?.quantity shouldBe q(7)
            }
            test("同じ役割へ共同担当が交互に 40 回保存しても、受理は 9 回で、残りは SaveLimitReached") {
                val run = runMoves((1..40).map { Move.Save(Role.RETAILER, it % 2, it, false) })
                run.accepted shouldBe SAVE_LIMIT_PER_ROLE_WEEK
                run.rejected shouldContain SessionError.SaveLimitReached
            }
            test("担当でない人の保存は Forbidden、停止中の保存は Paused、確定は週をまたいで受理される") {
                val outsider = Move.Save(Role.RETAILER, 2, 1, false)
                val holder = Move.Save(Role.RETAILER, 0, 1, false)
                val run = runMoves(listOf(outsider, Move.Pause, holder))
                run.rejected shouldContainAll
                    listOf(SessionError.Forbidden("その役割の参加者だけが入力できる"), SessionError.Paused)
                val everyRoleSaved = Role.entries.map { Move.Save(it, 1, 4, false) }
                val committed = runMoves(everyRoleSaved + Move.Commit(false) + Move.Save(Role.RETAILER, 0, 3, false))
                committed.history.filterIsInstance<SessionEvent.WeekCommitted>().size shouldBe 1
                committed.expected.keys shouldBe setOf(Role.RETAILER)
            }
        }
    })
