package beergame.application

import java.nio.ByteBuffer
import java.nio.charset.StandardCharsets
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

/**
 * 鍵付き HMAC-SHA256（16 進の小文字）。各部分に長さを前置するので、連結の境界で衝突しない。
 * 冪等キーと要求の digest（[IdempotencyDigest]）、資格の digest（[CredentialDigest]）が使う。
 */
internal object Hmac {
    private const val ALGORITHM = "HmacSHA256"

    fun hex(
        secret: ByteArray,
        parts: List<String>,
    ): String {
        val mac = Mac.getInstance(ALGORITHM)
        mac.init(SecretKeySpec(secret, ALGORITHM))
        parts.forEach { part ->
            val bytes = part.toByteArray(StandardCharsets.UTF_8)
            mac.update(ByteBuffer.allocate(Int.SIZE_BYTES).putInt(bytes.size).array())
            mac.update(bytes)
        }
        return mac.doFinal().joinToString("") { "%02x".format(it) }
    }
}
