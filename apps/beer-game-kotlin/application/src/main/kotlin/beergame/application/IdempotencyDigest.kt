package beergame.application

import java.nio.ByteBuffer
import java.nio.charset.StandardCharsets
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

/**
 * 冪等キーと要求の同一性の digest（鍵付き HMAC-SHA256。16 進の小文字）。
 * 生の冪等キーは保存せず、digest だけを保存する（data-model.md「冪等性」）。
 */
object IdempotencyDigest {
    private const val ALGORITHM = "HmacSHA256"

    /** 本文・対象・操作者の ID から作る。各部分に長さを前置するので、連結の境界で衝突しない。 */
    fun request(
        secret: ByteArray,
        body: String,
        target: String,
        actorId: String,
    ): String = hmac(secret, listOf(body, target, actorId))

    fun key(
        secret: ByteArray,
        rawKey: String,
    ): String = hmac(secret, listOf(rawKey))

    private fun hmac(
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
