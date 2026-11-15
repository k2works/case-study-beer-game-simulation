package beergame.application

import arrow.core.Either
import arrow.core.left
import arrow.core.right
import beergame.domain.Actor
import beergame.domain.CredentialSubject
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

val CREDENTIAL_KEY_V1 = ByteArray(32) { (it + 7).toByte() }
val CREDENTIAL_KEY_V2 = ByteArray(32) { (it + 11).toByte() }

/** 版 1 だけの鍵束（B1 までと同じ）。 */
fun keyRing(
    current: Int = 1,
    vararg keys: Pair<Int, ByteArray> = arrayOf(1 to CREDENTIAL_KEY_V1),
): CredentialKeyRing = CredentialKeyRing.of(current, keys.toMap()).ok()

/** 参加・復帰の失敗の窓（試験用の小さい値）。窓は 10 分で、時刻（[T0]）は窓の境界に合っている。 */
val TEST_ATTEMPT_POLICY: AttemptPolicy = AttemptPolicy.of(maxFailures = 3, window = Duration.ofMinutes(10)).ok()

fun testSettings(
    maxAttempts: Int = 3,
    credentialKeys: CredentialKeyRing = keyRing(),
    attempts: AttemptPolicy = TEST_ATTEMPT_POLICY,
): AppSettings =
    AppSettings(
        maxAttempts = maxAttempts,
        ttls = AppTtls(Duration.ofHours(24), Duration.ofHours(24), Duration.ofDays(30)),
        idempotencySecret = ByteArray(32) { it.toByte() },
        credentialKeys = credentialKeys,
        attempts = attempts,
    )

fun meta(
    key: String,
    credential: String? = null,
    source: AttemptSource? = null,
): RequestMeta = RequestMeta(key, credential, CORRELATION, source)

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

/** `credentials` の行（復帰資格）。 */
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

/** `browser_sessions` の行（ブラウザセッション。復帰資格とは別のダイジェスト）。 */
data class SessionRow(
    val gameId: GameId,
    val kind: CredentialKind,
    val subjectId: UUID,
    val keyVersion: Int,
    val expiresAt: Instant,
)

/** 世界の中身（COMMIT された状態）。不変で、トランザクションごとにコピーして書く。 */
data class Store(
    val streams: Map<Pair<GameId, StreamType>, List<EventEnvelope<DomainEvent>>> = emptyMap(),
    val projected: List<EventEnvelope<DomainEvent>> = emptyList(),
    val idempotency: Map<IdempotencyId, StoredResponse> = emptyMap(),
    val credentials: Map<String, CredentialRow> = emptyMap(),
    val browserSessions: Map<String, SessionRow> = emptyMap(),
    val displayNames: Map<ParticipantId, String> = emptyMap(),
    val joinCodes: Map<String, GameId> = emptyMap(),
    val notices: List<VersionNotice> = emptyList(),
    /** 参加・復帰の窓ごとの失敗の数（`participation_attempts`）。 */
    val attempts: Map<AttemptWindow, Int> = emptyMap(),
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
    initialSettings: AppSettings = testSettings(),
) {
    /** 鍵の更新（ローテーション）の試験のために、設定は差し替えられる。 */
    var settings: AppSettings = initialSettings

    /** ポートの呼び出しの順（ROLLBACK で消えない）。 */
    val calls = mutableListOf<String>()

    var store: Store = Store()
        private set

    var clock: Instant = T0

    /** 追記を、この回数だけ ConcurrencyConflict で失敗させる。 */
    var conflictsToInject = 0
    var failProjection = false
    var failPeripheral = false

    /** 窓の保存（charge）を、永続化の失敗にする。 */
    var failAttempts = false
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
                tx
                    .fake()
                    .store.browserSessions[digest]
                    ?.takeIf { it.expiresAt > now }
                    ?.let { VerifiedCredential(it.gameId, actorOf(it.gameId, it.kind, it.subjectId)) }
                    .right()
            },
            authenticateRecovery = { tx, digest, now ->
                calls += "authenticateRecovery"
                tx
                    .fake()
                    .store.credentials[digest]
                    ?.takeIf { it.isValidAt(now) }
                    ?.let { VerifiedRecovery(it.gameId, actorOf(it.gameId, it.kind, it.subjectId), it.expiresAt) }
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

    private val attemptStore =
        AttemptStore(
            charge = { tx, window ->
                calls += "attempts.charge"
                if (failAttempts) {
                    persistence("窓の保存の失敗").left()
                } else {
                    val fake = tx.fake()
                    val next = (fake.store.attempts[window] ?: 0) + 1
                    fake.store = fake.store.copy(attempts = fake.store.attempts + (window to next))
                    next.right()
                }
            },
            refund = { tx, window ->
                calls += "attempts.refund"
                val fake = tx.fake()
                val next = ((fake.store.attempts[window] ?: 0) - 1).coerceAtLeast(0)
                fake.store = fake.store.copy(attempts = fake.store.attempts + (window to next))
                Unit.right()
            },
            purge = { tx, before ->
                calls += "attempts.purge"
                val fake = tx.fake()
                fake.store = fake.store.copy(attempts = fake.store.attempts.filterKeys { it.start >= before })
                Unit.right()
            },
        )

    private fun actorOf(
        gameId: GameId,
        kind: CredentialKind,
        subjectId: UUID,
    ): Actor =
        when (kind) {
            CredentialKind.FACILITATOR -> Actor.Facilitator(gameId)
            CredentialKind.PARTICIPANT_RECOVERY -> Actor.Participant(ParticipantId(subjectId))
        }

    private fun applyWrite(
        store: Store,
        write: PeripheralWrite,
    ): Store =
        when (write) {
            is PeripheralWrite.SaveDisplayName -> {
                store.copy(displayNames = store.displayNames + (write.participantId to write.name.value))
            }

            is PeripheralWrite.IssueRecoveryRow -> {
                val row =
                    CredentialRow(
                        write.gameId,
                        write.kind,
                        write.subjectId,
                        write.keyVersion,
                        write.issuedAt,
                        write.expiresAt,
                        false,
                    )
                store.copy(credentials = store.credentials + (write.digest to row))
            }

            is PeripheralWrite.IssueSessionRow -> {
                val row = SessionRow(write.gameId, write.kind, write.subjectId, write.keyVersion, write.expiresAt)
                store.copy(browserSessions = store.browserSessions + (write.digest to row))
            }

            is PeripheralWrite.ExtendRecoveryRow -> {
                store.copy(
                    credentials =
                        store.credentials.mapValues { (digest, row) ->
                            if (digest == write.digest && !row.revoked) row.copy(expiresAt = write.expiresAt) else row
                        },
                )
            }

            is PeripheralWrite.RevokeSubject -> {
                val subjectId = write.subject.rowId()
                store.copy(
                    credentials =
                        store.credentials.mapValues { (_, row) ->
                            val target = row.gameId == write.gameId && row.subjectId == subjectId
                            if (target) row.copy(revoked = true) else row
                        },
                    browserSessions =
                        store.browserSessions.filterValues {
                            !(it.gameId == write.gameId && it.subjectId == subjectId)
                        },
                )
            }
        }

    private fun CredentialSubject.rowId(): UUID =
        when (this) {
            is CredentialSubject.Facilitator -> gameId.value
            is CredentialSubject.Participant -> id.value
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

    /** 呼ぶたびに現在の設定（[settings]）で組み立てる。ポートの関数は、この世界の状態を見る。 */
    val ports: Ports
        get() = Ports(generators, stores, lock, notifier, settings)

    private val generators =
        Generators(
            now = { clock },
            newId = { UUID(0L, ++idCounter) },
            newCredential = { "RAW-CREDENTIAL-" + (++credentialCounter).toString().padStart(6, '0') },
            newJoinCode = { "JOIN-" + (++joinCodeCounter).toString().padStart(4, '0') },
        )

    private val stores =
        Stores(
            events = eventStore,
            project = projectionWriter,
            idempotency = idempotencyStore,
            peripheral = peripheralStore,
            attempts = attemptStore,
            reader =
                ProjectionReader {
                    calls += "reader.read"
                    projectedGame.right()
                },
        )

    fun clearCalls() = calls.clear()
}
