package beergame.domain

import arrow.core.Either
import arrow.core.left
import arrow.core.right
import java.util.UUID

/** ゲームの識別子。セッションの識別子も同じ値（1 ゲーム 1 セッション）。 */
@JvmInline
value class GameId(
    val value: UUID,
)

@JvmInline
value class ParticipantId(
    val value: UUID,
)

/** 週。1〜50（AC1.1.5）。 */
@Term("週", "ゲームの進行の単位。1〜50 の整数。週ごとに、4 役割の発注量を確定して在庫・受注残・費用を更新する", "AC1.1.5")
@JvmInline
value class Week internal constructor(
    val value: Int,
) : Comparable<Week> {
    /** 次の週。最後の週（50）の次は無い。 */
    fun next(): Week? = if (value < MAX) Week(value + 1) else null

    override fun compareTo(other: Week): Int = value.compareTo(other.value)

    companion object {
        const val MIN = 1
        const val MAX = 50

        /** 第 1 週。 */
        val FIRST: Week = Week(MIN)

        fun of(n: Int): Either<ValidationError.WeekOutOfRange, Week> =
            if (n in MIN..MAX) Week(n).right() else ValidationError.WeekOutOfRange(n, MAX).left()
    }
}

/** 金額。最小単位（セント）の整数で持ち、小数を持たない。負数は不可。 */
@JvmInline
value class Money internal constructor(
    val minor: Long,
) {
    operator fun plus(other: Money): Money = Money(minor + other.minor)

    operator fun times(units: Units): Money = Money(minor * units.value)

    companion object {
        val ZERO: Money = Money(0)

        fun of(minor: Long): Either<ValidationError.MoneyNegative, Money> =
            if (minor >= 0) Money(minor).right() else ValidationError.MoneyNegative(minor).left()
    }
}

/** 表示名。前後の空白を除いて 1〜80 文字（Unicode のコードポイント数）。イベントには入れない。 */
@JvmInline
value class DisplayName private constructor(
    val value: String,
) {
    companion object {
        const val MAX_LENGTH = 80

        fun of(raw: String): Either<ValidationError.DisplayNameInvalid, DisplayName> {
            val trimmed = raw.trim()
            val length = trimmed.codePointCount(0, trimmed.length)
            return if (length in
                1..MAX_LENGTH
            ) {
                DisplayName(trimmed).right()
            } else {
                ValidationError.DisplayNameInvalid(length).left()
            }
        }
    }
}

/** 参加コード。推測困難な乱数から作る 8 桁以上の文字列（生成は境界が行い、ドメインは受け取った値の長さだけを検証する）。 */
@JvmInline
value class JoinCode private constructor(
    val value: String,
) {
    companion object {
        const val MIN_LENGTH = 8

        fun of(raw: String): Either<ValidationError.JoinCodeInvalid, JoinCode> =
            if (raw.length >= MIN_LENGTH) JoinCode(raw).right() else ValidationError.JoinCodeInvalid(raw.length).left()
    }
}

/** 保持日数。1〜3650。 */
@JvmInline
value class RetentionDays private constructor(
    val value: Int,
) {
    companion object {
        const val MIN = 1
        const val MAX = 3650

        fun of(n: Int): Either<ValidationError.RetentionOutOfRange, RetentionDays> =
            if (n in MIN..MAX) RetentionDays(n).right() else ValidationError.RetentionOutOfRange(n).left()
    }
}

/** ストリームの版。追記したイベントの通し番号（楽観的並行制御の期待値）。 */
@Term("ストリームの版", "1 本のイベントの列（game・session）に追記した通し番号。同じ版への同時の追記は競合になり、一方だけが成功する", "ドメインモデル ユビキタス言語、ADR-005")
@JvmInline
value class StreamVersion private constructor(
    val value: Long,
) {
    fun next(): StreamVersion = StreamVersion(value + 1)

    companion object {
        val ZERO: StreamVersion = StreamVersion(0)

        fun of(n: Long): Either<ValidationError.VersionNegative, StreamVersion> =
            if (n >= 0) StreamVersion(n).right() else ValidationError.VersionNegative(n).left()
    }
}

/** 意思決定の版。役割ごと・週ごとに 0 から始まり、保存のたびに 1 増える（ストリームの版とは別）。 */
@Term("意思決定の版", "役割ごと・週ごとの入力の版。保存のたびに 1 増え、古い画面からの保存や確定を拒否する根拠になる（ストリームの版とは別）", "ドメインモデル D10")
@JvmInline
value class DecisionVersion private constructor(
    val value: Long,
) {
    fun next(): DecisionVersion = DecisionVersion(value + 1)

    companion object {
        val ZERO: DecisionVersion = DecisionVersion(0)

        fun of(n: Long): Either<ValidationError.VersionNegative, DecisionVersion> =
            if (n >= 0) DecisionVersion(n).right() else ValidationError.VersionNegative(n).left()
    }
}
