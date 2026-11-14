package beergame.http

import beergame.application.Ports
import java.time.Instant

/**
 * HTTP の層の設定。値は外から注入する（`app` が読む）。
 * [allowedOrigins] は変更系の Origin の許可リスト（同じ Host のオリジンは常に許す）。[cookieSecure] は資格の Cookie の
 * `Secure` 属性（HTTPS でない開発機だけ false にする）。[rateLimitPerMinute] は、接続元ごとの 1 分あたりの上限。
 */
class HttpSettings(
    val allowedOrigins: Set<String>,
    val cookieSecure: Boolean,
    val maxBodyBytes: Int = DEFAULT_MAX_BODY_BYTES,
    val rateLimitPerMinute: Int = DEFAULT_RATE_LIMIT_PER_MINUTE,
) {
    companion object {
        /** 本文の上限（64 KB。NF-S10）。 */
        const val DEFAULT_MAX_BODY_BYTES = 65_536

        /** 全体の上限の既定。値の根拠は設計書に無い（未決。計測の後に決める）。 */
        const val DEFAULT_RATE_LIMIT_PER_MINUTE = 600
    }
}

/** データベースに接続できるか（`SELECT 1` と接続プールの取得）。例外にせず、真偽で答える側が決める。 */
fun interface DatabaseProbe {
    suspend fun isReachable(): Boolean
}

/**
 * HTTP の層が受け取る依存の束。永続化は [ports] の中にある（adapter-http は JDBC を知らない）。
 * [clock] はログの時刻、[monotonicNanos] は所要時間の計測に使う（試験で差し替える）。
 */
class HttpDeps(
    val ports: Ports,
    val database: DatabaseProbe,
    val settings: HttpSettings,
    val logs: LogSink,
    val clock: () -> Instant = Instant::now,
    val monotonicNanos: () -> Long = System::nanoTime,
)
