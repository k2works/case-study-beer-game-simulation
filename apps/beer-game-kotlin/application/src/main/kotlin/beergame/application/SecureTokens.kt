package beergame.application

import java.security.SecureRandom
import java.util.Base64

/**
 * 推測困難な値の生成（暗号論的な乱数）。`Ports.newCredential`・`Ports.newJoinCode` の既定の実装として、`app` が渡す。
 * 乱数は外部の副作用なので、アプリケーション層の本体からは、ポート越しにだけ呼ぶ。
 */
object SecureTokens {
    private const val CREDENTIAL_BYTES = 32
    private const val JOIN_CODE_LENGTH = 12

    /** 紛らわしい文字（I、O、0、1）を除いた 32 文字。 */
    private const val JOIN_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"

    private val random = SecureRandom()

    /** 256 ビットの乱数を URL に安全な Base64（パディングなし、43 文字）にしたもの。 */
    fun newCredential(): String {
        val bytes = ByteArray(CREDENTIAL_BYTES).also(random::nextBytes)
        return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)
    }

    /** 12 文字（約 60 ビット）。重複は、データベースの一意制約（`uq_game_join_codes_code`）が最後の砦になる。 */
    fun newJoinCode(): String =
        (1..JOIN_CODE_LENGTH).map { JOIN_CODE_ALPHABET[random.nextInt(JOIN_CODE_ALPHABET.length)] }.joinToString("")
}
