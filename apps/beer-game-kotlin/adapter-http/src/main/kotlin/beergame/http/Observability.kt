package beergame.http

import beergame.application.RequestOutcome
import beergame.application.requestMetrics
import io.ktor.server.application.ApplicationCall
import io.ktor.server.application.createApplicationPlugin
import io.ktor.server.application.hooks.ResponseSent
import io.ktor.server.request.path
import io.ktor.server.response.header
import java.util.UUID

/*
 * すべての呼び出しに、相関 ID とセキュリティヘッダーを付け、処理の最後に構造化ログを 1 件出す（NF-O1、NF-O2、NF-S9）。
 * ログの項目は [LogRecord] だけ（資格・表示名・非公開の値を持たない）。ビジネスのコードは変えない。
 */

private const val NANOS_PER_MILLI = 1_000_000L
private const val MAX_STACK_FRAMES = 40
private const val SERVER_ERROR = 500
private const val CLIENT_ERROR = 400

/** API の応答の CSP。API は JSON だけを返す。 */
private const val API_CSP = "default-src 'none'; frame-ancestors 'none'"

/**
 * 画面（デモ環境で API が配信する web のビルド成果物）の応答の CSP。本番の CloudFront のヘッダーポリシー
 * （infra/modules/web/main.tf）と同じ。自分のオリジンのスクリプト・スタイル・接続だけを許す。
 */
private const val WEB_CSP =
    "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; " +
        "frame-ancestors 'none'; base-uri 'self'"

/** すべての応答に付けるセキュリティヘッダー（HSTS、nosniff、Referrer-Policy、Cache-Control）。CSP は、応答の種類で選ぶ。 */
private val SECURITY_HEADERS =
    listOf(
        "Strict-Transport-Security" to "max-age=31536000; includeSubDomains",
        "X-Content-Type-Options" to "nosniff",
        "Referrer-Policy" to "no-referrer",
        "Cache-Control" to "no-store",
    )

/** 画面を配信する設定（webRoot）があり、API の経路でなければ、画面の応答。 */
private fun cspFor(
    deps: HttpDeps,
    path: String,
): String = if (deps.settings.webRoot != null && !path.startsWith(API_BASE)) WEB_CSP else API_CSP

internal class ObservabilityConfig {
    var deps: HttpDeps? = null
}

internal val Observability =
    createApplicationPlugin(name = "Observability", createConfiguration = ::ObservabilityConfig) {
        val deps = checkNotNull(pluginConfig.deps) { "Observability には HttpDeps が要る" }
        onCall { call ->
            call.attributes.put(CorrelationKey, correlationIdOf(call.request.headers[CORRELATION_HEADER]))
            call.attributes.put(StartKey, deps.monotonicNanos())
            call.response.header(CORRELATION_HEADER, call.correlationId.toString())
            call.response.header("Content-Security-Policy", cspFor(deps, call.request.path()))
            SECURITY_HEADERS.forEach { (name, value) -> call.response.header(name, value) }
        }
        on(ResponseSent) { call ->
            val record = accessRecord(call, deps)
            deps.logs.emit(record)
            deps.ports.metrics.record(
                requestMetrics(RequestOutcome(record.operation, record.status, record.durationMillis), deps.clock()),
            )
        }
    }

/** 要求の相関 ID が UUID ならそのまま使い、そうでなければ作り直す（ログへ任意の文字列を入れさせない）。 */
private fun correlationIdOf(header: String?): UUID =
    header?.let { runCatching { UUID.fromString(it) }.getOrNull() } ?: UUID.randomUUID()

private fun elapsedMillis(
    call: ApplicationCall,
    deps: HttpDeps,
): Long = (deps.monotonicNanos() - (call.attributes.getOrNull(StartKey) ?: deps.monotonicNanos())) / NANOS_PER_MILLI

private fun accessRecord(
    call: ApplicationCall,
    deps: HttpDeps,
): LogRecord {
    val status = call.response.status()?.value ?: SERVER_ERROR
    val versions = call.attributes.getOrNull(VersionsKey)
    return LogRecord(
        timestamp = deps.clock().toString(),
        level = if (status >= SERVER_ERROR) LEVEL_WARN else LEVEL_INFO,
        correlationId = call.correlationId.toString(),
        operation = call.attributes.getOrNull(OperationKey) ?: "unrouted",
        result = call.attributes.getOrNull(ResultKey) ?: if (status < CLIENT_ERROR) "ok" else "status.$status",
        status = status,
        durationMillis = elapsedMillis(call, deps),
        gameId = call.attributes.getOrNull(GameIdKey),
        gameVersion = versions?.game?.value,
        sessionVersion = versions?.session?.value,
        src = call.attributes.getOrNull(SourceKey),
    )
}

/**
 * 予期しない例外の記録。例外のクラス名とスタックの各行（クラス、メソッド、行番号）を、相関 ID つきで残す。
 * 例外のメッセージは、入力や接続の値を含みうるので、書かない。
 */
internal fun errorRecord(
    call: ApplicationCall,
    deps: HttpDeps,
    cause: Throwable,
): LogRecord =
    LogRecord(
        timestamp = deps.clock().toString(),
        level = LEVEL_ERROR,
        correlationId = call.correlationId.toString(),
        operation = call.attributes.getOrNull(OperationKey) ?: "unrouted",
        result = Codes.INTERNAL,
        status = SERVER_ERROR,
        durationMillis = elapsedMillis(call, deps),
        gameId = call.attributes.getOrNull(GameIdKey),
        errorType = cause::class.java.name,
        stack = cause.stackTrace.take(MAX_STACK_FRAMES).map { it.toString() },
    )
