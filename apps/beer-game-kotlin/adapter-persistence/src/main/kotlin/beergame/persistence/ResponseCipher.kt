package beergame.persistence

import java.security.GeneralSecurityException
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * 冪等記録の応答の暗号化（AES-256-GCM）。形式は `[12 バイトの nonce][暗号文と認証タグ]`。
 * 追加の認証データ（AAD）に記録のキーを結び、別の行へ付け替えた暗号文を復号させない。
 */
internal class ResponseCipher(
    key: ByteArray,
) {
    private val keySpec: SecretKeySpec

    init {
        require(key.size == KEY_BYTES) { "応答の暗号化の鍵は $KEY_BYTES バイト" }
        keySpec = SecretKeySpec(key, "AES")
    }

    private val random = SecureRandom()

    fun encrypt(
        plain: ByteArray,
        aad: String,
    ): ByteArray {
        val nonce = ByteArray(NONCE_BYTES).also(random::nextBytes)
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, keySpec, GCMParameterSpec(TAG_BITS, nonce))
        cipher.updateAAD(aad.toByteArray(Charsets.UTF_8))
        return nonce + cipher.doFinal(plain)
    }

    /** 復号できない（改ざん・鍵違い・別の行）ときは null。 */
    fun decrypt(
        blob: ByteArray,
        aad: String,
    ): ByteArray? {
        if (blob.size <= NONCE_BYTES) return null
        return try {
            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(Cipher.DECRYPT_MODE, keySpec, GCMParameterSpec(TAG_BITS, blob.copyOfRange(0, NONCE_BYTES)))
            cipher.updateAAD(aad.toByteArray(Charsets.UTF_8))
            cipher.doFinal(blob, NONCE_BYTES, blob.size - NONCE_BYTES)
        } catch (_: GeneralSecurityException) {
            null
        }
    }

    private companion object {
        const val KEY_BYTES = 32
        const val NONCE_BYTES = 12
        const val TAG_BITS = 128
        const val TRANSFORMATION = "AES/GCM/NoPadding"
    }
}
