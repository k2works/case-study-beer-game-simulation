package beergame.application

/**
 * 冪等キーと要求の同一性の digest（鍵付き HMAC-SHA256。16 進の小文字）。
 * 生の冪等キーは保存せず、digest だけを保存する（data-model.md「冪等性」）。
 */
object IdempotencyDigest {
    /** 本文・対象・操作者の ID から作る。各部分に長さを前置するので、連結の境界で衝突しない。 */
    fun request(
        secret: ByteArray,
        body: String,
        target: String,
        actorId: String,
    ): String = Hmac.hex(secret, listOf(body, target, actorId))

    fun key(
        secret: ByteArray,
        rawKey: String,
    ): String = Hmac.hex(secret, listOf(rawKey))
}
