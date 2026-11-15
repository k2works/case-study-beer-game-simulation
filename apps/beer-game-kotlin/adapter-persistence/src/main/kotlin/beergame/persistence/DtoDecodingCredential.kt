package beergame.persistence

import arrow.core.Either
import arrow.core.raise.either
import beergame.domain.CredentialSubject
import beergame.domain.DomainEvent
import beergame.domain.GameEvent
import beergame.domain.GameId
import beergame.domain.ParticipantId

// DTO -> ドメイン（game ストリームの資格のイベント）。資格の値は持たず、主体と期限だけを復号する。

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
