package beergame.persistence

import arrow.core.Either
import arrow.core.flatMap
import arrow.core.left
import beergame.domain.DomainEvent
import beergame.domain.GameEvent
import beergame.domain.SessionEvent
import kotlinx.serialization.json.Json

/**
 * イベントの JSON 変換。永続化用の DTO（`EventDtos.kt`）とドメインのイベントを相互に変換する。
 * 変換は `when` で網羅し、イベントの追加でコンパイルが失敗する。復号の失敗は例外でなく Left（理由の文字列）で返す。
 * アップキャスト（旧版の DTO から新版への変換）は、版が増えたときにここへ足す（今は版 1 だけ）。
 */
object EventCodec {
    const val CURRENT_SCHEMA_VERSION = 1

    data class Encoded(
        val eventType: String,
        val schemaVersion: Int,
        val payloadJson: String,
    )

    internal val json = Json { encodeDefaults = true }

    fun encode(event: DomainEvent): Encoded =
        when (event) {
            is GameEvent -> encodeGameEvent(event)
            is SessionEvent -> encodeSessionEvent(event)
        }

    /** 保存された JSON をドメインのイベントへ戻す。未対応の `schema_version`・未知の `event_type`・壊れた JSON・不正な値は Left。 */
    fun decode(
        eventType: String,
        schemaVersion: Int,
        payloadJson: String,
    ): Either<String, DomainEvent> =
        if (schemaVersion != CURRENT_SCHEMA_VERSION) {
            "未対応の schema_version: $schemaVersion（$eventType）".left()
        } else {
            Either
                .catch { decodeByType(eventType, payloadJson) }
                .mapLeft { "イベントを復号できない: $eventType（${it::class.simpleName}）" }
                .flatMap { it }
        }

    private fun decodeByType(
        eventType: String,
        payloadJson: String,
    ): Either<String, DomainEvent> =
        when (eventType) {
            "GameCreated" -> {
                json.decodeFromString(GameCreatedDto.serializer(), payloadJson).toGameCreated()
            }

            "ParticipantJoined" -> {
                json
                    .decodeFromString(
                        ParticipantJoinedDto.serializer(),
                        payloadJson,
                    ).toParticipantJoined()
            }

            "RoleAssigned" -> {
                json.decodeFromString(RoleAssignedDto.serializer(), payloadJson).toRoleAssigned()
            }

            "RoleUnassigned" -> {
                json.decodeFromString(RoleUnassignedDto.serializer(), payloadJson).toRoleUnassigned()
            }

            "GameStarted" -> {
                json.decodeFromString(GameStartedDto.serializer(), payloadJson).toGameStarted()
            }

            "SessionStarted" -> {
                json.decodeFromString(SessionStartedDto.serializer(), payloadJson).toSessionStarted()
            }

            "DecisionSaved" -> {
                json.decodeFromString(DecisionSavedDto.serializer(), payloadJson).toDecisionSaved()
            }

            "WeekCommitted" -> {
                json.decodeFromString(WeekCommittedDto.serializer(), payloadJson).toWeekCommitted()
            }

            "SessionEnded" -> {
                json.decodeFromString(SessionEndedDto.serializer(), payloadJson).toSessionEnded()
            }

            else -> {
                "未知の event_type: $eventType".left()
            }
        }
}
