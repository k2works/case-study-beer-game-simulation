package beergame.domain

import arrow.core.Either
import io.kotest.core.spec.style.FunSpec
import io.kotest.matchers.collections.shouldContain
import io.kotest.matchers.shouldBe
import io.kotest.property.Arb
import io.kotest.property.arbitrary.int
import io.kotest.property.arbitrary.list
import io.kotest.property.arbitrary.map
import io.kotest.property.checkAll

private const val ITERATIONS = 500
private const val SAVE_LIMIT = 9

/** 乱数で選ぶ 1 手。コマンドは、その時点の状態から組み立てる（有効な手と、古い週・版の手、権限のない手を含む）。 */
private sealed interface Step {
    data class Save(
        val role: Role,
        val quantity: Int,
        val stale: Boolean,
    ) : Step

    data class Proxy(
        val role: Role,
        val quantity: Int,
        val stale: Boolean,
    ) : Step

    data class Commit(
        val stale: Boolean,
    ) : Step

    data object Pause : Step

    data object Resume : Step

    /** 参加者が、停止・再開・代理入力のどれかを試みる（権限がなく、必ず拒否される）。 */
    data class ByParticipant(
        val which: Int,
    ) : Step
}

private val stepArb: Arb<Step> =
    Arb.list(Arb.int(0..99), 5..5).map { d ->
        val role = Role.entries[d[0] % Role.entries.size]
        val stale = d[2] < 15
        when (d[3]) {
            in 0..39 -> Step.Save(role, d[1] * 10, stale)
            in 40..54 -> Step.Proxy(role, d[1] * 10, stale)
            in 55..74 -> Step.Commit(stale)
            in 75..86 -> Step.Pause
            in 87..96 -> Step.Resume
            else -> Step.ByParticipant(d[4])
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

private fun commandFor(
    step: Step,
    data: SessionData,
): SessionCommand =
    when (step) {
        is Step.Save -> {
            val expected = if (step.stale) dv(0) else data.decisionVersions[step.role]
            SessionCommand.SaveDecision(
                participantActor(step.role.ordinal + 1),
                t0,
                step.role,
                data.week,
                q(step.quantity),
                expected,
            )
        }

        is Step.Proxy -> {
            val week = if (step.stale) w(1) else data.week
            SessionCommand.SubmitProxyDecision(facilitatorActor, t0, step.role, week, q(step.quantity))
        }

        is Step.Commit -> {
            SessionCommand.CommitWeek(
                facilitatorActor,
                t0,
                data.week,
                if (step.stale) RoleMap.all(dv(0)) else data.decisionVersions,
            )
        }

        is Step.Pause -> {
            pauseSession()
        }

        is Step.Resume -> {
            resumeSession()
        }

        is Step.ByParticipant -> {
            when (step.which % 3) {
                0 -> pauseSession(participantActor(1))
                1 -> resumeSession(participantActor(1))
                else -> submitProxy(Role.FACTORY, 5, actor = participantActor(1))
            }
        }
    }

private data class Outcome(
    val state: SessionState,
    val history: List<SessionEvent>,
    val accepted: Int,
    val rejected: List<SessionError>,
)

private fun runSteps(steps: List<Step>): Outcome {
    val started = sessionStarted(settings)
    val initial = Outcome(sessionOf(started), listOf(started), 0, emptyList())
    return steps.fold(initial) { acc, step ->
        val data = checkNotNull(acc.state.dataOrNull())
        when (val decided = decideSession(acc.state, commandFor(step, data))) {
            is Either.Left -> {
                acc.copy(rejected = acc.rejected + decided.value)
            }

            is Either.Right -> {
                val next = decided.value.fold(acc.state, ::evolveSession)
                // 受け付けたコマンドは、イベントの数だけ版を進める（evolve が不正な遷移として無視していない）
                next.version.value shouldBe acc.state.version.value + decided.value.size
                acc.copy(state = next, history = acc.history + decided.value, accepted = acc.accepted + 1)
            }
        }
    }
}

class SessionTransitionPropertySpec :
    FunSpec({
        context("[判断項目 12] decideSession が受け付けたコマンドの列は、evolveSession で InvalidTransition を 1 件も出さない") {
            test("任意の有効・無効なコマンド列を回しても、再生は不正な遷移を検知せず、状態は一致する") {
                checkAll(ITERATIONS, Arb.list(stepArb, 0..60)) { steps ->
                    val outcome = runSteps(steps)
                    val replayed = replaySession(outcome.history)
                    replayed.invalid shouldBe emptyList()
                    replayed.state shouldBe outcome.state
                }
            }
            test("同じ列を 2 回回すと、同じ結果になる（純粋）") {
                checkAll(ITERATIONS, Arb.list(stepArb, 0..30)) { steps ->
                    runSteps(steps) shouldBe runSteps(steps)
                }
            }
            test("どの時点でも、当週の保存回数（意思決定の版）は上限の 9 を超えない") {
                checkAll(ITERATIONS, Arb.list(stepArb, 0..60)) { steps ->
                    val versions =
                        runSteps(steps)
                            .state
                            .dataOrNull()
                            ?.decisionVersions
                            ?.values
                            .orEmpty()
                    versions.all { it.value <= SAVE_LIMIT } shouldBe true
                }
            }
        }

        context("手が実際に、停止中の拒否・上限の拒否・停止中の代理入力の受け付けを通る（性質テストが空振りでない確認）") {
            test("停止中の保存は Paused で拒否される") {
                val outcome = runSteps(listOf(Step.Pause, Step.Save(Role.RETAILER, 1, false)))
                outcome.accepted shouldBe 1
                outcome.rejected shouldContain SessionError.Paused
            }
            test("同じ役割の保存を 40 回しても、受け付けるのは 9 回で、残りは SaveLimitReached") {
                val outcome = runSteps((1..40).map { Step.Save(Role.RETAILER, it, false) })
                outcome.accepted shouldBe SAVE_LIMIT
                outcome.rejected shouldContain SessionError.SaveLimitReached
            }
            test("停止 → 代理入力 → 再開は、3 手とも受け付ける") {
                runSteps(listOf(Step.Pause, Step.Proxy(Role.FACTORY, 6, false), Step.Resume)).accepted shouldBe 3
            }
        }
    })
