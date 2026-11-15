package beergame.application

import arrow.core.Either
import arrow.core.left
import arrow.core.raise.either
import arrow.core.right
import beergame.domain.GameError
import java.net.Inet4Address
import java.net.Inet6Address
import java.net.InetAddress
import java.time.Duration
import java.time.Instant

/*
 * 参加・復帰の専用のレート制限（B5 Step 5。NF-S11・NF-S19）。総当たりで、参加コードや復帰資格を当てられないようにする。
 * - 数えるのは、**認可の失敗**（不明な参加コード、無効な復帰資格）だけ。成功と、形式が不正な本文（入力の検証の失敗）は数えない。
 * - 窓は DB にあり（[AttemptStore]）、複数のインスタンスで合算される。窓は、固定の幅の区間（エポックからの切り捨て）。
 * - 窓の鍵は、**接続元の鍵付き要約**（[sourceKey]）。生の接続元（IP アドレス）は、DB にも、ログにも、イベントにも残さない。
 * - 上限に達した接続元は、参加コード・復帰資格の検査を始めない（総当たりの当たりを知らせない）。
 * 順序: 窓に 1 を足す（別のトランザクション。失敗が取り消されない）→ 上限を超えたら拒否 → 検査 → 認可の失敗でなければ 1 を戻す。
 * 先に足すのは、同時の要求が、上限を超えて検査を通り抜けないため。
 */

/** 窓の種別。保存する値は [key]。参加と復帰は別に数える。 */
enum class AttemptScope(
    val key: String,
) {
    JOIN("join"),
    RECOVER("recover"),
}

/**
 * 窓の上限と長さ。**値の根拠は未計測の仮置き**（運営者との合意は未取得）。[maxFailures] 回までの失敗を許し、超えたら拒否する。
 * 窓は 1 秒以上の整数秒。
 */
class AttemptPolicy private constructor(
    val maxFailures: Int,
    val window: Duration,
) {
    companion object {
        fun of(
            maxFailures: Int,
            window: Duration,
        ): Either<String, AttemptPolicy> =
            when {
                maxFailures < 1 -> "失敗の上限は 1 以上".left()
                window < Duration.ofSeconds(1) || window.nano != 0 -> "窓は 1 秒以上の整数秒".left()
                else -> AttemptPolicy(maxFailures, window).right()
            }
    }
}

/**
 * 正規化した接続元。IPv4 はそのまま、IPv4 射影の IPv6 は IPv4 に、IPv6 は上位 64 ビット（/64）にまとめる
 * （1 つの /64 を持つ者が、アドレスを替えて窓を避けられない）。IP の形でない文字列は、小文字にした不透明な値（名前の解決はしない）。
 * [toString] は値を含めない（ログ・例外へ漏らさない）。
 */
class AttemptSource private constructor(
    val normalized: String,
) {
    override fun equals(other: Any?): Boolean = other is AttemptSource && normalized == other.normalized

    override fun hashCode(): Int = normalized.hashCode()

    override fun toString(): String = "AttemptSource(***)"

    companion object {
        private const val UNKNOWN = "unknown"
        private const val PREFIX_BYTES = 8
        private const val BYTE_MASK = 0xff
        private const val BITS_PER_BYTE = 8
        private const val HEX = 16
        private val IPV4 = Regex("""\d{1,3}(\.\d{1,3}){3}""")
        private val IPV6_CHARS = Regex("""[0-9a-f:.]+""")

        fun of(raw: String): AttemptSource {
            val cleaned =
                raw
                    .trim()
                    .lowercase()
                    .substringBefore('%')
                    .removePrefix("[")
                    .removeSuffix("]")
            val normalized =
                when {
                    cleaned.isEmpty() -> UNKNOWN
                    IPV4.matches(cleaned) -> cleaned
                    ':' in cleaned && IPV6_CHARS.matches(cleaned) -> normalizeIpv6(cleaned)
                    else -> cleaned
                }
            return AttemptSource(normalized)
        }

        /** IP リテラルだけを解釈する（':' を含む文字列。名前の解決は起きない）。解釈できなければそのまま。 */
        private fun normalizeIpv6(literal: String): String =
            when (val address = runCatching { InetAddress.getByName(literal) }.getOrNull()) {
                is Inet4Address -> address.hostAddress
                is Inet6Address -> prefix64(address.address)
                else -> literal
            }

        private fun prefix64(bytes: ByteArray): String =
            (0 until PREFIX_BYTES step 2).joinToString(":", postfix = "::/64") { i ->
                (((bytes[i].toInt() and BYTE_MASK) shl BITS_PER_BYTE) or (bytes[i + 1].toInt() and BYTE_MASK))
                    .toString(HEX)
            }
    }
}

/** 窓の鍵。[start] は窓の開始時刻（窓の幅で切り捨てた時刻）。 */
data class AttemptWindow(
    val scope: AttemptScope,
    val sourceKey: String,
    val start: Instant,
)

/**
 * 窓の保存（`participation_attempts`）。
 * - [charge]: 窓の数を 1 つ増やし、増やした後の数を返す（同時の呼び出しの間で、数え落としも重複もない）。
 * - [refund]: 窓の数を 1 つ戻す（0 より下には下げない）。
 * - [purge]: 開始が [Instant] より前の窓を消す。
 * 呼び出し側（[limitedAttempts]）は、コマンドのトランザクションとは別のトランザクションで呼ぶ（失敗が取り消されても、数は残る）。
 */
data class AttemptStore(
    val charge: suspend (Tx, AttemptWindow) -> Either<AppFailure, Int>,
    val refund: suspend (Tx, AttemptWindow) -> Either<AppFailure, Unit>,
    val purge: suspend (Tx, Instant) -> Either<AppFailure, Unit>,
)

/** 接続元の鍵付き要約（HMAC-SHA256、16 進 64 桁）。冪等キーの鍵と部分の並びで分ける（"attempt-source"）。ログの `src` と窓の鍵は同じ値。 */
fun AppSettings.sourceKey(source: AttemptSource): String =
    Hmac.hex(idempotencySecret, listOf("attempt-source", source.normalized))

private fun AttemptPolicy.windowStart(at: Instant): Instant {
    val width = window.seconds
    return Instant.ofEpochSecond(at.epochSecond / width * width)
}

private fun AppFailure.isCredentialFailure(): Boolean =
    this is AppFailure.Unauthorized || (this is AppFailure.Domain && error === GameError.InvitationInvalid)

/**
 * 参加・復帰を、窓で制限して実行する。[source] が無い呼び出し（HTTP の外）は、制限しない。
 * 窓を保存できない（永続化の失敗）ときは、通さずに失敗を返す（閉じる側に倒す）。
 */
internal suspend fun <A> Ports.limitedAttempts(
    scope: AttemptScope,
    source: AttemptSource?,
    block: suspend () -> Either<AppFailure, A>,
): Either<AppFailure, A> {
    if (source == null) return block()
    val at = now()
    val policy = settings.attempts
    val window = AttemptWindow(scope, settings.sourceKey(source), policy.windowStart(at))
    return either {
        val count = charge(window).bind()
        if (count > policy.maxFailures) {
            raise(AppFailure.RateLimited(retryAfterSeconds(window, policy, at)))
        }
        val result = block()
        // 認可の失敗だけを数える。成功と、そのほかの失敗（受付の終了など）は戻す。戻せなくても、数が多めに残るだけ（安全な側）
        if (result.fold({ !it.isCredentialFailure() }, { true })) refund(window)
        result.bind()
    }
}

private suspend fun Ports.charge(window: AttemptWindow): Either<AppFailure, Int> =
    events.transaction { tx ->
        either {
            val count = attempts.charge(tx, window).bind()
            // 新しい窓の最初の記録で、前の窓の行を掃除する（表が増え続けない）
            if (count == 1) attempts.purge(tx, window.start).bind()
            count
        }
    }

private suspend fun Ports.refund(window: AttemptWindow) {
    events.transaction { tx -> attempts.refund(tx, window) }
}

private fun retryAfterSeconds(
    window: AttemptWindow,
    policy: AttemptPolicy,
    at: Instant,
): Int {
    val remaining = Duration.between(at, window.start.plus(policy.window))
    val seconds = remaining.seconds + if (remaining.nano > 0) 1 else 0
    return seconds.toInt().coerceAtLeast(1)
}
