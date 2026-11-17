package beergame.persistence

import arrow.core.Either
import arrow.core.raise.either
import arrow.core.raise.ensureNotNull
import beergame.application.AppFailure
import beergame.application.PersistenceFailure
import beergame.domain.ActorKind
import beergame.domain.ActorRef
import beergame.domain.DomainEvent
import beergame.domain.EventEnvelope
import beergame.domain.GameId
import beergame.domain.StreamType
import beergame.domain.StreamVersion
import java.sql.ResultSet

private const val OP_READ = "events.read"

internal fun readFailure(message: String): AppFailure = AppFailure.Persistence(PersistenceFailure(OP_READ, message))

/**
 * `events` の 1 行（`event_type`・`schema_version`・`payload_json`・操作者・時刻の列を持つ結果）を、封筒に直す。
 * ペイロードは [EventCodec]（アップキャストを通す）で復号する。復号できなければ Left。
 */
internal fun ResultSet.toEnvelope(
    gameId: GameId,
    streamType: StreamType,
    version: StreamVersion,
): Either<AppFailure, EventEnvelope<DomainEvent>> =
    either {
        val kind = ActorKind.entries.firstOrNull { it.name == getString("actor_kind") }
        ensureNotNull(kind) { readFailure("操作者の種別が不正: ${getString("actor_kind")}") }
        val payload =
            EventCodec
                .decode(getString("event_type"), getInt("schema_version"), getString("payload_json"))
                .mapLeft { readFailure(it) }
                .bind()
        EventEnvelope(
            eventId = checkNotNull(getUuid("event_id")),
            gameId = gameId,
            streamType = streamType,
            streamVersion = version,
            schemaVersion = getInt("schema_version"),
            actor = ActorRef(kind, getUuid("actor_id")),
            correlationId = checkNotNull(getUuid("correlation_id")),
            commandId = checkNotNull(getUuid("command_id")),
            occurredAt = getInstant("occurred_at"),
            payload = payload,
        )
    }
