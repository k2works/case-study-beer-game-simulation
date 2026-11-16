package beergame.persistence

import kotlinx.serialization.EncodeDefault
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/*
 * イベントの永続化用の DTO（kotlinx.serialization）。ドメインのイベントには注釈を付けない（ADR-006）。
 * 表示名・資格の値・招待コードの値のフィールドは持たせない（型で防ぐ）。`@SerialName` は event_type と同じ名前で固定する。
 * 値は、JSON に素直に載る型（文字列の UUID と ISO-8601 の時刻、整数）にする。
 */

@Serializable
internal data class RoleMapDto<T>(
    val factory: T,
    val distributor: T,
    val wholesaler: T,
    val retailer: T,
)

/** カスタム条件（B7）。キットの値のままのときは書かない（`SettingsDto.conditions` が無い。過去のイベントはそのまま読める）。 */
@Serializable
internal data class ConditionsDto(
    val initialInventory: RoleMapDto<Int>,
    val initialFlow: Int,
    val orderDelayWeeks: Int,
    val shipmentDelayWeeks: Int,
    val productionDelayWeeks: Int,
    val disclosurePolicy: String,
)

@OptIn(ExperimentalSerializationApi::class)
@Serializable
internal data class SettingsDto(
    val finalWeek: Int,
    val demand: List<Int>,
    val holdingCostMinor: Long,
    val backlogCostMinor: Long,
    val commitMode: String,
    @EncodeDefault(EncodeDefault.Mode.NEVER)
    val conditions: ConditionsDto? = null,
)

@Serializable
internal data class RoleStateDto(
    val inventory: Int,
    val backlog: Int,
    val orderPipeline: List<Int>,
    val deliveryPipeline: List<Int>,
    val cumulativeCostMinor: Long,
    val arrivals: Int,
    val orders: Int,
)

@Serializable
internal data class RoleWeekResultDto(
    val orders: Int,
    val shipped: Int,
    val ordered: Int,
    val endingInventory: Int,
    val endingBacklog: Int,
    val weeklyCostMinor: Long,
    val cumulativeCostMinor: Long,
)

@Serializable
internal data class EditorDto(
    val kind: String,
    val id: String,
)

@Serializable
@SerialName("GameCreated")
internal data class GameCreatedDto(
    val gameId: String,
    val joinCode: String,
    val settings: SettingsDto,
    val retentionDays: Int,
    val facilitatorCredentialExpiresAt: String,
)

@Serializable
@SerialName("ParticipantJoined")
internal data class ParticipantJoinedDto(
    val participantId: String,
    val credentialExpiresAt: String,
)

@Serializable
@SerialName("RoleAssigned")
internal data class RoleAssignedDto(
    val participantId: String,
    val role: String,
)

@Serializable
@SerialName("RoleUnassigned")
internal data class RoleUnassignedDto(
    val participantId: String,
    val role: String,
)

@Serializable
@SerialName("GameStarted")
internal data class GameStartedDto(
    val gameId: String,
)

/** 資格の主体。`kind` は FACILITATOR（`id` はゲーム）または PARTICIPANT（`id` は参加者）。資格の値は持たない。 */
@Serializable
internal data class CredentialSubjectDto(
    val kind: String,
    val id: String,
)

@Serializable
@SerialName("CredentialRevoked")
internal data class CredentialRevokedDto(
    val subject: CredentialSubjectDto,
)

@Serializable
@SerialName("CredentialReissued")
internal data class CredentialReissuedDto(
    val subject: CredentialSubjectDto,
    val expiresAt: String,
)

@Serializable
@SerialName("ParticipationRecovered")
internal data class ParticipationRecoveredDto(
    val subject: CredentialSubjectDto,
    val credentialExpiresAt: String,
)

@Serializable
@SerialName("ParticipantReplaced")
internal data class ParticipantReplacedDto(
    val participantId: String,
    val role: String,
    val replacedBy: String,
)

@Serializable
@SerialName("SessionStarted")
internal data class SessionStartedDto(
    val gameId: String,
    val settings: SettingsDto,
    val assignments: RoleMapDto<List<String>>,
    val initialStates: RoleMapDto<RoleStateDto>,
    val commitMode: String,
)

@Serializable
@SerialName("DecisionSaved")
internal data class DecisionSavedDto(
    val week: Int,
    val role: String,
    val quantity: Int,
    val decisionVersion: Long,
    val editor: EditorDto,
    val submittedRoleCount: Int,
)

/** `removed` は、識別子の順に並べて書く（同じ事実は同じ JSON になる）。 */
@Serializable
@SerialName("RoleHolderReplaced")
internal data class RoleHolderReplacedDto(
    val role: String,
    val removed: List<String>,
    val added: String,
)

@Serializable
@SerialName("SessionPaused")
internal data object SessionPausedDto

@Serializable
@SerialName("SessionResumed")
internal data object SessionResumedDto

@Serializable
@SerialName("ProxyDecisionSubmitted")
internal data class ProxyDecisionSubmittedDto(
    val week: Int,
    val role: String,
    val quantity: Int,
    val decisionVersion: Long,
    val editor: EditorDto,
    val submittedRoleCount: Int,
)

@Serializable
@SerialName("WeekCommitted")
internal data class WeekCommittedDto(
    val week: Int,
    val commitKind: String,
    val decisions: RoleMapDto<Int>,
    val results: RoleMapDto<RoleWeekResultDto>,
    val nextStates: RoleMapDto<RoleStateDto>,
    val contributors: Int,
)

@Serializable
@SerialName("SessionEnded")
internal data class SessionEndedDto(
    val reason: String,
)
