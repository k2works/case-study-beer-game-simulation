package beergame.persistence

import arrow.core.Either
import arrow.core.getOrElse
import beergame.domain.CredentialSubject
import beergame.domain.DecisionVersion
import beergame.domain.Editor
import beergame.domain.GameEvent
import beergame.domain.GameId
import beergame.domain.ParticipantId
import beergame.domain.Quantity
import beergame.domain.Role
import beergame.domain.SessionEvent
import beergame.domain.Week
import io.kotest.assertions.fail
import io.kotest.core.spec.style.FunSpec
import io.kotest.matchers.collections.shouldContainAll
import io.kotest.matchers.shouldBe
import io.kotest.matchers.string.shouldContain
import io.kotest.matchers.string.shouldNotContain
import io.kotest.matchers.types.shouldBeInstanceOf
import java.time.Instant
import java.util.UUID

private fun playedScript(finalWeek: Int): GameScript {
    val script = GameScript().create(finalWeek = finalWeek)
    val players = script.joinAllRoles()
    script.startGame()
    repeat(finalWeek) { script.playWeek(players) }
    return script
}

class EventCodecSpec :
    FunSpec({
        test("[7.2] Given 実物のドメインが作った全種類のイベント When 変換して戻す Then 元と等しい（往復）") {
            val events = (1..4).flatMap { playedScript(it).events }.map { it.payload }

            events.map { it::class.simpleName }.toSet() shouldContainAll
                listOf(
                    "GameCreated",
                    "ParticipantJoined",
                    "RoleAssigned",
                    "GameStarted",
                    "SessionStarted",
                    "DecisionSaved",
                    "WeekCommitted",
                    "SessionEnded",
                )
            events.forEach { event ->
                val encoded = EventCodec.encode(event)
                EventCodec.decode(encoded.eventType, encoded.schemaVersion, encoded.payloadJson) shouldBe
                    Either.Right(event)
            }
        }

        test("[7.2] Given RoleUnassigned When 変換して戻す Then 元と等しい") {
            val script = GameScript().create()
            val participant = script.join()
            script.assign(participant, beergame.domain.Role.FACTORY).assign(participant, beergame.domain.Role.RETAILER)
            val unassigned =
                script.events
                    .map { it.payload }
                    .filterIsInstance<GameEvent.RoleUnassigned>()
                    .single()

            val encoded = EventCodec.encode(unassigned)

            encoded.eventType shouldBe "RoleUnassigned"
            EventCodec.decode(encoded.eventType, encoded.schemaVersion, encoded.payloadJson) shouldBe
                Either.Right(unassigned)
        }

        test("[B5] 停止・再開・代理入力のイベントを変換して戻すと、元と等しい（golden と全種類の網羅は Step 4.6）") {
            val facilitator = Editor.ByFacilitator(GameId(UUID.fromString("00000000-0000-0000-0000-00000000abcd")))
            val proxy =
                SessionEvent.ProxyDecisionSubmitted(
                    Week.FIRST,
                    Role.FACTORY,
                    Quantity.of(6).getOrElse { fail("数量が不正: $it") },
                    DecisionVersion.ZERO.next(),
                    facilitator,
                    1,
                )

            listOf(SessionEvent.SessionPaused, SessionEvent.SessionResumed, proxy).forEach { event ->
                val encoded = EventCodec.encode(event)
                EventCodec.decode(encoded.eventType, encoded.schemaVersion, encoded.payloadJson) shouldBe
                    Either.Right(event)
            }
            EventCodec.encode(SessionEvent.SessionPaused).eventType shouldBe "SessionPaused"
            EventCodec.encode(SessionEvent.SessionResumed).eventType shouldBe "SessionResumed"
            EventCodec.encode(proxy).payloadJson shouldContain "FACILITATOR"
            listOf(SessionEvent.SessionPaused, SessionEvent.SessionResumed, proxy).forEach {
                EventCodec.encode(it).payloadJson shouldNotContain "displayName"
            }
        }

        test("[B5] 資格の失効・再発行・復帰のイベントを変換して戻すと、元と等しい（進行役・参加者の両方の主体）") {
            val gameId = GameId(UUID.fromString("00000000-0000-0000-0000-00000000abcd"))
            val expiresAt = Instant.parse("2026-12-16T09:00:00Z")
            val participantId = ParticipantId(UUID.fromString("00000000-0000-0000-0000-000000000001"))
            val subjects = listOf(CredentialSubject.Facilitator(gameId), CredentialSubject.Participant(participantId))
            val events =
                subjects.flatMap {
                    listOf(
                        GameEvent.CredentialRevoked(it),
                        GameEvent.CredentialReissued(it, expiresAt),
                        GameEvent.ParticipationRecovered(it, expiresAt),
                    )
                }

            events.forEach { event ->
                val encoded = EventCodec.encode(event)
                EventCodec.decode(encoded.eventType, encoded.schemaVersion, encoded.payloadJson) shouldBe
                    Either.Right(event)
                encoded.payloadJson shouldNotContain "displayName"
            }
            events.map { EventCodec.encode(it).eventType }.toSet() shouldBe
                setOf("CredentialRevoked", "CredentialReissued", "ParticipationRecovered")
            EventCodec.encode(events.first()).payloadJson shouldContain "FACILITATOR"
            EventCodec.encode(events[3]).payloadJson shouldContain "PARTICIPANT"
        }

        test("[B5] 主体の種別・ID・期限が不正な資格のイベントは、復号できず Left") {
            val subject = """{"kind":"PARTICIPANT","id":"00000000-0000-0000-0000-000000000001"}"""
            listOf(
                "CredentialRevoked" to """{"subject":{"kind":"ROBOT","id":"x"}}""",
                "CredentialRevoked" to """{"subject":{"kind":"PARTICIPANT","id":"not-a-uuid"}}""",
                "CredentialReissued" to """{"subject":$subject,"expiresAt":"yesterday"}""",
                "ParticipationRecovered" to """{"subject":$subject,"credentialExpiresAt":"yesterday"}""",
            ).forEach { (type, json) ->
                EventCodec.decode(type, 1, json).shouldBeInstanceOf<Either.Left<String>>()
            }
        }

        test("[B5/H4] 役割の入れ替えのイベント（ParticipantReplaced・RoleHolderReplaced）を変換して戻すと、元と等しい") {
            val old1 = ParticipantId(UUID.fromString("00000000-0000-0000-0000-000000000004"))
            val old2 = ParticipantId(UUID.fromString("00000000-0000-0000-0000-000000000006"))
            val new1 = ParticipantId(UUID.fromString("00000000-0000-0000-0000-000000000005"))
            val replaced = GameEvent.ParticipantReplaced(old1, Role.RETAILER, new1)
            val holders = SessionEvent.RoleHolderReplaced(Role.RETAILER, setOf(old2, old1), new1)

            listOf(replaced, holders).forEach { event ->
                val encoded = EventCodec.encode(event)
                EventCodec.decode(encoded.eventType, encoded.schemaVersion, encoded.payloadJson) shouldBe
                    Either.Right(event)
                encoded.payloadJson shouldNotContain "displayName"
            }
            EventCodec.encode(replaced).eventType shouldBe "ParticipantReplaced"
            EventCodec.encode(holders).eventType shouldBe "RoleHolderReplaced"
            // 集合は識別子の順に並べて書く（同じ事実は同じ JSON になる）
            EventCodec.encode(holders).payloadJson shouldBe
                """{"role":"RETAILER","removed":["${old1.value}","${old2.value}"],"added":"${new1.value}"}"""
            EventCodec.encode(replaced).payloadJson shouldBe
                """{"participantId":"${old1.value}","role":"RETAILER","replacedBy":"${new1.value}"}"""
        }

        test("[B5/H4] 識別子・役割が不正な入れ替えのイベントは、復号できず Left") {
            val id = "00000000-0000-0000-0000-000000000004"
            listOf(
                "ParticipantReplaced" to """{"participantId":"x","role":"RETAILER","replacedBy":"$id"}""",
                "ParticipantReplaced" to """{"participantId":"$id","role":"ROBOT","replacedBy":"$id"}""",
                "ParticipantReplaced" to """{"participantId":"$id","role":"RETAILER","replacedBy":"x"}""",
                "RoleHolderReplaced" to """{"role":"ROBOT","removed":["$id"],"added":"$id"}""",
                "RoleHolderReplaced" to """{"role":"RETAILER","removed":["x"],"added":"$id"}""",
                "RoleHolderReplaced" to """{"role":"RETAILER","removed":["$id"],"added":"x"}""",
            ).forEach { (type, json) ->
                EventCodec.decode(type, 1, json).shouldBeInstanceOf<Either.Left<String>>()
            }
        }

        test("[B5] 入力者の種別が不正な代理入力は、復号できず Left") {
            val broken =
                """{"week":1,"role":"FACTORY","quantity":6,"decisionVersion":1,""" +
                    """"editor":{"kind":"ROBOT","id":"x"},"submittedRoleCount":1}"""

            EventCodec.decode("ProxyDecisionSubmitted", 1, broken).shouldBeInstanceOf<Either.Left<String>>()
        }

        test("[7.2] Given 変換した JSON When 中身を見る Then event_type は固定の名前で、schema_version は 1、表示名は含まれない") {
            val script = playedScript(1)
            val encoded = script.events.map { EventCodec.encode(it.payload) }

            encoded.map { it.eventType }.toSet() shouldBe
                setOf(
                    "GameCreated",
                    "ParticipantJoined",
                    "RoleAssigned",
                    "GameStarted",
                    "SessionStarted",
                    "DecisionSaved",
                    "WeekCommitted",
                    "SessionEnded",
                )
            encoded.all { it.schemaVersion == 1 } shouldBe true
            encoded.forEach {
                it.payloadJson shouldNotContain "参加者"
                it.payloadJson shouldNotContain "displayName"
            }
        }

        test("[7.2] golden: GameStarted と SessionEnded の JSON は固定の形") {
            val started =
                GameEvent.GameStarted(
                    beergame.domain.GameId(java.util.UUID.fromString("00000000-0000-0000-0000-00000000abcd")),
                )

            EventCodec.encode(started).payloadJson shouldBe """{"gameId":"00000000-0000-0000-0000-00000000abcd"}"""
            EventCodec.encode(SessionEvent.SessionEnded(beergame.domain.EndReason.FINAL_WEEK)).payloadJson shouldBe
                """{"reason":"FINAL_WEEK"}"""
        }

        test("[7.2] Given 未対応の schema_version・未知の event_type・壊れた JSON When 読む Then Left（落ちない）") {
            EventCodec
                .decode(
                    "GameStarted",
                    99,
                    """{"gameId":"00000000-0000-0000-0000-00000000abcd"}""",
                ).shouldBeInstanceOf<Either.Left<String>>()
            EventCodec.decode("NoSuchEvent", 1, "{}").shouldBeInstanceOf<Either.Left<String>>()
            EventCodec.decode("GameStarted", 1, "{not json").shouldBeInstanceOf<Either.Left<String>>()
            EventCodec.decode("GameStarted", 1, """{"gameId":"not-a-uuid"}""").shouldBeInstanceOf<Either.Left<String>>()
        }
    })
