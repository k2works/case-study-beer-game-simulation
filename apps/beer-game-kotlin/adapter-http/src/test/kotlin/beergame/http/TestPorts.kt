package beergame.http

import arrow.core.Either
import beergame.application.AppFailure
import beergame.application.AppSettings
import beergame.application.ChangeNotifier
import beergame.application.EventStore
import beergame.application.Generators
import beergame.application.IdempotencyStore
import beergame.application.PeripheralStore
import beergame.application.Ports
import beergame.application.ProjectionLock
import beergame.application.ProjectionReader
import beergame.application.ProjectionWriter
import beergame.application.Stores
import beergame.application.TransactionRunner
import beergame.application.Tx
import kotlinx.coroutines.flow.emptyFlow
import java.time.Duration
import java.time.Instant
import java.util.UUID

/*
 * HTTP の層だけを確かめる試験の道具。永続化は無い（呼ばれたら失敗する）ので、application に届く前の振る舞い
 * （検証、Origin、サイズ、ヘッダー、ヘルスチェック、ログ）だけを確かめる。実 DB を通す試験は app にある。
 */

val FIXED_NOW: Instant = Instant.parse("2026-11-16T09:00:00Z")

class UnexpectedPortCall(
    name: String,
) : RuntimeException("ポート $name が呼ばれた（この試験では呼ばれないはず）")

private fun unreachable(name: String): Nothing = throw UnexpectedPortCall(name)

private object NoTx : TransactionRunner {
    override suspend fun <A> invoke(block: suspend (Tx) -> Either<AppFailure, A>): Either<AppFailure, A> =
        unreachable("transaction")
}

fun stubPorts(
    notifierAlive: Boolean = true,
    newId: suspend () -> UUID = { unreachable("newId") },
): Ports =
    Ports(
        generators =
            Generators(
                now = { FIXED_NOW },
                newId = newId,
                newCredential = { unreachable("newCredential") },
                newJoinCode = { unreachable("newJoinCode") },
            ),
        stores =
            Stores(
                events =
                    EventStore(
                        read = { _, _, _ -> unreachable("events.read") },
                        append = { _, _, _ -> unreachable("events.append") },
                        transaction = NoTx,
                    ),
                project = ProjectionWriter { _, _, _ -> unreachable("project") },
                idempotency =
                    IdempotencyStore(
                        find = { _, _, _ -> unreachable("idempotency.find") },
                        save = { _, _, _, _ -> unreachable("idempotency.save") },
                    ),
                peripheral =
                    PeripheralStore(
                        write = { _, _ -> unreachable("peripheral.write") },
                        authenticate = { _, _, _ -> unreachable("peripheral.authenticate") },
                        findGameByJoinCode = { _, _ -> unreachable("peripheral.findGameByJoinCode") },
                    ),
                reader = ProjectionReader { unreachable("reader") },
            ),
        lock =
            ProjectionLock(
                acquireShared = { _, _ -> unreachable("lock.shared") },
                acquireExclusive = { _, _ -> unreachable("lock.exclusive") },
            ),
        notifier =
            ChangeNotifier(
                publish = { _, _ -> unreachable("notifier.publish") },
                subscribe = { emptyFlow() },
                isAlive = { notifierAlive },
            ),
        settings =
            AppSettings(
                maxAttempts = 3,
                idempotencyTtl = Duration.ofHours(24),
                participantCredentialTtl = Duration.ofDays(30),
                credentialKeyVersion = 1,
                idempotencySecret = ByteArray(32) { it.toByte() },
                credentialSecret = ByteArray(32) { (it + 7).toByte() },
            ),
    )

/** 出力されたログを集める。 */
class CapturingLogSink : LogSink {
    private val records = java.util.concurrent.CopyOnWriteArrayList<LogRecord>()

    override fun emit(record: LogRecord) {
        records += record
    }

    fun all(): List<LogRecord> = records.toList()
}

fun testSettings(
    rateLimitPerMinute: Int = 10_000,
    allowedOrigins: Set<String> = setOf("http://localhost:5173"),
): HttpSettings =
    HttpSettings(
        allowedOrigins = allowedOrigins,
        cookieSecure = false,
        rateLimitPerMinute = rateLimitPerMinute,
    )
