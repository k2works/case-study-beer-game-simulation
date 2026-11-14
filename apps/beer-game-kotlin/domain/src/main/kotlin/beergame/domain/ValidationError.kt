package beergame.domain

/** 入力の形の誤り。境界で値オブジェクトを作るときに、可能な限りすべて集めて返す。 */
sealed interface ValidationError {
    data class QuantityOutOfRange(
        val actual: Int,
        val max: Int,
    ) : ValidationError

    data class WeekOutOfRange(
        val actual: Int,
        val max: Int,
    ) : ValidationError

    data class UnitsNegative(
        val actual: Int,
    ) : ValidationError

    data class MoneyNegative(
        val actual: Long,
    ) : ValidationError

    data class VersionNegative(
        val actual: Long,
    ) : ValidationError

    /** 前後の空白を除いた長さ（文字数）が 1〜80 でない。 */
    data class DisplayNameInvalid(
        val length: Int,
    ) : ValidationError

    /** 需要系列の誤り。[weekIndex] は対象の週（1 始まり）で、利用者に修正すべき週を示す（AC1.1.2）。 */
    data class DemandSeriesInvalid(
        val weekIndex: Int,
        val reason: String,
    ) : ValidationError
}
