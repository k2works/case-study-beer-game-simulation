package beergame.persistence

import arrow.core.Either
import beergame.domain.GameEvent
import beergame.domain.SessionEvent
import io.kotest.core.spec.style.FunSpec
import io.kotest.matchers.collections.shouldContainAll
import io.kotest.matchers.shouldBe
import io.kotest.matchers.string.shouldNotContain
import io.kotest.matchers.types.shouldBeInstanceOf

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
