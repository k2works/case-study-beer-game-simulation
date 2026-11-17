package beergame.app

import arrow.core.Either
import beergame.application.AppFailure
import beergame.application.Now
import beergame.application.RetentionSweeper
import beergame.application.SweepReport
import beergame.domain.RetentionSaga
import beergame.http.LEVEL_ERROR
import beergame.http.LEVEL_INFO
import beergame.http.LogSink
import beergame.persistence.retentionStore
import com.zaxxer.hikari.HikariConfig
import com.zaxxer.hikari.HikariDataSource
import kotlinx.coroutines.runBlocking
import java.time.Duration
import java.time.Instant
import java.util.UUID
import kotlin.random.Random

/*
 * 起動モード `retention`（B11。US5.1）。期限に達したゲームを検出し、`game_roots` の連鎖削除で削除する。1 回の掃引を行って終了する
 * （EventBridge Scheduler が 5 分ごとに起動する。データモデル「保持削除の流れ」）。
 * 終了コード: 0 正常（削除が 0 件でもよい）、1 再試行の上限に達して、削除をやめたゲームがある（エラーのログを残す。通知の経路は B14）、
 * 70 起動・記録の失敗（接続できない、削除の進行を記録できないなど。次の起動で再試行する）。
 */

private const val DELETER_POOL_SIZE = 2
private const val CONNECTION_TIMEOUT_MILLIS = 3_000L
internal const val EXIT_ABANDONED = 1

/**
 * 削除用の接続プール。`DB_DELETER_ROLE` を指定した PostgreSQL は、接続のたびに `SET ROLE` して、削除用のロールの権限
 * （`game_roots` の DELETE と `deletion_*`。`events` の DELETE は持たない）で動かす。指定が無ければ、接続のユーザーのまま。
 */
internal fun openDeleterDataSource(database: DatabaseSettings): HikariDataSource {
    val role = (database as? DatabaseSettings.Postgres)?.deleterRole
    return if (database !is DatabaseSettings.Postgres || role == null) {
        openDataSource(database)
    } else {
        HikariDataSource(
            HikariConfig().apply {
                jdbcUrl = database.url
                username = database.user
                password = database.password
                poolName = "beergame-deleter"
                maximumPoolSize = DELETER_POOL_SIZE
                connectionTimeout = CONNECTION_TIMEOUT_MILLIS
                connectionInitSql = "SET ROLE $role"
            },
        )
    }
}

/** 揺らぎ（バックオフに足す）。0 以上、バックオフの基準より小さい。 */
private fun randomJitter(): Duration = Duration.ofMillis(Random.nextLong(RetentionSaga.BASE_BACKOFF.toMillis()))

/** 掃引を 1 回行い、結果を記録して、終了コードを返す。[now] は、試験のために差し替えられる時計。 */
internal fun runRetention(
    config: ServerConfig,
    logs: LogSink,
    now: Now = { Instant.now() },
): Int =
    openDeleterDataSource(config.database).use { dataSource ->
        val sweeper =
            RetentionSweeper(
                store = retentionStore(dataSource),
                clock = now,
                newId = { UUID.randomUUID() },
                jitter = { randomJitter() },
                receiptKey = config.secrets.credentialKey,
            )
        report(runBlocking { sweeper.sweep() }, logs)
    }

private fun report(
    result: Either<AppFailure, SweepReport>,
    logs: LogSink,
): Int =
    when (result) {
        is Either.Left -> {
            logs.emit(operationalRecord(LEVEL_ERROR, "retention", "failed", "保持削除の掃引に失敗しました: ${result.value}"))
            EXIT_SOFTWARE
        }

        is Either.Right -> {
            val sweep = result.value
            logs.emit(
                operationalRecord(
                    LEVEL_INFO,
                    "retention",
                    "ok",
                    "削除 ${sweep.completed.size} 件、失敗 ${sweep.failures.size} 件、期限切れの受領記録の削除 ${sweep.purgedReceipts} 件",
                ),
            )
            sweep.abandoned.forEach {
                logs.emit(
                    operationalRecord(
                        LEVEL_ERROR,
                        "retention",
                        "abandoned",
                        "再試行の上限に達したため、削除をやめました" +
                            "（ゲーム ${it.gameId.value}、試行 ${it.attempt} 回、${it.failureCode}）。運営者への連絡が要ります",
                    ),
                )
            }
            if (sweep.abandoned.isEmpty()) 0 else EXIT_ABANDONED
        }
    }
