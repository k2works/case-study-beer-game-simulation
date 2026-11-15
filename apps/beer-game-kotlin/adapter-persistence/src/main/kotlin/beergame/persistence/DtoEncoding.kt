package beergame.persistence

import beergame.domain.Editor
import beergame.domain.GameEvent
import beergame.domain.GameSettings
import beergame.domain.RoleMap
import beergame.domain.RoleState
import beergame.domain.RoleWeekResult
import beergame.domain.SessionEvent
import kotlinx.serialization.KSerializer

// ドメイン -> DTO。`when` は網羅で、イベントの追加でコンパイルが失敗する。

private fun <T> enc(
    serializer: KSerializer<T>,
    dto: T,
): EventCodec.Encoded =
    EventCodec.Encoded(
        serializer.descriptor.serialName,
        EventCodec.CURRENT_SCHEMA_VERSION,
        EventCodec.json.encodeToString(serializer, dto),
    )

internal fun encodeGameEvent(event: GameEvent): EventCodec.Encoded =
    when (event) {
        is GameEvent.GameCreated -> {
            val dto =
                GameCreatedDto(
                    event.gameId.value.toString(),
                    event.joinCode.value,
                    event.settings.toDto(),
                    event.retentionDays.value,
                    event.facilitatorCredentialExpiresAt.toString(),
                )
            enc(GameCreatedDto.serializer(), dto)
        }

        is GameEvent.ParticipantJoined -> {
            val dto = ParticipantJoinedDto(event.participantId.value.toString(), event.credentialExpiresAt.toString())
            enc(ParticipantJoinedDto.serializer(), dto)
        }

        is GameEvent.RoleAssigned -> {
            enc(RoleAssignedDto.serializer(), RoleAssignedDto(event.participantId.value.toString(), event.role.name))
        }

        is GameEvent.RoleUnassigned -> {
            enc(
                RoleUnassignedDto.serializer(),
                RoleUnassignedDto(event.participantId.value.toString(), event.role.name),
            )
        }

        is GameEvent.GameStarted -> {
            enc(GameStartedDto.serializer(), GameStartedDto(event.gameId.value.toString()))
        }
    }

internal fun encodeSessionEvent(event: SessionEvent): EventCodec.Encoded =
    when (event) {
        is SessionEvent.SessionStarted -> {
            val dto =
                SessionStartedDto(
                    event.gameId.value.toString(),
                    event.settings.toDto(),
                    event.assignments.toDto { ids -> ids.map { it.value.toString() }.sorted() },
                    event.initialStates.toDto { it.toDto() },
                    event.commitMode.name,
                )
            enc(SessionStartedDto.serializer(), dto)
        }

        is SessionEvent.DecisionSaved -> {
            val dto =
                DecisionSavedDto(
                    event.week.value,
                    event.role.name,
                    event.quantity.value,
                    event.decisionVersion.value,
                    event.editor.toDto(),
                    event.submittedRoleCount,
                )
            enc(DecisionSavedDto.serializer(), dto)
        }

        is SessionEvent.SessionPaused -> {
            enc(SessionPausedDto.serializer(), SessionPausedDto)
        }

        is SessionEvent.SessionResumed -> {
            enc(SessionResumedDto.serializer(), SessionResumedDto)
        }

        is SessionEvent.ProxyDecisionSubmitted -> {
            val dto =
                ProxyDecisionSubmittedDto(
                    event.week.value,
                    event.role.name,
                    event.quantity.value,
                    event.decisionVersion.value,
                    event.editor.toDto(),
                    event.submittedRoleCount,
                )
            enc(ProxyDecisionSubmittedDto.serializer(), dto)
        }

        is SessionEvent.WeekCommitted -> {
            val dto =
                WeekCommittedDto(
                    event.week.value,
                    event.commitKind.name,
                    event.decisions.toDto { it.value },
                    event.results.toDto { it.toDto() },
                    event.nextStates.toDto { it.toDto() },
                    event.contributors,
                )
            enc(WeekCommittedDto.serializer(), dto)
        }

        is SessionEvent.SessionEnded -> {
            enc(SessionEndedDto.serializer(), SessionEndedDto(event.reason.name))
        }
    }

private fun GameSettings.toDto() =
    SettingsDto(finalWeek.value, demand.asInts(), costPolicy.holding.minor, costPolicy.backlog.minor, commitMode.name)

private fun <A, B> RoleMap<A>.toDto(f: (A) -> B) = RoleMapDto(f(factory), f(distributor), f(wholesaler), f(retailer))

private fun RoleState.toDto() =
    RoleStateDto(
        inventory.value,
        backlog.value,
        orderPipeline.weeks.map { it.value },
        deliveryPipeline.weeks.map { it.value },
        cumulativeCost.minor,
        arrivals.value,
        orders.value,
    )

private fun RoleWeekResult.toDto() =
    RoleWeekResultDto(
        orders.value,
        shipped.value,
        ordered.value,
        endingInventory.value,
        endingBacklog.value,
        weeklyCost.minor,
        cumulativeCost.minor,
    )

private fun Editor.toDto(): EditorDto =
    when (this) {
        is Editor.ByParticipant -> EditorDto("PARTICIPANT", id.value.toString())
        is Editor.ByFacilitator -> EditorDto("FACILITATOR", gameId.value.toString())
    }
