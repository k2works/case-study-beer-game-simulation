package beergame.persistence

import arrow.core.Either
import arrow.core.raise.either
import beergame.domain.CommitMode
import beergame.domain.CostPolicy
import beergame.domain.CredentialSubject
import beergame.domain.DemandSeries
import beergame.domain.DomainEvent
import beergame.domain.GameEvent
import beergame.domain.GameId
import beergame.domain.GameSettings
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
        GameSettings(finalWeek, series, cost, enumOf<CommitMode>(commitMode, "確定方式").bind())
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

private fun CredentialSubjectDto.toSubject(): Either<String, CredentialSubject> =
    either {
        when (kind) {
            "FACILITATOR" -> CredentialSubject.Facilitator(GameId(uuid(id).bind()))
            "PARTICIPANT" -> CredentialSubject.Participant(ParticipantId(uuid(id).bind()))
            else -> raise("資格の主体の種別が不正: $kind")
        }
    }

internal fun CredentialRevokedDto.toCredentialRevoked(): Either<String, DomainEvent> =
    either { GameEvent.CredentialRevoked(subject.toSubject().bind()) }

internal fun CredentialReissuedDto.toCredentialReissued(): Either<String, DomainEvent> =
    either { GameEvent.CredentialReissued(subject.toSubject().bind(), instant(expiresAt).bind()) }

internal fun ParticipationRecoveredDto.toParticipationRecovered(): Either<String, DomainEvent> =
    either { GameEvent.ParticipationRecovered(subject.toSubject().bind(), instant(credentialExpiresAt).bind()) }
