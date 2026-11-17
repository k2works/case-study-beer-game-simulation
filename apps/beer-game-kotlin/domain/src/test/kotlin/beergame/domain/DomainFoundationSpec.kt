package beergame.domain

import io.kotest.core.spec.style.FunSpec
import io.kotest.matchers.collections.shouldContainExactly
import io.kotest.matchers.shouldBe
import java.util.UUID

class DomainFoundationSpec :
    FunSpec({
        context("Actor は、境界で認証した結果を、種別と ID だけの参照へ変える（表示名を含めない）") {
            test("進行役はゲームの ID、参加者は参加者の ID、匿名は ID なし") {
                facilitatorActor.toRef() shouldBe ActorRef(ActorKind.FACILITATOR, gid.value)
                participantActor(3).toRef() shouldBe ActorRef(ActorKind.PARTICIPANT, pid(3).value)
                anonymousActor.toRef() shouldBe ActorRef(ActorKind.ANONYMOUS, null)
            }
            test("進行役は、自分のゲームの進行役だけである") {
                facilitatorActor.isFacilitatorOf(gid) shouldBe true
                facilitatorActor.isFacilitatorOf(GameId(UUID(1L, 1L))) shouldBe false
                participantActor(1).isFacilitatorOf(gid) shouldBe false
                anonymousActor.isFacilitatorOf(gid) shouldBe false
            }
        }

        context("DomainError は、安定した code（<領域>.<名前>）と category を持つ（code は設計書に一覧が無く、仮置き）") {
            val expected: List<Triple<DomainError, String, ErrorCategory>> =
                listOf(
                    Triple(GameError.AlreadyCreated, "game.already_created", ErrorCategory.InvalidState),
                    Triple(GameError.InvitationInvalid, "game.invitation_invalid", ErrorCategory.Forbidden),
                    Triple(GameError.NotPreparing, "game.not_preparing", ErrorCategory.InvalidState),
                    Triple(GameError.NotEnded, "game.not_ended", ErrorCategory.InvalidState),
                    Triple(GameError.Forbidden("x"), "game.forbidden", ErrorCategory.Forbidden),
                    Triple(GameError.ParticipantNotFound(pid(1)), "game.participant_not_found", ErrorCategory.NotFound),
                    Triple(
                        GameError.StartConditionNotMet(listOf(Role.FACTORY)),
                        "game.start_condition_not_met",
                        ErrorCategory.RuleViolation,
                    ),
                    Triple(SessionError.NotActive, "session.not_active", ErrorCategory.InvalidState),
                    Triple(SessionError.AlreadyEnded, "session.already_ended", ErrorCategory.InvalidState),
                    Triple(SessionError.AlreadyStarted, "session.already_started", ErrorCategory.InvalidState),
                    Triple(SessionError.Forbidden("x"), "session.forbidden", ErrorCategory.Forbidden),
                    Triple(SessionError.WeekAdvanced(w(2), w(1)), "session.week_advanced", ErrorCategory.Conflict),
                    Triple(
                        SessionError.DecisionConflict(Role.FACTORY, null),
                        "session.decision_conflict",
                        ErrorCategory.Conflict,
                    ),
                    Triple(
                        SessionError.DecisionsChanged(w(1), emptyMap()),
                        "session.decisions_changed",
                        ErrorCategory.Conflict,
                    ),
                    Triple(
                        SessionError.IncompleteDecisions(listOf(Role.FACTORY)),
                        "session.incomplete_decisions",
                        ErrorCategory.RuleViolation,
                    ),
                )
            expected.forEach { (error, code, category) ->
                test("$code は $category") {
                    error.code shouldBe code
                    error.category shouldBe category
                }
            }
            test("code はすべて異なり、小文字のドット区切りの 1 つの書式である") {
                val codes = expected.map { it.second }
                codes.distinct() shouldContainExactly codes
                codes.all { Regex("^[a-z]+\\.[a-z_]+$").matches(it) } shouldBe true
            }
        }

        context("EventEnvelope は、ペイロードに、永続化と追跡に必要な項目を付ける") {
            test("ストリームの版・操作者の参照・相関 ID・コマンド ID・発生時刻を持ち、ペイロードを変えない") {
                val envelope =
                    EventEnvelope(
                        eventId = UUID(0L, 100L),
                        gameId = gid,
                        streamType = StreamType.GAME,
                        streamVersion = sv(1),
                        schemaVersion = 1,
                        actor = anonymousActor.toRef(),
                        correlationId = UUID(0L, 200L),
                        commandId = UUID(0L, 300L),
                        occurredAt = t0,
                        payload = gameCreated(),
                    )
                envelope.payload shouldBe gameCreated()
                envelope.streamVersion shouldBe sv(1)
                envelope.occurredAt shouldBe t0
                envelope.actor shouldBe ActorRef(ActorKind.ANONYMOUS, null)
            }
        }
    })
