package beergame.persistence

import arrow.core.Either
import beergame.domain.GameEvent
import beergame.domain.GameId
import io.kotest.assertions.throwables.shouldThrow
import io.kotest.core.spec.style.FunSpec
import io.kotest.matchers.shouldBe
import io.kotest.matchers.string.shouldContain
import kotlinx.serialization.json.JsonObject
import java.util.UUID

private val GAME = GameId(UUID.fromString("00000000-0000-0000-0000-00000000abcd"))

/** 旧い形（版 1）の GameStarted は `{"id": ...}`、版 2 は `{"game": ...}`、最新（版 3）は `{"gameId": ...}` とする合成の進化。 */
private fun rename(
    from: String,
    to: String,
): (JsonObject) -> JsonObject = { payload -> JsonObject(payload.mapKeys { (key, _) -> if (key == from) to else key }) }

private val CHAIN =
    UpcastChain(
        latest = 3,
        upcasts =
            listOf(
                Upcast("GameStarted", 1, rename("id", "game")),
                Upcast("GameStarted", 2, rename("game", "gameId")),
                Upcast("ParticipantJoined", 1, { it }),
            ),
    )

private fun decodeStarted(
    version: Int,
    json: String,
) = EventCodec.decodeWith(CHAIN, "GameStarted", version, json)

/** アップキャスト（B12）。形が変わったイベントを、旧版の保存済みの JSON から、現在の形で読めること。 */
class EventUpcastSpec :
    FunSpec({
        test("[B12/NF-O11] Given 版 1 と版 2 の保存済みの JSON When アップキャストして復号する Then 最新の形と同じイベントになる") {
            val expected = Either.Right(GameEvent.GameStarted(GAME))

            decodeStarted(1, """{"id":"${GAME.value}"}""") shouldBe expected
            decodeStarted(2, """{"game":"${GAME.value}"}""") shouldBe expected
            decodeStarted(3, """{"gameId":"${GAME.value}"}""") shouldBe expected
        }

        test("[B12] Given 読める範囲の外の版 When 復号する Then 未対応の schema_version として Left（読み込みの失敗）") {
            val unreadable = listOf(0, 4, -1)

            unreadable.forEach {
                decodeStarted(it, """{"gameId":"${GAME.value}"}""").leftOrNull() shouldBe
                    "未対応の schema_version: $it（GameStarted）"
            }
        }

        test("[B12] Given 旧版の JSON が壊れている When 復号する Then 例外にせず Left") {
            val failure = decodeStarted(1, "[1, 2").leftOrNull()

            failure shouldContain "イベントを復号できない"
        }

        test("[B12] Given 変換の無いイベントの種類 When 旧版を読む Then 形が同じとして最新の版へ進む") {
            val payload =
                """{"participantId":"00000000-0000-0000-0000-000000000001",""" +
                    """"credentialExpiresAt":"2026-12-01T09:00:00Z"}"""

            EventCodec.decodeWith(CHAIN, "ParticipantJoined", 1, payload).isRight() shouldBe true
            EventCodec.decodeWith(CHAIN, "GameStarted", 3, """{"gameId":"${GAME.value}"}""").isRight() shouldBe true
        }

        test("[B12] Given 本番の連なり When 読める範囲を見る Then 版 1 だけで、書く版は読める最新の版以下") {
            PRODUCTION_UPCASTS.latest shouldBe EventCodec.LATEST_READABLE_SCHEMA_VERSION
            (EventCodec.CURRENT_SCHEMA_VERSION <= EventCodec.LATEST_READABLE_SCHEMA_VERSION) shouldBe true
            EventCodec.decode("SessionPaused", 2, "{}").leftOrNull() shouldBe "未対応の schema_version: 2（SessionPaused）"
        }

        test("[B12] Given 不正な連なりの定義 When 作る Then 失敗する（元の版が範囲外、同じ版の重複）") {
            shouldThrow<IllegalArgumentException> { UpcastChain(0, emptyList()) }
            shouldThrow<IllegalArgumentException> { UpcastChain(2, listOf(Upcast("GameStarted", 2, { it }))) }
            shouldThrow<IllegalArgumentException> {
                UpcastChain(2, listOf(Upcast("GameStarted", 1, { it }), Upcast("GameStarted", 1, { it })))
            }
        }
    })
