package beergame.persistence

import arrow.core.Either
import arrow.core.getOrElse
import beergame.domain.CommitKind
import beergame.domain.CommitMode
import beergame.domain.CredentialSubject
import beergame.domain.DecisionVersion
import beergame.domain.DomainEvent
import beergame.domain.Editor
import beergame.domain.EndReason
import beergame.domain.GameEvent
import beergame.domain.GameId
import beergame.domain.GameSettings
import beergame.domain.InvitationId
import beergame.domain.JoinCode
import beergame.domain.KitPreset
import beergame.domain.ObserverId
import beergame.domain.ParticipantId
import beergame.domain.Quantity
import beergame.domain.RetentionDays
import beergame.domain.Role
import beergame.domain.RoleMap
import beergame.domain.SessionEvent
import beergame.domain.Week
import beergame.domain.simulateWeek
import io.kotest.assertions.fail
import io.kotest.core.spec.style.FunSpec
import io.kotest.matchers.collections.shouldContainExactlyInAnyOrder
import io.kotest.matchers.shouldBe
import io.kotest.matchers.string.shouldNotContain
import java.time.Instant
import java.util.UUID

private fun <A> Either<*, A>.get(): A = getOrElse { fail("不正な値: $it") }

private val GAME = GameId(UUID.fromString("00000000-0000-0000-0000-00000000abcd"))
private val P1 = ParticipantId(UUID.fromString("00000000-0000-0000-0000-000000000001"))
private val P2 = ParticipantId(UUID.fromString("00000000-0000-0000-0000-000000000002"))
private val P3 = ParticipantId(UUID.fromString("00000000-0000-0000-0000-000000000003"))
private val P4 = ParticipantId(UUID.fromString("00000000-0000-0000-0000-000000000004"))
private val OBSERVER = ObserverId(UUID.fromString("00000000-0000-0000-0000-0000000000f1"))
private val INVITATION = InvitationId(UUID.fromString("00000000-0000-0000-0000-0000000000e1"))
private val EXPIRES = Instant.parse("2026-12-01T09:00:00Z")
private val SETTINGS = GameSettings.kit(3, listOf(4, 5, 6)).get()
private val FOUR = Quantity.of(4).get()
private val STATES = KitPreset.initialStates(SETTINGS.demand)
private val OUTCOME = simulateWeek(SETTINGS.simulation(), Week.FIRST, STATES, RoleMap.all(FOUR))
private val COMMITTED =
    SessionEvent.WeekCommitted(Week.FIRST, CommitKind.MANUAL, RoleMap.all(FOUR), OUTCOME.results, OUTCOME.nextStates, 4)
private val FACILITATOR_EDITOR = Editor.ByFacilitator(GAME)
private val VERSION_1 = DecisionVersion.ZERO.next()
private val ASSIGNMENTS = RoleMap.of { setOf(ParticipantId(UUID(0L, it.ordinal + 1L))) }
private val FACILITATOR_SUBJECT = CredentialSubject.Facilitator(GAME)
private val PARTICIPANT_SUBJECT = CredentialSubject.Participant(P1)

private const val SETTINGS_JSON =
    """{"finalWeek":3,"demand":[4,5,6],"holdingCostMinor":50,"backlogCostMinor":100,"commitMode":"MANUAL"}"""
private const val FACILITATOR_SUBJECT_JSON = """{"kind":"FACILITATOR","id":"00000000-0000-0000-0000-00000000abcd"}"""
private const val PARTICIPANT_SUBJECT_JSON = """{"kind":"PARTICIPANT","id":"00000000-0000-0000-0000-000000000001"}"""
private const val FACILITATOR_EDITOR_JSON = """{"kind":"FACILITATOR","id":"00000000-0000-0000-0000-00000000abcd"}"""
private const val PARTICIPANT_EDITOR_JSON = """{"kind":"PARTICIPANT","id":"00000000-0000-0000-0000-000000000004"}"""

private fun stateJson(
    orderPipeline: String,
    cost: Int,
    orders: Int,
): String =
    """{"inventory":12,"backlog":0,"orderPipeline":$orderPipeline,"deliveryPipeline":[4],""" +
        """"cumulativeCostMinor":$cost,"arrivals":4,"orders":$orders}"""

private val FACTORY_STATE_JSON = stateJson("[]", 0, 4)
private val OTHER_STATE_JSON = stateJson("[4]", 0, 4)
private val FACTORY_NEXT_JSON = stateJson("[]", 600, 4)
private val OTHER_NEXT_JSON = stateJson("[4]", 600, 4)
private val RETAILER_NEXT_JSON = stateJson("[4]", 600, 5)
private const val DECISIONS_JSON = """{"factory":4,"distributor":4,"wholesaler":4,"retailer":4}"""
private const val RESULT_JSON =
    """{"orders":4,"shipped":4,"ordered":4,"endingInventory":12,"endingBacklog":0,""" +
        """"weeklyCostMinor":600,"cumulativeCostMinor":600}"""

internal val GOLDEN: List<Triple<String, DomainEvent, String>> =
    listOf(
        Triple(
            "GameCreated",
            GameEvent.GameCreated(GAME, JoinCode.of("K7M2Q9XW").get(), SETTINGS, RetentionDays.of(90).get(), EXPIRES),
            """{"gameId":"${GAME.value}","joinCode":"K7M2Q9XW","settings":$SETTINGS_JSON,"retentionDays":90,""" +
                """"facilitatorCredentialExpiresAt":"2026-12-01T09:00:00Z"}""",
        ),
        Triple(
            "ParticipantJoined",
            GameEvent.ParticipantJoined(P1, EXPIRES),
            """{"participantId":"${P1.value}","credentialExpiresAt":"2026-12-01T09:00:00Z"}""",
        ),
        Triple(
            "RoleAssigned",
            GameEvent.RoleAssigned(P1, Role.RETAILER),
            """{"participantId":"${P1.value}","role":"RETAILER"}""",
        ),
        Triple(
            "RoleUnassigned",
            GameEvent.RoleUnassigned(P1, Role.RETAILER),
            """{"participantId":"${P1.value}","role":"RETAILER"}""",
        ),
        Triple("GameStarted", GameEvent.GameStarted(GAME), """{"gameId":"${GAME.value}"}"""),
        Triple(
            "CredentialRevoked",
            GameEvent.CredentialRevoked(PARTICIPANT_SUBJECT),
            """{"subject":$PARTICIPANT_SUBJECT_JSON}""",
        ),
        Triple(
            "CredentialReissued",
            GameEvent.CredentialReissued(PARTICIPANT_SUBJECT, EXPIRES),
            """{"subject":$PARTICIPANT_SUBJECT_JSON,"expiresAt":"2026-12-01T09:00:00Z"}""",
        ),
        Triple(
            "ParticipationRecovered",
            GameEvent.ParticipationRecovered(FACILITATOR_SUBJECT, EXPIRES),
            """{"subject":$FACILITATOR_SUBJECT_JSON,"credentialExpiresAt":"2026-12-01T09:00:00Z"}""",
        ),
        Triple(
            "ParticipantReplaced",
            GameEvent.ParticipantReplaced(P1, Role.RETAILER, P2),
            """{"participantId":"${P1.value}","role":"RETAILER","replacedBy":"${P2.value}"}""",
        ),
        Triple(
            "ObserverInvited",
            GameEvent.ObserverInvited(INVITATION, EXPIRES),
            """{"invitationId":"${INVITATION.value}","expiresAt":"2026-12-01T09:00:00Z"}""",
        ),
        Triple(
            "ObserverInvitationRevoked",
            GameEvent.ObserverInvitationRevoked(INVITATION),
            """{"invitationId":"${INVITATION.value}"}""",
        ),
        Triple(
            "ObserverJoined",
            GameEvent.ObserverJoined(OBSERVER, INVITATION, EXPIRES),
            """{"observerId":"${OBSERVER.value}","invitationId":"${INVITATION.value}",""" +
                """"credentialExpiresAt":"2026-12-01T09:00:00Z"}""",
        ),
        Triple(
            "SessionStarted",
            SessionEvent.SessionStarted(GAME, SETTINGS, ASSIGNMENTS, STATES, CommitMode.MANUAL),
            """{"gameId":"${GAME.value}","settings":$SETTINGS_JSON,"assignments":{"factory":["${P1.value}"],""" +
                """"distributor":["${P2.value}"],"wholesaler":["${P3.value}"],"retailer":["${P4.value}"]},""" +
                """"initialStates":{"factory":$FACTORY_STATE_JSON,"distributor":$OTHER_STATE_JSON,""" +
                """"wholesaler":$OTHER_STATE_JSON,"retailer":$OTHER_STATE_JSON},"commitMode":"MANUAL"}""",
        ),
        Triple(
            "DecisionSaved",
            SessionEvent.DecisionSaved(Week.FIRST, Role.RETAILER, FOUR, VERSION_1, Editor.ByParticipant(P4), 1),
            """{"week":1,"role":"RETAILER","quantity":4,"decisionVersion":1,"editor":$PARTICIPANT_EDITOR_JSON,""" +
                """"submittedRoleCount":1}""",
        ),
        Triple(
            "RoleHolderReplaced",
            SessionEvent.RoleHolderReplaced(Role.RETAILER, setOf(P2, P1), P3),
            """{"role":"RETAILER","removed":["${P1.value}","${P2.value}"],"added":"${P3.value}"}""",
        ),
        Triple(
            "CommitModeChanged",
            SessionEvent.CommitModeChanged(CommitMode.AUTO),
            """{"commitMode":"AUTO"}""",
        ),
        Triple("SessionPaused", SessionEvent.SessionPaused, "{}"),
        Triple("SessionResumed", SessionEvent.SessionResumed, "{}"),
        Triple(
            "ProxyDecisionSubmitted",
            SessionEvent.ProxyDecisionSubmitted(Week.FIRST, Role.FACTORY, FOUR, VERSION_1, FACILITATOR_EDITOR, 1),
            """{"week":1,"role":"FACTORY","quantity":4,"decisionVersion":1,"editor":$FACILITATOR_EDITOR_JSON,""" +
                """"submittedRoleCount":1}""",
        ),
        Triple(
            "WeekCommitted",
            COMMITTED,
            """{"week":1,"commitKind":"MANUAL","decisions":$DECISIONS_JSON,"results":{"factory":$RESULT_JSON,""" +
                """"distributor":$RESULT_JSON,"wholesaler":$RESULT_JSON,"retailer":$RESULT_JSON},""" +
                """"nextStates":{"factory":$FACTORY_NEXT_JSON,"distributor":$OTHER_NEXT_JSON,""" +
                """"wholesaler":$OTHER_NEXT_JSON,"retailer":$RETAILER_NEXT_JSON},"contributors":4}""",
        ),
        Triple("SessionEnded", SessionEvent.SessionEnded(EndReason.FINAL_WEEK), """{"reason":"FINAL_WEEK"}"""),
    )

/**
 * イベントの符号化の golden（B5 Step 4.6）。**全イベントの種類**について、event_type と JSON の形を固定する。
 * JSON の形は、過去のイベントを読み続ける契約（ADR-006。N-1 互換）なので、変えるときは schema_version を上げる。
 * 表示名・資格の値を持つ項目が無い（ADR-002）ことは、型（DTO）と、ここでの全文の一致で守る。
 */
class EventGoldenSpec :
    FunSpec({
        test("[B5/4.6] ドメインの全イベントの種類（sealed の直接の部分型）に golden がある") {
            val domainTypes =
                listOf(GameEvent::class.java, SessionEvent::class.java).flatMap { sealed ->
                    sealed.permittedSubclasses?.map { it.simpleName } ?: fail("sealed の部分型を取れない: $sealed")
                }

            GOLDEN.map { it.first } shouldContainExactlyInAnyOrder domainTypes
        }

        GOLDEN.forEach { (type, event, json) ->
            test("[B5/4.6] golden: $type の event_type は固定の名前で、JSON は固定の形。復号すると元に戻る") {
                val encoded = EventCodec.encode(event)

                encoded.eventType shouldBe type
                encoded.schemaVersion shouldBe 1
                encoded.payloadJson shouldBe json
                encoded.payloadJson shouldNotContain "displayName"
                EventCodec.decode(encoded.eventType, encoded.schemaVersion, json) shouldBe Either.Right(event)
            }
        }
    })
