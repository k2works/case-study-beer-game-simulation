package beergame.persistence

import arrow.core.raise.either
import beergame.application.AppFailure
import beergame.application.VersionNotice
import beergame.domain.GameId
import beergame.domain.StreamType
import beergame.domain.StreamVersion
import io.kotest.core.spec.style.FunSpec
import io.kotest.matchers.collections.shouldContain
import io.kotest.matchers.shouldBe
import io.kotest.matchers.string.shouldContain
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeout
import java.util.UUID

private const val EVENTUALLY_MILLIS = 15_000L

private suspend fun eventually(
    timeoutMillis: Long = EVENTUALLY_MILLIS,
    condition: suspend () -> Boolean,
): Boolean {
    val deadline = System.nanoTime() + timeoutMillis * 1_000_000
    while (System.nanoTime() < deadline) {
        if (condition()) return true
        delay(20)
    }
    return false
}

/**
 * PostgreSQL 18（Testcontainers）での検証。ここが検証の正。
 * 共通の契約（H2 と同じ内容）に加えて、PostgreSQL 固有の挙動（部分一意索引、実際の並行、アドバイザリロック、LISTEN の再接続）を確かめる。
 */
class PostgresPersistenceSpec :
    FunSpec({
        lateinit var fx: Fixture
        beforeSpec {
            fx =
                openFixture(
                    Dialect.POSTGRES,
                    PostgresSupport.dataSource(),
                    PostgresSupport.listenConnection(),
                    lockTimeoutMillis = 300,
                    listenReconnectMillis = 300,
                )
        }
        afterSpec { fx.close() }

        test(
            "[7.2] Given 空の PostgreSQL When マイグレーションを適用する Then jsonb の列と部分一意索引 uq_idempotency_create ができ、再適用しても変わらない",
        ) {
            fx.query(
                "SELECT data_type FROM information_schema.columns " +
                    "WHERE table_name = 'events' AND column_name = 'payload'",
            ) { it.getString(1) } shouldBe listOf("jsonb")
            val index =
                fx
                    .query("SELECT indexdef FROM pg_indexes WHERE indexname = 'uq_idempotency_create'") {
                        it.getString(1)
                    }.single()
            index shouldContain "UNIQUE"
            index shouldContain "WHERE"
            Migrations.migrate(fx.dataSource, Dialect.POSTGRES) shouldBe 0
        }

        test("[7.1] Given トランザクション When 分離レベルを見る Then READ COMMITTED") {
            val level = mutableListOf<String>()
            fx
                .tx { tx ->
                    either<AppFailure, Unit> {
                        (tx as JdbcTx).connection.createStatement().use { st ->
                            st.executeQuery("SHOW transaction_isolation").use { rs ->
                                rs.next()
                                level += rs.getString(1)
                            }
                        }
                    }
                }.orFail()
            level shouldBe listOf("read committed")
        }

        test("[7.1] Given 同じ版を期待する 8 つの同時の追記 When 実際に並行して追記する Then 1 つだけが成功し、残りは ConcurrencyConflict") {
            val script = GameScript().create()
            fx.appendScript(script, project = false)
            val participant = script.join()
            script.assign(participant, beergame.domain.Role.RETAILER)
            val base = script.gameEvents.drop(1)
            val gate = CompletableDeferred<Unit>()

            val results =
                coroutineScope {
                    (1..8)
                        .map {
                            async(Dispatchers.Default) {
                                gate.await()
                                val own = base.map { e -> e.copy(eventId = UUID.randomUUID()) }
                                fx.tx { tx ->
                                    fx.persistence.events.append(
                                        tx,
                                        mapOf(StreamType.GAME to StreamVersion.of(1).orFail()),
                                        own,
                                    )
                                }
                            }
                        }.also { gate.complete(Unit) }
                        .awaitAll()
                }

            results.count { it.isRight() } shouldBe 1
            results.filter { it.isLeft() }.map { it.leftOrFail() }.toSet() shouldBe
                setOf(AppFailure.ConcurrencyConflict)
            fx.readStream(script, StreamType.GAME).version.value shouldBe (1L + base.size)
        }

        test("[7.4] Given 別のプール（別のプロセスを模す）が共有を保持 When 排他を取る Then アドバイザリロックで待たされ RetryExhausted") {
            val other =
                openFixture(
                    Dialect.POSTGRES,
                    PostgresSupport.dataSource(2),
                    PostgresSupport.listenConnection(),
                    lockTimeoutMillis = 300,
                )
            val game = GameId(UUID.randomUUID())
            try {
                coroutineScope {
                    val acquired = CompletableDeferred<Unit>()
                    val release = CompletableDeferred<Unit>()
                    val holder =
                        async(Dispatchers.Default) {
                            other.tx { tx ->
                                either {
                                    other.persistence.lock
                                        .acquireShared(tx, game)
                                        .bind()
                                    acquired.complete(Unit)
                                    release.await()
                                }
                            }
                        }
                    acquired.await()

                    val exclusive = fx.tx { tx -> fx.persistence.lock.acquireExclusive(tx, game) }

                    exclusive.leftOrFail() shouldBe AppFailure.RetryExhausted
                    release.complete(Unit)
                    holder.await().orFail()
                }
            } finally {
                other.close()
            }
        }

        test("[7.5] Given LISTEN の接続が強制切断された When 再接続を待つ Then isAlive は一度 false になり、true に戻り、通知がまた届く（プロセスは落ちない）") {
            val game = GameId(UUID.randomUUID())
            val sink = Channel<VersionNotice>(Channel.UNLIMITED)
            coroutineScope {
                val subscriber =
                    launch(Dispatchers.Default) {
                        fx.persistence.notifier
                            .subscribe()
                            .collect { sink.send(it) }
                    }
                delay(200)
                fx.persistence.notifier.isAlive() shouldBe true

                fx.query(
                    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = ?",
                    PostgresSupport.LISTEN_APPLICATION_NAME,
                ) { it.getBoolean(1) }

                eventually { !fx.persistence.notifier.isAlive() } shouldBe true
                eventually { fx.persistence.notifier.isAlive() } shouldBe true
                fx
                    .tx { tx ->
                        either {
                            fx.persistence.notifier
                                .publish(
                                    tx,
                                    listOf(VersionNotice(game, StreamType.SESSION, StreamVersion.of(5).orFail())),
                                ).mapLeft { AppFailure.Persistence(it) }
                                .bind()
                        }
                    }.orFail()
                withTimeout(EVENTUALLY_MILLIS) { sink.receive() }.version.value shouldBe 5
                subscriber.cancelAndJoin()
            }
        }

        eventStoreContract { fx }
        transactionContract { fx }
        projectionContract { fx }
        idempotencyContract { fx }
        projectionLockContract { fx }
        changeNotifierContract { fx }

        test("[7.1] 確認: テスト用の PostgreSQL は postgres:18 である") {
            fx.query("SHOW server_version") { it.getString(1) }.single().substringBefore('.') shouldBe "18"
            listOf("beergame_test") shouldContain fx.query("SELECT current_database()") { it.getString(1) }.single()
        }
    })
