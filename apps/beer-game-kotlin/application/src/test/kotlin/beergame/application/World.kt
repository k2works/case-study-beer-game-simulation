package beergame.application

import arrow.core.Either
import arrow.core.left
import arrow.core.right
import beergame.domain.Actor
import beergame.domain.DomainEvent
import beergame.domain.EventEnvelope
import beergame.domain.GameEvent
import beergame.domain.GameId
import beergame.domain.ParticipantId
import beergame.domain.StreamType
import beergame.domain.StreamVersion
import io.kotest.assertions.fail
import kotlinx.coroutines.flow.emptyFlow
import java.time.Duration
import java.time.Instant
import java.util.UUID

/*
 * アプリケーション層の単体試験の道具。Ports を、メモリ上の世界（World）に差し替える。
 * 世界は、トランザクションの COMMIT / ROLLBACK を本物と同じ意味で持つ（Right なら反映、Left なら捨てる）。
 * 試験の補助なので、可変の状態を持つ（本番コードの規約の対象外）。
 */

val T0: Instant = Instant.parse("2026-11-16T09:00:00Z")

val CORRELATION: UUID = UUID(9L, 9L)

fun testSettings(maxAttempts: Int = 3): AppSettings =
    AppSettings(
        maxAttempts = maxAttempts,
        idempotencyTtl = Duration.ofHours(24),
        participantCredentialTtl = Duration.ofDays(30),
        credentialKeyVersion = 1,
        idempotencySecret = ByteArray(32) { it.toByte() },
        credentialSecret = ByteArray(32) { (it + 7).toByte() },
    )

fun meta(
    key: String,
    credential: String? = null,
): RequestMeta = RequestMeta(key, credential, CORRELATION)

fun <A> Either<*, A>.ok(): A =
    when (this) {
        is Either.Right -> value
        is Either.Left -> fail("Left だった: $value")
    }

fun <B> Either<B, *>.err(): B =
    when (this) {
        is Either.Left -> value
        is Either.Right -> fail("Right だった: $value")
    }

/** Left の AppFailure.Domain の、業務エラーの code。 */
fun Either<AppFailure, *>.domainCode(): String =
    when (val failure = err()) {
        is AppFailure.Domain -> failure.error.code
        else -> fail("業務のエラーではない: $failure")
    }

data class IdempotencyId(
    val gameId: GameId?,
    val scope: String,
    val keyDigest: String,
)

private fun IdempotencyKey.id(): IdempotencyId = IdempotencyId(if (isCreate) null else gameId, scope, keyDigest)

data class CredentialRow(
    val gameId: GameId,
    val kind: CredentialKind,
    val subjectId: UUID,
    val keyVersion: Int,
    val issuedAt: Instant,
    val expiresAt: Instant,
    val revoked: Boolean,
) {
    fun isValidAt(now: Instant): Boolean = !revoked && expiresAt > now
}

/** 世界の中身（COMMIT された状態）。不変で、トランザクションごとにコピーして書く。 */
data class Store(
    val streams: Map<Pair<GameId, StreamType>, List<EventEnvelope<DomainEvent>>> = emptyMap(),
    val projected: List<EventEnvelope<DomainEvent>> = emptyList(),
    val idempotency: Map<IdempotencyId, StoredResponse> = emptyMap(),
    val credentials: Map<String, CredentialRow> = emptyMap(),
    val browserSessions: Map<String, Pair<GameId, Instant>> = emptyMap(),
    val displayNames: Map<ParticipantId, String> = emptyMap(),
    val joinCodes: Map<String, GameId> = emptyMap(),
    val notices: List<VersionNotice> = emptyList(),
) {
    fun events(
        gameId: GameId,
        stream: StreamType,
    ): List<EventEnvelope<DomainEvent>> = streams[gameId to stream].orEmpty()

    inline fun <reified E : DomainEvent> payloads(
        gameId: GameId,
        stream: StreamType,
    ): List<E> = events(gameId, stream).map { it.payload }.filterIsInstance<E>()
}

class FakeTx(
    var store: Store,
) : Tx

private fun Tx.fake(): FakeTx = this as? FakeTx ?: fail("FakeTx ではない")

class World(
    val settings: AppSettings = testSettings(),
) {
    /** ポートの呼び出しの順（ROLLBACK で消えない）。 */
    val calls = mutableListOf<String>()

    var store: Store = Store()
        private set

    var clock: Instant = T0

    /** 追記を、この回数だけ ConcurrencyConflict で失敗させる。 */
    var conflictsToInject = 0
    var failProjection = false
    var failPeripheral = false
    var lockResult: Either<AppFailure, Unit> = Unit.right()

    /** 最初の冪等記録の検索だけ、記録があっても見つからないことにする（同時の重複を、別の要求が先に保存した場面の再現）。 */
    var hideNextIdempotencyFind = false

    /** 問い合わせの試験が、投影から読んだことにする行。 */
    var projectedGame: ProjectedGame? = null

    private var idCounter = 0L
    private var credentialCounter = 0
    private var joinCodeCounter = 0

    private val runner =
        object : TransactionRunner {
            override suspend operator fun <A> invoke(
                block: suspend (Tx) -> Either<AppFailure, A>,
            ): Either<AppFailure, A> {
                calls += "tx.begin"
                val tx = FakeTx(store)
                val result = block(tx)
                if (result.isRight()) {
                    store = tx.store
                    calls += "tx.commit"
                } else {
                    calls += "tx.rollback"
                }
                return result
            }
        }

    private fun persistence(message: String): AppFailure = AppFailure.Persistence(PersistenceFailure("fake", message))

    private val eventStore =
        EventStore(
            read = { tx, gameId, stream ->
                calls += "events.read"
                val events = tx.fake().store.events(gameId, stream)
                StreamRead(events, versionOf(events)).right()
            },
            append = { tx, expected, newEvents ->
                calls += "events.append"
                val fake = tx.fake()
                if (conflictsToInject > 0) {
                    conflictsToInject--
                    AppFailure.ConcurrencyConflict.left()
                } else {
                    val stale =
                        expected.any { (stream, version) ->
                            newEvents.firstOrNull { it.streamType == stream }?.let { event ->
                                versionOf(fake.store.events(event.gameId, stream)) != version
                            } ?: false
                        }
                    if (stale) {
                        AppFailure.ConcurrencyConflict.left()
                    } else {
                        val envelopes = envelopesOf(expected, newEvents)
                        fake.store =
                            envelopes.fold(fake.store) { acc, e ->
                                val key = e.gameId to e.streamType
                                acc.copy(streams = acc.streams + (key to (acc.streams[key].orEmpty() + e)))
                            }
                        envelopes.right()
                    }
                }
            },
            transaction = runner,
        )

    private fun versionOf(events: List<EventEnvelope<DomainEvent>>): StreamVersion =
        events.lastOrNull()?.streamVersion ?: StreamVersion.ZERO

    private fun envelopesOf(
        expected: Map<StreamType, StreamVersion>,
        newEvents: List<NewEvent>,
    ): List<EventEnvelope<DomainEvent>> {
        val next = expected.toMutableMap()
        return newEvents.map { e ->
            val version = (next[e.streamType] ?: StreamVersion.ZERO).next()
            next[e.streamType] = version
            EventEnvelope(
                eventId = e.eventId,
                gameId = e.gameId,
                streamType = e.streamType,
                streamVersion = version,
                schemaVersion = 1,
                actor = e.actor,
                correlationId = e.correlationId,
                commandId = e.commandId,
                occurredAt = e.occurredAt,
                payload = e.payload,
            )
        }
    }

    private val projectionWriter =
        ProjectionWriter { tx, _, events ->
            calls += "project.write"
            if (failProjection) {
                persistence("投影の失敗").left()
            } else {
                val fake = tx.fake()
                val codes =
                    events.mapNotNull { e ->
                        (e.payload as? GameEvent.GameCreated)?.let { it.joinCode.value to e.gameId }
                    }
                fake.store =
                    fake.store.copy(projected = fake.store.projected + events, joinCodes = fake.store.joinCodes + codes)
                Unit.right()
            }
        }

    private val idempotencyStore =
        IdempotencyStore(
            find = { tx, key, now ->
                calls += "idempotency.find"
                if (hideNextIdempotencyFind) {
                    hideNextIdempotencyFind = false
                    (null as StoredResponse?).right()
                } else {
                    tx
                        .fake()
                        .store.idempotency[key.id()]
                        ?.takeIf { it.expiresAt > now }
                        .right()
                }
            },
            save = { tx, key, response, _ ->
                calls += "idempotency.save"
                val fake = tx.fake()
                if (key.id() in fake.store.idempotency) {
                    AppFailure.ConcurrencyConflict.left()
                } else {
                    fake.store = fake.store.copy(idempotency = fake.store.idempotency + (key.id() to response))
                    Unit.right()
                }
            },
        )

    private val peripheralStore =
        PeripheralStore(
            write = { tx, writes ->
                calls += "peripheral.write"
                if (failPeripheral) {
                    persistence("周辺ストアの失敗").left()
                } else {
                    val fake = tx.fake()
                    fake.store = writes.fold(fake.store, ::applyWrite)
                    Unit.right()
                }
            },
            authenticate = { tx, digest, now ->
                calls += "authenticate"
                val row = tx.fake().store.credentials[digest]
                val session = tx.fake().store.browserSessions[digest]
                row
                    ?.takeIf { it.isValidAt(now) && session != null && session.second > now }
                    ?.let { VerifiedCredential(it.gameId, actorOf(it)) }
                    .right()
            },
            findGameByJoinCode = { tx, code ->
                calls += "findGameByJoinCode"
                tx
                    .fake()
                    .store.joinCodes[code.value]
                    .right()
            },
        )

    private fun actorOf(row: CredentialRow): Actor =
        when (row.kind) {
            CredentialKind.FACILITATOR -> Actor.Facilitator(row.gameId)
            CredentialKind.PARTICIPANT_RECOVERY -> Actor.Participant(ParticipantId(row.subjectId))
        }

    private fun applyWrite(
        store: Store,
        write: PeripheralWrite,
    ): Store =
        when (write) {
            is PeripheralWrite.SaveDisplayName -> {
                store.copy(displayNames = store.displayNames + (write.participantId to write.name.value))
            }

            is PeripheralWrite.IssueCredentialRow -> {
                store.copy(
                    credentials =
                        store.credentials +
                            (
                                write.digest to
                                    CredentialRow(
                                        write.gameId,
                                        write.kind,
                                        write.subjectId,
                                        write.keyVersion,
                                        write.issuedAt,
                                        write.expiresAt,
                                        false,
                                    )
                            ),
                    browserSessions = store.browserSessions + (write.digest to (write.gameId to write.expiresAt)),
                )
            }
        }

    private val notifier =
        ChangeNotifier(
            publish = { tx, notices ->
                calls += "notifier.publish"
                val fake = tx.fake()
                fake.store = fake.store.copy(notices = fake.store.notices + notices)
                Unit.right()
            },
            subscribe = { emptyFlow() },
            isAlive = { true },
        )

    private val lock =
        ProjectionLock(
            acquireShared = { _, _ ->
                calls += "lock.shared"
                lockResult
            },
            acquireExclusive = { _, _ -> Unit.right() },
        )

    val ports: Ports =
        Ports(
            generators =
                Generators(
                    now = { clock },
                    newId = { UUID(0L, ++idCounter) },
                    newCredential = { "RAW-CREDENTIAL-" + (++credentialCounter).toString().padStart(6, '0') },
                    newJoinCode = { "JOIN-" + (++joinCodeCounter).toString().padStart(4, '0') },
                ),
            stores =
                Stores(
                    events = eventStore,
                    project = projectionWriter,
                    idempotency = idempotencyStore,
                    peripheral = peripheralStore,
                    reader =
                        ProjectionReader {
                            calls += "reader.read"
                            projectedGame.right()
                        },
                ),
            lock = lock,
            notifier = notifier,
            settings = settings,
        )

    /** 資格を失効させる（役割の入れ替えで旧担当者の資格が失効する場面）。 */
    fun revoke(rawCredential: String) {
        val digest = CredentialDigest.of(settings.credentialSecret, rawCredential)
        val row = store.credentials[digest] ?: fail("資格が無い")
        store = store.copy(credentials = store.credentials + (digest to row.copy(revoked = true)))
    }

    fun clearCalls() = calls.clear()
}
