package beergame.persistence

import arrow.core.Either
import arrow.core.flatMap
import arrow.core.left
import arrow.core.right
import beergame.domain.DomainEvent
import beergame.domain.GameEvent
import beergame.domain.SessionEvent
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject

/**
 * イベントの JSON 変換。永続化用の DTO（`EventDtos.kt`）とドメインのイベントを相互に変換する。
 * 変換は `when` で網羅し、イベントの追加でコンパイルが失敗する。復号の失敗は例外でなく Left（理由の文字列）で返す。
 * アップキャスト（旧版の JSON から新版への変換。[Upcast]）は、版が増えたときに `EventUpcast.kt` へ足す（今は版 1 だけで、変換は 0 個）。
 * 書く版（[CURRENT_SCHEMA_VERSION]）と、読める最新の版（[LATEST_READABLE_SCHEMA_VERSION]）は別の定数にする
 * （読む版 → 書く版の 2 段階のリリース。書く版は、読める最新の版以下）。
 */
object EventCodec {
    /** 書く版。新しいイベントに付ける `schema_version`。 */
    const val CURRENT_SCHEMA_VERSION = 1

    /** 読める最新の版。1 から、この版までの `schema_version` を読める（旧版はアップキャストして読む）。書く版以上。 */
    const val LATEST_READABLE_SCHEMA_VERSION = 1

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
    ): Either<String, DomainEvent> = decodeWith(PRODUCTION_UPCASTS, eventType, schemaVersion, payloadJson)

    /** [chain] のアップキャストを通して、最新の版の形にしてから復号する。試験が、合成の版の連なりで確かめるために切り出した。 */
    internal fun decodeWith(
        chain: UpcastChain,
        eventType: String,
        schemaVersion: Int,
        payloadJson: String,
    ): Either<String, DomainEvent> =
        if (!chain.canRead(schemaVersion)) {
            "未対応の schema_version: $schemaVersion（$eventType）".left()
        } else {
            Either
                .catch { decodeByType(eventType, upcasted(chain, eventType, schemaVersion, payloadJson)) }
                .mapLeft { "イベントを復号できない: $eventType（${it::class.simpleName}）" }
                .flatMap { it }
        }

    /** 最新の版なら、そのまま。旧版なら、JSON のオブジェクトとして読み、最新の版まで直す。 */
    private fun upcasted(
        chain: UpcastChain,
        eventType: String,
        schemaVersion: Int,
        payloadJson: String,
    ): String =
        if (schemaVersion == chain.latest) {
            payloadJson
        } else {
            json.encodeToString(
                JsonObject.serializer(),
                chain.toLatest(eventType, schemaVersion, json.decodeFromString(JsonObject.serializer(), payloadJson)),
            )
        }

    /** game ストリームの種別なら復号し、そうでなければ session ストリームの種別を試す。どちらでもなければ Left。 */
    private fun decodeByType(
        eventType: String,
        payloadJson: String,
    ): Either<String, DomainEvent> =
        decodeGameEvent(eventType, payloadJson)
            ?: decodeSessionEvent(eventType, payloadJson)
            ?: "未知の event_type: $eventType".left()

    /** game ストリームのイベント。game の種別でなければ null。 */
    private fun decodeGameEvent(
        eventType: String,
        payloadJson: String,
    ): Either<String, DomainEvent>? =
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

            "ObserverInvited" -> {
                json.decodeFromString(ObserverInvitedDto.serializer(), payloadJson).toObserverInvited()
            }

            "ObserverInvitationRevoked" -> {
                json
                    .decodeFromString(ObserverInvitationRevokedDto.serializer(), payloadJson)
                    .toObserverInvitationRevoked()
            }

            "ObserverJoined" -> {
                json.decodeFromString(ObserverJoinedDto.serializer(), payloadJson).toObserverJoined()
            }

            "CredentialRevoked" -> {
                json.decodeFromString(CredentialRevokedDto.serializer(), payloadJson).toCredentialRevoked()
            }

            "CredentialReissued" -> {
                json.decodeFromString(CredentialReissuedDto.serializer(), payloadJson).toCredentialReissued()
            }

            "ParticipationRecovered" -> {
                json
                    .decodeFromString(ParticipationRecoveredDto.serializer(), payloadJson)
                    .toParticipationRecovered()
            }

            "ParticipantReplaced" -> {
                json
                    .decodeFromString(ParticipantReplacedDto.serializer(), payloadJson)
                    .toParticipantReplaced()
            }

            else -> {
                null
            }
        }

    /** session ストリームのイベント。session の種別でなければ null。 */
    private fun decodeSessionEvent(
        eventType: String,
        payloadJson: String,
    ): Either<String, DomainEvent>? =
        when (eventType) {
            "SessionStarted" -> {
                json.decodeFromString(SessionStartedDto.serializer(), payloadJson).toSessionStarted()
            }

            "DecisionSaved" -> {
                json.decodeFromString(DecisionSavedDto.serializer(), payloadJson).toDecisionSaved()
            }

            "SessionPaused" -> {
                json.decodeFromString(SessionPausedDto.serializer(), payloadJson)
                SessionEvent.SessionPaused.right()
            }

            "SessionResumed" -> {
                json.decodeFromString(SessionResumedDto.serializer(), payloadJson)
                SessionEvent.SessionResumed.right()
            }

            "CommitModeChanged" -> {
                json.decodeFromString(CommitModeChangedDto.serializer(), payloadJson).toCommitModeChanged()
            }

            "ProxyDecisionSubmitted" -> {
                json
                    .decodeFromString(ProxyDecisionSubmittedDto.serializer(), payloadJson)
                    .toProxyDecisionSubmitted()
            }

            "WeekCommitted" -> {
                json.decodeFromString(WeekCommittedDto.serializer(), payloadJson).toWeekCommitted()
            }

            "SessionEnded" -> {
                json.decodeFromString(SessionEndedDto.serializer(), payloadJson).toSessionEnded()
            }

            "RoleHolderReplaced" -> {
                json.decodeFromString(RoleHolderReplacedDto.serializer(), payloadJson).toRoleHolderReplaced()
            }

            else -> {
                null
            }
        }
}
