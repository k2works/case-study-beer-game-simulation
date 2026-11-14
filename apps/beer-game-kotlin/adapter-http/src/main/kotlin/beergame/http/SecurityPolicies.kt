package beergame.http

/**
 * 変更系の Origin（または Referer）の検査（NF-S8）。許可リストか、Host と同じ権限（authority）のオリジンだけを許す。
 * Origin も Referer も無い要求（ブラウザの外のクライアント）は許す: CSRF はブラウザの要求が前提で、
 * ブラウザは外部のオリジンからの変更系の要求に Origin を付ける。
 */
internal class OriginPolicy(
    allowed: Set<String>,
) {
    private val allowed: Set<String> = allowed.map(::normalize).toSet()

    fun isAllowed(
        origin: String?,
        referer: String?,
        host: String?,
    ): Boolean =
        when {
            origin != null -> matches(normalize(origin), host)
            referer != null -> originOf(referer)?.let { matches(it, host) } ?: false
            else -> true
        }

    private fun matches(
        origin: String,
        host: String?,
    ): Boolean = origin in allowed || (host != null && authorityOf(origin) == host.trim().lowercase())
}

private const val SCHEME_SEPARATOR = "://"

private fun normalize(raw: String): String = raw.trim().lowercase().trimEnd('/')

private fun authorityOf(origin: String): String? =
    if (origin.contains(SCHEME_SEPARATOR)) origin.substringAfter(SCHEME_SEPARATOR) else null

/** `scheme://authority/path` から `scheme://authority` を取り出す。URL の形でなければ null。 */
private fun originOf(url: String): String? {
    val lowered = url.trim().lowercase()
    return if (lowered.contains(SCHEME_SEPARATOR)) {
        val scheme = lowered.substringBefore(SCHEME_SEPARATOR)
        val authority = lowered.substringAfter(SCHEME_SEPARATOR).substringBefore('/')
        "$scheme$SCHEME_SEPARATOR$authority"
    } else {
        null
    }
}

/** レート制限の判定。 */
internal sealed interface RateDecision {
    data object Allowed : RateDecision

    data class Limited(
        val retryAfterSeconds: Int,
    ) : RateDecision
}

/**
 * 固定の窓（最初の要求から [windowMillis]）で、鍵ごとの要求を [limit] 件までにする。記憶する鍵は [maxKeys] 件まで
 * （古い窓から捨てる。メモリを使い切らない）。状態はプロセスの中だけ（設計判断 BD8 は未決。タスク数が増えれば、実効の上限は増える）。
 */
internal class RateLimiter(
    private val limit: Int,
    private val windowMillis: Long,
    private val maxKeys: Int = DEFAULT_MAX_KEYS,
    private val now: () -> Long = System::currentTimeMillis,
) {
    private class Window(
        val start: Long,
        var count: Int,
    )

    private val windows = LinkedHashMap<String, Window>()

    @Synchronized
    fun tryAcquire(key: String): RateDecision {
        val time = now()
        val current = windows[key]
        return if (current == null || time - current.start >= windowMillis) {
            windows.remove(key)
            makeRoom(time)
            windows[key] = Window(time, 1)
            RateDecision.Allowed
        } else if (current.count < limit) {
            current.count += 1
            RateDecision.Allowed
        } else {
            val remainingMillis = current.start + windowMillis - time
            RateDecision.Limited(
                ((remainingMillis + MILLIS_PER_SECOND - 1) / MILLIS_PER_SECOND).toInt().coerceAtLeast(1),
            )
        }
    }

    @Synchronized
    fun trackedKeys(): Int = windows.size

    private fun makeRoom(time: Long) {
        if (windows.size >= maxKeys) {
            windows.entries.removeAll { time - it.value.start >= windowMillis }
        }
        if (windows.size >= maxKeys) {
            windows.keys.firstOrNull()?.let(windows::remove)
        }
    }

    private companion object {
        const val DEFAULT_MAX_KEYS = 10_000
        const val MILLIS_PER_SECOND = 1_000L
    }
}
