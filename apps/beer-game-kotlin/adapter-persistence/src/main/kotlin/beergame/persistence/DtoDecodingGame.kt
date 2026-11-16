package beergame.persistence

import arrow.core.Either
import arrow.core.raise.either
import arrow.core.raise.ensure
import beergame.domain.CommitMode
import beergame.domain.CostPolicy
import beergame.domain.Delay
import beergame.domain.Delays
import beergame.domain.DemandSeries
import beergame.domain.DisclosurePolicy
import beergame.domain.DomainEvent
import beergame.domain.GameEvent
import beergame.domain.GameId
import beergame.domain.GameSettings
import beergame.domain.InitialConditions
import beergame.domain.JoinCode
import beergame.domain.ParticipantId
import beergame.domain.RetentionDays
import beergame.domain.Role

// DTO -> ドメイン（game ストリームのイベントと設定）。値オブジェクトの検証を通す。

internal fun SettingsDto.toDomain(): Either<String, GameSettings> =
    either {
        val finalWeek = week(finalWeek).bind()
        val series = DemandSeries.of(demand, finalWeek).mapLeft { it.toString() }.bind()
        val cost = CostPolicy(money(holdingCostMinor).bind(), money(backlogCostMinor).bind())
        val base = GameSettings(finalWeek, series, cost, enumOf<CommitMode>(commitMode, "確定方式").bind())
        conditions?.toDomain()?.bind()?.let {
            base.copy(
                initial = it.initial,
                delays = it.delays,
                disclosure = it.disclosure,
            )
        }
            ?: base
    }

private data class DecodedConditions(
    val initial: InitialConditions,
    val delays: Delays,
    val disclosure: DisclosurePolicy,
)

private fun ConditionsDto.toDomain(): Either<String, DecodedConditions> =
    either {
        ensure(listOf(orderDelayWeeks, shipmentDelayWeeks, productionDelayWeeks).all { it >= 1 }) { "遅延が 1 週未満" }
        DecodedConditions(
            InitialConditions(initialInventory.traverse { units(it) }.bind(), units(initialFlow).bind()),
            Delays(Delay(orderDelayWeeks), Delay(shipmentDelayWeeks), Delay(productionDelayWeeks)),
            enumOf<DisclosurePolicy>(disclosurePolicy, "公開範囲").bind(),
        )
    }

internal fun GameCreatedDto.toGameCreated(): Either<String, DomainEvent> =
    either {
        GameEvent.GameCreated(
            GameId(uuid(gameId).bind()),
            JoinCode.of(joinCode).mapLeft { it.toString() }.bind(),
            settings.toDomain().bind(),
            RetentionDays.of(retentionDays).mapLeft { it.toString() }.bind(),
            instant(facilitatorCredentialExpiresAt).bind(),
        )
    }

internal fun ParticipantJoinedDto.toParticipantJoined(): Either<String, DomainEvent> =
    either {
        GameEvent.ParticipantJoined(
            ParticipantId(uuid(participantId).bind()),
            instant(credentialExpiresAt).bind(),
        )
    }

internal fun RoleAssignedDto.toRoleAssigned(): Either<String, DomainEvent> =
    either { GameEvent.RoleAssigned(ParticipantId(uuid(participantId).bind()), enumOf<Role>(role, "役割").bind()) }

internal fun RoleUnassignedDto.toRoleUnassigned(): Either<String, DomainEvent> =
    either { GameEvent.RoleUnassigned(ParticipantId(uuid(participantId).bind()), enumOf<Role>(role, "役割").bind()) }

internal fun GameStartedDto.toGameStarted(): Either<String, DomainEvent> =
    either { GameEvent.GameStarted(GameId(uuid(gameId).bind())) }

internal fun ParticipantReplacedDto.toParticipantReplaced(): Either<String, DomainEvent> =
    either {
        GameEvent.ParticipantReplaced(
            ParticipantId(uuid(participantId).bind()),
            enumOf<Role>(role, "役割").bind(),
            ParticipantId(uuid(replacedBy).bind()),
        )
    }
