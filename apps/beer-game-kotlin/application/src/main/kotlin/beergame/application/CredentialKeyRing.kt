package beergame.application

import arrow.core.Either
import arrow.core.left
import arrow.core.right

/*
 * 資格の鍵の版（B5 判断項目 3 の決定: 資格の値の接頭辞）。資格の値は `v<版>.<乱数>` で、ダイジェスト（鍵付き HMAC）は、
 * 値が示す版の鍵で作る。ダイジェストは鍵が違えば別の値になるので、版を知らないとどの鍵で作るか決まらない。
 * そのため版は値に含める（値の全体がダイジェストの入力になるので、版を書き換えると別のダイジェストになる）。
 * 発行は現在の版、検証は値が示す版の鍵。旧版の鍵を設定に残す間は、旧版の資格は期限まで有効で、
 * 鍵を設定から外すと、その版の資格は検証できない（認証は 403 になる）。
 */

/** 発行した資格。[raw] は応答だけが運び、保存するのは [digest] と [keyVersion] だけ。 */
internal data class MintedCredential(
    val raw: String,
    val keyVersion: Int,
    val digest: String,
)

/** 検証用のダイジェストと、それを作った鍵の版。 */
data class KeyedDigest(
    val keyVersion: Int,
    val digest: String,
)

/** 鍵の版つきの鍵束。鍵の内容は、文字列にも出さない。 */
class CredentialKeyRing private constructor(
    private val current: Int,
    private val keys: Map<Int, ByteArray>,
) {
    /** 現在の版の鍵で、新しい資格を作る。[token] は暗号論的な乱数（[SecureTokens.newCredential]）。 */
    internal fun mint(token: String): MintedCredential {
        val raw = "$PREFIX$current$SEPARATOR$token"
        return MintedCredential(raw, current, CredentialDigest.of(keys.getValue(current), raw))
    }

    /** 値が示す版の鍵でダイジェストを作る。形式が違う・知らない版（鍵が外された）なら null（理由は区別しない）。 */
    fun digest(raw: String): KeyedDigest? {
        val version = versionOf(raw)
        val key = version?.let(keys::get)
        return if (version == null || key == null) null else KeyedDigest(version, CredentialDigest.of(key, raw))
    }

    override fun toString(): String = "CredentialKeyRing(current=$current, versions=${keys.keys.sorted()})"

    companion object {
        private const val PREFIX = "v"
        private const val SEPARATOR = '.'
        private val FORMAT = Regex("v([0-9]{1,9})\\.(.+)")

        /** 現在の版の鍵が [keys] にあり、すべての版が 1 以上であること。 */
        fun of(
            current: Int,
            keys: Map<Int, ByteArray>,
        ): Either<String, CredentialKeyRing> {
            val invalid = keys.keys.firstOrNull { it < 1 }
            return when {
                invalid != null -> "鍵の版は 1 以上: $invalid".left()
                current !in keys -> "現在の版 $current の鍵が無い".left()
                else -> CredentialKeyRing(current, keys.toMap()).right()
            }
        }

        private fun versionOf(raw: String): Int? =
            FORMAT
                .matchEntire(raw)
                ?.groupValues
                ?.get(1)
                ?.toIntOrNull()
                ?.takeIf { it >= 1 }
    }
}
