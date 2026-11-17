package beergame.app

import arrow.core.Either
import beergame.http.LEVEL_ERROR
import beergame.http.LEVEL_INFO
import beergame.http.LogRecord
import beergame.http.LogSink
import beergame.http.Slf4jLogSink
import kotlin.system.exitProcess

/*
 * 起動モード: `api`（既定）、`migrate`、`retention`（B11。保持削除の掃引を 1 回行う）。`rebuild-projections` は名前だけ定義（実装は B12）。
 * 終了コード: 0 正常、1 保持削除が再試行の上限に達したゲームがある、64 使い方の誤り、69 未実装のモード、70 起動の失敗（接続できないなど）、
 * 78 設定の誤り（BSD の sysexits に倣う）。
 */

private const val EXIT_USAGE = 64
private const val EXIT_UNIMPLEMENTED = 69
internal const val EXIT_SOFTWARE = 70
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
        mode !in MODES + UNIMPLEMENTED_MODES -> {
            usage(mode, logs)
        }

        mode in UNIMPLEMENTED_MODES -> {
            unimplemented(mode, logs)
        }

        else -> {
            when (val loaded = ServerConfig.load(env)) {
                is Either.Left -> configInvalid(loaded.value.map(::describe), logs)
                is Either.Right -> execute(mode, loaded.value, logs)
            }
        }
    }
}

private val MODES = setOf("api", "migrate", "retention")

/** 名前だけ定義した、未実装のモード（`rebuild-projections` は B12 で実装する）。 */
private val UNIMPLEMENTED_MODES = setOf("rebuild-projections")

private fun usage(
    mode: String,
    logs: LogSink,
): Int {
    val available = (MODES + UNIMPLEMENTED_MODES).joinToString("、")
    logs.emit(
        operationalRecord(
            LEVEL_ERROR,
            "startup",
            "usage",
            "起動モード「$mode」は使えません。$available のいずれかを指定してください（rebuild-projections は未実装）。",
        ),
    )
    return EXIT_USAGE
}

/** 設定を読む前に断る（未実装のモードのために、本番の秘密情報や DB を要求しない）。 */
private fun unimplemented(
    mode: String,
    logs: LogSink,
): Int {
    logs.emit(
        operationalRecord(LEVEL_ERROR, "startup", "unimplemented", "起動モード「$mode」は未実装です（モード名の定義のみ）。何も実行しません。"),
    )
    return EXIT_UNIMPLEMENTED
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
        .catch {
            when (mode) {
                "migrate" -> migrateOnly(config, logs)
                "retention" -> runRetention(config, logs)
                else -> serve(config, logs)
            }
        }.fold(
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
