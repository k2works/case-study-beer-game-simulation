package beergame.persistence

import arrow.core.Either
import arrow.core.flatMap
import arrow.core.left
import arrow.core.raise.either
import arrow.core.raise.ensure
import arrow.core.raise.ensureNotNull
import arrow.core.right
import beergame.application.AppFailure
import beergame.application.EventStore
import beergame.application.NewEvent
import beergame.application.PersistenceFailure
import beergame.application.StreamRead
import beergame.application.TransactionRunner
import beergame.application.Tx
import beergame.domain.ActorKind
import beergame.domain.ActorRef
import beergame.domain.DomainEvent
import beergame.domain.EventEnvelope
import beergame.domain.GameEvent
import beergame.domain.GameId
import beergame.domain.GuidedTour
import beergame.domain.KeyLandmark
import beergame.domain.StreamType
import beergame.domain.StreamVersion
import java.sql.ResultSet

/**
 * JDBC による EventStore。楽観的並行制御は、`uq_events_stream_version` の違反（ConcurrencyConflict）で行う（行や版のロックは取らない）。
 * 原子性は呼び出し側のトランザクション（[JdbcTransactionRunner]）が持つ。
 */
@KeyLandmark(
    map = "アプリケーションアーキテクチャ",
    layer = "副作用",
    description = "永続化の入口。application が定めた EventStore の約束を、データベースで満たす。規則は持たず、追記と読み出しだけを担う",
)
@GuidedTour(
    name = "イベントソーシング（事実が状態の正本）",
    rank = 5,
    stage = "事実を残す",
    description =
        "事実を events に追記する専用の入口。更新も削除もしない。" +
            "期待した版と違えば、版の一意制約が同時の更新を検出し、片方だけを通す",
)
@GuidedTour(
    name = "CQRS（コマンドと問い合わせの分離）",
    rank = 4,
    stage = "イベントと投影",
    description =
        "事実を events に追記する。ストリームごとの版の一意制約で、同時の更新のうち片方だけを通す。" +
            "追記した事実が、投影の元になる",
)
internal class JdbcEventStore(
    private val dialect: Dialect,
    private val runner: TransactionRunner,
) {
    fun port(): EventStore = EventStore(::read, ::append, runner)

    private val insertEventSql =
        "INSERT INTO events (event_id, game_id, stream_type, stream_version, event_type, schema_version, payload, " +
            "actor_kind, actor_id, correlation_id, command_id, occurred_at) " +
            "VALUES (?, ?, ?, ?, ?, ?, ${dialect.jsonParam}, ?, ?, ?, ?, ?)"

    private val selectEventsSql =
        "SELECT event_id, stream_version, event_type, schema_version, CAST(payload AS VARCHAR) AS payload_json, " +
            "actor_kind, actor_id, correlation_id, command_id, occurred_at " +
            "FROM events WHERE game_id = ? AND stream_type = ? ORDER BY stream_version"

    private fun read(
        tx: Tx,
        gameId: GameId,
        streamType: StreamType,
    ): Either<AppFailure, StreamRead> =
        tx.jdbc(OP_READ).flatMap { jdbcTx ->
            jdbcCall(OP_READ) {
                jdbcTx.connection.prepareStatement(selectEventsSql).use { ps ->
                    ps.params().uuid(gameId.value).string(streamType.name)
                    ps.executeQuery().use { rs -> readAll(rs, gameId, streamType) }
                }
            }
        }

    private fun readAll(
        rs: ResultSet,
        gameId: GameId,
        streamType: StreamType,
    ): Either<AppFailure, StreamRead> =
        either {
            var expected = StreamVersion.ZERO
            val events = mutableListOf<EventEnvelope<DomainEvent>>()
            while (rs.next()) {
                expected = expected.next()
                val actual = rs.getLong("stream_version")
                ensure(actual == expected.value) { failure(OP_READ, "ストリームの版に欠番がある: 期待 ${expected.value}、実際 $actual") }
                events += rs.toEnvelope(gameId, streamType, expected).bind()
            }
            StreamRead(events.toList(), expected)
        }

    private fun append(
        tx: Tx,
        expected: Map<StreamType, StreamVersion>,
        events: List<NewEvent>,
    ): Either<AppFailure, List<EventEnvelope<DomainEvent>>> =
        tx.jdbc(OP_APPEND).flatMap { jdbcTx ->
            val missing = events.map { it.streamType }.toSet() - expected.keys
            when {
                events.isEmpty() -> emptyList<EventEnvelope<DomainEvent>>().right()
                missing.isNotEmpty() -> failure(OP_APPEND, "期待する版が無いストリーム: $missing").left()
                else -> jdbcCall(OP_APPEND) { insertAll(jdbcTx, expected, events) }
            }
        }

    private fun insertAll(
        tx: JdbcTx,
        expected: Map<StreamType, StreamVersion>,
        events: List<NewEvent>,
    ): Either<AppFailure, List<EventEnvelope<DomainEvent>>> {
        events.filter { it.payload is GameEvent.GameCreated }.forEach { insertRoot(tx, it) }
        var versions = expected
        val envelopes = mutableListOf<EventEnvelope<DomainEvent>>()
        events.forEach { event ->
            val version = versions.getValue(event.streamType).next()
            versions = versions + (event.streamType to version)
            insertEvent(tx, event, version)
            envelopes += event.toEnvelope(version)
        }
        return envelopes.toList().right()
    }

    private fun insertRoot(
        tx: JdbcTx,
        event: NewEvent,
    ) {
        tx.connection.prepareStatement("INSERT INTO game_roots (game_id, created_at) VALUES (?, ?)").use { ps ->
            ps.params().uuid(event.gameId.value).instant(event.occurredAt)
            ps.executeUpdate()
        }
    }

    private fun insertEvent(
        tx: JdbcTx,
        event: NewEvent,
        version: StreamVersion,
    ) {
        val encoded = EventCodec.encode(event.payload)
        tx.connection.prepareStatement(insertEventSql).use { ps ->
            ps
                .params()
                .uuid(event.eventId)
                .uuid(event.gameId.value)
                .string(event.streamType.name)
                .long(version.value)
                .string(encoded.eventType)
                .int(encoded.schemaVersion)
                .string(encoded.payloadJson)
                .string(event.actor.kind.name)
                .uuid(event.actor.id)
                .uuid(event.correlationId)
                .uuid(event.commandId)
                .instant(event.occurredAt)
            ps.executeUpdate()
        }
    }

    private fun NewEvent.toEnvelope(version: StreamVersion): EventEnvelope<DomainEvent> =
        EventEnvelope(
            eventId = eventId,
            gameId = gameId,
            streamType = streamType,
            streamVersion = version,
            schemaVersion = EventCodec.CURRENT_SCHEMA_VERSION,
            actor = actor,
            correlationId = correlationId,
            commandId = commandId,
            occurredAt = occurredAt,
            payload = payload,
        )

    private fun failure(
        operation: String,
        message: String,
    ): AppFailure = AppFailure.Persistence(PersistenceFailure(operation, message))

    private companion object {
        const val OP_READ = "events.read"
        const val OP_APPEND = "events.append"
    }
}
