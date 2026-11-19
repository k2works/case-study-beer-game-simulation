package beergame.persistence

import arrow.core.Either
import arrow.core.flatMap
import beergame.application.AppFailure
import beergame.application.CommandOutcome
import beergame.application.EventStore
import beergame.application.Ports
import beergame.application.ProjectionLock
import beergame.application.SaveDecisionInput
import beergame.application.TransactionRunner
import beergame.application.Tx
import beergame.application.saveDecision
import beergame.domain.GameId
import beergame.domain.Role
import beergame.domain.SessionError
import io.kotest.core.spec.style.FunSpec
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import java.io.File
import java.util.concurrent.atomic.AtomicInteger
import kotlin.random.Random

/*
 * B6 Step 5: `RetryExhausted` の発生率の計測の道具（R4。判断項目 10〜12）。**テスト用の道具で、`main` には何も入れない。**
 * 環境変数 `BEERGAME_MEASURE=1` のときだけ実行する（既定では実行しない。CI では実行しない）。
 * 結果は標準出力と `build/reports/retry-measurement.md`。**ローカルの PostgreSQL（Testcontainers）の値で、実環境の値ではない。**
 *
 * 計測の設計（先に決めたもの）:
 * - 試行（variant）: 再試行の上限 3・5・10 × 再試行の前の間隔（なし・0〜20 ms のジッター）、と、ゲーム単位の書き込み用ロックの試作。
 *   間隔は、再試行のトランザクションを始める前（トランザクションの外）に入れる。ロックの試作は、既存の共有ロックの取得に続けて
 *   別のキーのアドバイザリロック（トランザクションの終了で解放）を取る。いずれもこの道具の中だけ。
 * - 数えるもの: 結果（成功・同じ役割の競合（業務上の期待どおりの失敗）・再試行の枯渇・その他）、試行回数、遅延。
 * - 合格の基準: S1（4 人同時の保存）で `RetryExhausted` 0 件（リリース計画）。S2 の保存の p95 が 1 秒以下（NF-P13）。
 *   S3（15 ゲーム × 4 役割を 10 秒の窓で）のエラー率（枯渇・その他）が 1% 未満（NF-C2）。
 * - 標本が少ない（200 未満）ときは、p95・p99 を言わず、最大値を示す。
 */

private data class Variant(
    val label: String,
    val maxAttempts: Int,
    val jitterMillis: Long,
    val serialize: Boolean,
)

private enum class Result { OK, DOMAIN_CONFLICT, RETRY_EXHAUSTED, OTHER }

private class Sample(
    val millis: Long,
    val result: Result,
    val attempts: Int,
)

private typealias MeasuredCommand = suspend (Ports) -> Either<AppFailure, CommandOutcome>

private const val WRITE_LOCK_SALT = 0x5A5A5A5AL
private const val PERCENTILE_MIN_SAMPLES = 200
private const val S3_WINDOW_MILLIS = 10_000L
private const val ITERATIONS = 9

private class Probe(
    val jitterMillis: Long,
) {
    val attempts = AtomicInteger()
}

/** 1 つのコマンドの試行（トランザクション）の回数を数え、再試行の前（トランザクションの外）に間隔を入れる。 */
private fun EventStore.probed(probe: Probe): EventStore {
    val original = transaction
    return copy(
        transaction =
            object : TransactionRunner {
                override suspend operator fun <A> invoke(
                    block: suspend (Tx) -> Either<AppFailure, A>,
                ): Either<AppFailure, A> {
                    if (probe.attempts.getAndIncrement() > 0 && probe.jitterMillis > 0) {
                        delay(Random.nextLong(probe.jitterMillis + 1))
                    }
                    return original(block)
                }
            },
    )
}

/** ゲーム単位の書き込み用ロックの試作（計測の道具の中だけ）。既存の共有ロックに続けて、別のキーのアドバイザリロックを取る。 */
private fun ProjectionLock.withWriteSerialization(): ProjectionLock =
    copy(
        acquireShared = { tx, game -> acquireShared(tx, game).flatMap { writeLock(tx, game) } },
    )

private fun writeLock(
    tx: Tx,
    game: GameId,
): Either<AppFailure, Unit> =
    tx.jdbc("measure-write-lock").flatMap { jdbcTx ->
        jdbcCall("measure-write-lock") {
            jdbcTx.connection.prepareStatement("SELECT pg_advisory_xact_lock(?)").use { ps ->
                ps.setLong(1, game.value.mostSignificantBits xor WRITE_LOCK_SALT)
                ps.execute()
            }
            Either.Right(Unit)
        }
    }

private fun classify(result: Either<AppFailure, *>): Result =
    when {
        result.isRight() -> {
            Result.OK
        }

        else -> {
            val failure = result.leftOrNull()
            when {
                failure is AppFailure.Domain && failure.error is SessionError.DecisionConflict -> Result.DOMAIN_CONFLICT
                failure == AppFailure.RetryExhausted -> Result.RETRY_EXHAUSTED
                else -> Result.OTHER
            }
        }
    }

private suspend fun Fixture.measured(
    variant: Variant,
    command: MeasuredCommand,
): Sample {
    val probe = Probe(variant.jitterMillis)
    val lock = if (variant.serialize) persistence.lock.withWriteSerialization() else persistence.lock
    val ports = ports(persistence.events.probed(probe), variant.maxAttempts, lock)
    val start = System.nanoTime()
    val outcome = command(ports)
    return Sample((System.nanoTime() - start) / NANOS_PER_MILLI, classify(outcome), probe.attempts.get())
}

private const val NANOS_PER_MILLI = 1_000_000L

private fun saveCommand(
    game: Started,
    credential: String,
    key: String,
    role: Role,
    expected: Long,
): MeasuredCommand =
    { ports ->
        ports.saveDecision(game.gameId, SaveDecisionInput(role, 1, 4, expected), meta(key, credential))
    }

private fun Fixture.currentVersion(
    game: Started,
    role: Role,
): Long =
    query(
        "SELECT decision_version FROM current_decisions WHERE game_id = ? AND role = ?",
        game.gameId.value,
        role.name,
    ) {
        it.getLong(1)
    }.singleOrNull() ?: 0L

/** 型推論で suspend のラムダにするための包み。 */
private fun writer(block: suspend () -> Sample): suspend () -> Sample = block

/** [writers] を同時に走らせる（全員がそろってから始める）。 */
private fun runTogether(writers: List<suspend () -> Sample>): List<Sample> =
    runBlocking {
        val go = CompletableDeferred<Unit>()
        val running =
            writers.map { writer ->
                async {
                    go.await()
                    writer()
                }
            }
        go.complete(Unit)
        running.awaitAll()
    }

/** 反復（版の番号 0〜8）ごとに、[build] が返す書き手を同時に走らせて、標本を集める。 */
private fun runIterations(build: (Int) -> List<suspend () -> Sample>): List<Sample> =
    buildList { repeat(ITERATIONS) { addAll(runTogether(build(it))) } }

/** S1: 1 ゲーム・4 役割が同時に保存。各反復は、同じ版（反復の番号）から 4 役割が同時に保存する。 */
private fun Fixture.scenarioFourRoles(
    variant: Variant,
    games: Int,
    tag: String,
): List<Sample> =
    (1..games).flatMap { g ->
        val game = start("$tag-s1-$g")
        runIterations { i ->
            Role.entries.map { role ->
                writer {
                    measured(
                        variant,
                        saveCommand(
                            game,
                            game.seats[role].credential,
                            "$tag-s1-$g-$i-${role.name}",
                            role,
                            i.toLong(),
                        ),
                    )
                }
            }
        }
    }

/** S2: 小売店に 4 人の共同担当 + 他の 3 役割（計 7 人）が、同じ版から同時に保存。 */
private fun Fixture.scenarioCoHolders(
    variant: Variant,
    games: Int,
    tag: String,
): List<Sample> =
    (1..games).flatMap { g ->
        val game = start("$tag-s2-$g", coHolderName = "共同の花子", extraCoHolders = 2)
        val retailers = listOf(game.seats[Role.RETAILER], checkNotNull(game.coHolder)) + game.extraHolders
        runIterations { i ->
            val others =
                listOf(Role.WHOLESALER, Role.DISTRIBUTOR, Role.FACTORY).map { role ->
                    writer {
                        measured(
                            variant,
                            saveCommand(
                                game,
                                game.seats[role].credential,
                                "$tag-s2-$g-$i-${role.name}",
                                role,
                                i.toLong(),
                            ),
                        )
                    }
                }
            val holders =
                retailers.mapIndexed { n, seat ->
                    writer {
                        measured(
                            variant,
                            saveCommand(game, seat.credential, "$tag-s2-$g-$i-r$n", Role.RETAILER, i.toLong()),
                        )
                    }
                }
            others + holders
        }
    }

/** S3: [games] ゲーム × 4 役割（計 4 × games の書き手）が、10 秒の窓の中で、ばらばらの時刻に 1 回ずつ保存。 */
private fun Fixture.scenarioWindow(
    variant: Variant,
    games: Int,
    tag: String,
): List<Sample> {
    val started = (1..games).map { start("$tag-s3-$it") }
    return runTogether(
        started.flatMap { game ->
            Role.entries.map { role ->
                writer {
                    delay(Random.nextLong(S3_WINDOW_MILLIS))
                    measured(
                        variant,
                        saveCommand(
                            game,
                            game.seats[role].credential,
                            "$tag-s3-${game.gameId.value}-${role.name}",
                            role,
                            0,
                        ),
                    )
                }
            }
        },
    )
}

/** S4: 1 役割の 3 人の共同担当が、現在の版を読んでは保存することを 3 回ずつ、同時に繰り返す（保存の上限は役割ごとに 9 回）。 */
private fun Fixture.scenarioContinuous(
    variant: Variant,
    games: Int,
    tag: String,
): List<Sample> =
    (1..games).flatMap { g ->
        val game = start("$tag-s4-$g", coHolderName = "共同の花子", extraCoHolders = 1)
        val holders = listOf(game.seats[Role.RETAILER], checkNotNull(game.coHolder)) + game.extraHolders
        runBlocking {
            holders
                .mapIndexed { n, seat ->
                    async {
                        (0 until 3).map { i ->
                            measured(
                                variant,
                                saveCommand(
                                    game,
                                    seat.credential,
                                    "$tag-s4-$g-$n-$i",
                                    Role.RETAILER,
                                    currentVersion(game, Role.RETAILER),
                                ),
                            )
                        }
                    }
                }.awaitAll()
                .flatten()
        }
    }

private class Row(
    val scenario: String,
    val variant: String,
    val samples: List<Sample>,
)

private fun percentile(
    sorted: List<Long>,
    p: Double,
): Long = sorted[(kotlin.math.ceil(p * sorted.size).toInt() - 1).coerceIn(0, sorted.size - 1)]

private fun Row.line(): String {
    val n = samples.size
    val count = { r: Result -> samples.count { it.result == r } }
    val latency = samples.map { it.millis }.sorted()
    val tail =
        if (n >= PERCENTILE_MIN_SAMPLES) {
            "p50=${percentile(
                latency,
                0.5,
            )} p95=${percentile(latency, 0.95)} p99=${percentile(latency, 0.99)} max=${latency.last()}"
        } else {
            "p50=${percentile(latency, 0.5)} max=${latency.last()}（標本 $n 件で、p95・p99 は言わない）"
        }
    val attempts = samples.map { it.attempts }
    return "| $scenario | $variant | $n | ${count(
        Result.OK,
    )} | ${count(Result.DOMAIN_CONFLICT)} | ${count(Result.RETRY_EXHAUSTED)} | " +
        "${count(Result.OTHER)} | ${"%.2f".format(attempts.average())} / ${attempts.max()} | $tail |"
}

private val VARIANTS: List<Variant> =
    listOf(
        Variant("上限 3・間隔なし", 3, 0, false),
        Variant("上限 5・間隔なし（現状）", 5, 0, false),
        Variant("上限 10・間隔なし", 10, 0, false),
        Variant("上限 3・ジッター 20ms", 3, 20, false),
        Variant("上限 5・ジッター 20ms", 5, 20, false),
        Variant("上限 10・ジッター 20ms", 10, 20, false),
        Variant("上限 5・ゲーム単位の書き込みロック（試作）", 5, 0, true),
    )

private const val GAMES_PER_SCENARIO = 12
private const val GAMES_IN_WINDOW = 15

/** 計測（`BEERGAME_MEASURE=1` のときだけ。結果は表で出す。合否の判定は、人が表を読んで行う）。 */
fun FunSpec.retryMeasurementContract(fixture: () -> Fixture) {
    test("[B6/5] 計測: RetryExhausted の発生率と遅延（上限・間隔・ロックの試作の比較。ローカルの PostgreSQL の値）") {
        val fx = fixture()
        val rows =
            VARIANTS.flatMapIndexed { index, variant ->
                val tag = "m$index"
                listOf(
                    Row("S1 4 役割", variant.label, fx.scenarioFourRoles(variant, GAMES_PER_SCENARIO, tag)),
                    Row("S2 共同担当 7 人", variant.label, fx.scenarioCoHolders(variant, GAMES_PER_SCENARIO, tag)),
                    Row("S3 15 ゲーム × 4 役割（10 秒の窓）", variant.label, fx.scenarioWindow(variant, GAMES_IN_WINDOW, tag)),
                    Row("S4 共同担当 3 人の連続保存", variant.label, fx.scenarioContinuous(variant, GAMES_PER_SCENARIO, tag)),
                )
            }
        val report =
            buildString {
                appendLine("| シナリオ | 試行 | 標本 | 成功 | 競合（期待どおりの失敗） | 枯渇 | その他 | 試行回数（平均 / 最大） | 遅延（ms） |")
                appendLine("| :--- | :--- | ---: | ---: | ---: | ---: | ---: | :--- | :--- |")
                rows.forEach { appendLine(it.line()) }
            }
        File("build/reports").mkdirs()
        File("build/reports/retry-measurement.md").writeText(report)
        println("\n=== retry-measurement ===\n$report")
    }
}
