package beergame.persistence

import arrow.core.Either
import arrow.core.raise.either
import beergame.domain.DomainEvent
import beergame.domain.GameEvent
import beergame.domain.InvitationId
import beergame.domain.ObserverId

// 観察者のイベント（B9）の DTO との変換。招待コードの値・表示名・資格の値は、DTO にも持たせない。

internal fun GameEvent.ObserverInvited.toEncoded(): EventCodec.Encoded =
    enc(
        ObserverInvitedDto.serializer(),
        ObserverInvitedDto(invitationId.value.toString(), expiresAt.toString()),
    )

internal fun GameEvent.ObserverInvitationRevoked.toEncoded(): EventCodec.Encoded =
    enc(
        ObserverInvitationRevokedDto.serializer(),
        ObserverInvitationRevokedDto(invitationId.value.toString()),
    )

internal fun GameEvent.ObserverJoined.toEncoded(): EventCodec.Encoded =
    enc(
        ObserverJoinedDto.serializer(),
        ObserverJoinedDto(observerId.value.toString(), invitationId.value.toString(), credentialExpiresAt.toString()),
    )

internal fun ObserverInvitedDto.toObserverInvited(): Either<String, DomainEvent> =
    either { GameEvent.ObserverInvited(InvitationId(uuid(invitationId).bind()), instant(expiresAt).bind()) }

internal fun ObserverInvitationRevokedDto.toObserverInvitationRevoked(): Either<String, DomainEvent> =
    either { GameEvent.ObserverInvitationRevoked(InvitationId(uuid(invitationId).bind())) }

internal fun ObserverJoinedDto.toObserverJoined(): Either<String, DomainEvent> =
    either {
        GameEvent.ObserverJoined(
            ObserverId(uuid(observerId).bind()),
            InvitationId(uuid(invitationId).bind()),
            instant(credentialExpiresAt).bind(),
        )
    }
