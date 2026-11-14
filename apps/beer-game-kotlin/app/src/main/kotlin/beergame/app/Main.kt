package beergame.app

import arrow.core.Either
import beergame.http.LEVEL_ERROR
import beergame.http.LEVEL_INFO
import beergame.http.LogRecord
import beergame.http.LogSink
import beergame.http.Slf4jLogSink
import kotlin.system.exitProcess

/*
 * 起動モード: `api`（既定）と `migrate`。`retention`、`rebuild-projections` は B1 の範囲外（B11、B12）。
 * 終了コード: 0 正常、64 使い方の誤り、70 起動の失敗（接続できないなど）、78 設定の誤り（BSD の sysexits に倣う）。
 */

private const val EXIT_USAGE = 64
private const val EXIT_SOFTWARE = 70
private const val EXIT_CONFIG = 78
private const val MAX_STACK_FRAMES = 40

fun main(args: Array<String>) {
    exitProcess(runMain(args.toList(), System.getenv(), Slf4jLogSink()))
}

/** [env] は環境変数。`api` は、停止の要求（SIGTERM など）が来るまで戻らない。 */
fun runMain(
    args: List<String>,
    env: Map<String, String>,
    logs: LogSink,
): Int {
    val mode = args.firstOrNull() ?: "api"
    return when {
        mode !in MODES -> {
            usage(mode, logs)
        }

        else -> {
            when (val loaded = ServerConfig.load(env)) {
                is Either.Left -> configInvalid(loaded.value.map(::describe), logs)
                is Either.Right -> execute(mode, loaded.value, logs)
            }
        }
    }
}

private val MODES = setOf("api", "migrate")

private fun usage(
    mode: String,
    logs: LogSink,
): Int {
    logs.emit(
        operationalRecord(LEVEL_ERROR, "startup", "usage", "起動モード「$mode」は使えません。api または migrate を指定してください。"),
    )
    return EXIT_USAGE
}

private fun configInvalid(
    problems: List<String>,
    logs: LogSink,
): Int {
    logs.emit(
        operationalRecord(LEVEL_ERROR, "startup", "config.invalid", "設定が不正なため起動しません: ${problems.joinToString("、")}"),
    )
    return EXIT_CONFIG
}

private fun execute(
    mode: String,
    config: ServerConfig,
    logs: LogSink,
): Int =
    Either
        .catch { if (mode == "migrate") migrateOnly(config, logs) else serve(config, logs) }
        .fold(
            { failure ->
                logs.emit(failureRecord(failure))
                EXIT_SOFTWARE
            },
            { it },
        )

private fun migrateOnly(
    config: ServerConfig,
    logs: LogSink,
): Int {
    val applied = migrate(config.database)
    logs.emit(operationalRecord(LEVEL_INFO, "migrate", "ok", "マイグレーションを適用しました（$applied 件）"))
    return 0
}

/** 起動し、停止の要求まで待つ。 */
private fun serve(
    config: ServerConfig,
    logs: LogSink,
): Int {
    val running = startApi(config, logs)
    val stopped = Thread { running.close() }
    Runtime.getRuntime().addShutdownHook(stopped)
    Thread.currentThread().join()
    return 0
}

/** 起動の失敗。例外のクラス名とスタックだけを残す（メッセージには接続文字列などが入りうるので、書かない）。 */
private fun failureRecord(failure: Throwable): LogRecord =
    operationalRecord(LEVEL_ERROR, "startup", "failed", "起動に失敗しました").copy(
        errorType = failure::class.java.name,
        stack = failure.stackTrace.take(MAX_STACK_FRAMES).map { it.toString() },
    )

/** 設定の誤りを、名前だけで説明する（値は出さない）。 */
private fun describe(error: ConfigError): String =
    when (error) {
        is ConfigError.MissingEnv -> "APP_ENV が未設定"
        is ConfigError.UnknownEnv -> "APP_ENV の値が不明"
        is ConfigError.UnknownDbKind -> "DB_KIND の値が不明"
        is ConfigError.H2NotAllowed -> "H2 は APP_ENV=local のときだけ許される（現在: ${error.env?.value ?: "未設定または不明"}）"
        is ConfigError.MissingSetting -> "${error.name} が未設定"
        is ConfigError.InvalidSetting -> "${error.name} の値が不正"
    }
