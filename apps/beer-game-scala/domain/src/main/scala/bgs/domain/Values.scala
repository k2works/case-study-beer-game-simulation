package bgs.domain

/** 入力の形の誤り。境界で値オブジェクトを作るときに、可能な限りすべて集めて返す（`ValidatedNec`）。 */
enum ValidationError:
  case QuantityOutOfRange(actual: Int, max: Int)
  case WeekOutOfRange(actual: Int, max: Int)
  case UnitsNegative(actual: Long)
  case MoneyNegative(actual: Long)

  /** 前後の空白を除いた長さ（コードポイント数）が 1〜80 でない。 */
  case DisplayNameInvalid(length: Int)

  /** 参加コードが 8 文字に満たない。 */
  case JoinCodeInvalid(length: Int)

  /** 保持日数が 1〜3650 でない。 */
  case RetentionOutOfRange(actual: Int)

  /** 需要系列の誤り。[[weekIndex]] は対象の週（1 始まり）で、利用者に修正すべき週を示す（AC1.1.2）。 */
  case DemandSeriesInvalid(weekIndex: Int, reason: String)

// opaque type は同じファイルのトップレベルでは中身が見える。ゼロコストで型を区別し、
// コンパニオンの `of` で生成時に検証する（不正な値は存在できない）。

/** 発注量・生産要請数。0〜1000 の整数（BR-10）。 */
opaque type Quantity = Int

object Quantity:
  val Max: Int = 1000

  def of(n: Int): Either[ValidationError, Quantity] =
    if n >= 0 && n <= Max then Right(n) else Left(ValidationError.QuantityOutOfRange(n, Max))

  extension (q: Quantity)
    def value: Int = q
    def toUnits: Units = q.toLong

/** 上限のない非負の数量。在庫・受注残・出荷・待ち行列の中身に使う。 */
opaque type Units = Long

object Units:
  val Zero: Units = 0L

  /** 呼び出し側が非負を保証する定数用（キットの既定値など）。外部の入力には使わない。 */
  private[domain] def trusted(n: Long): Units = n

  def of(n: Long): Either[ValidationError, Units] =
    if n >= 0 then Right(n) else Left(ValidationError.UnitsNegative(n))

  extension (u: Units)
    def value: Long = u
    def +(other: Units): Units = u + other

    /** 引いた結果が負なら 0（`max(0, this - other)`。BR-08）。 */
    def minusToZero(other: Units): Units = math.max(0L, u - other)
    def min(other: Units): Units = math.min(u, other)

/** 金額。最小単位（セント）の整数で持つ。負数は不可。 */
opaque type Money = Long

object Money:
  val Zero: Money = 0L

  /** 呼び出し側が非負を保証する定数用（キットの単価など）。外部の入力には使わない。 */
  private[domain] def trusted(minor: Long): Money = minor

  def of(minor: Long): Either[ValidationError, Money] =
    if minor >= 0 then Right(minor) else Left(ValidationError.MoneyNegative(minor))

  extension (m: Money)
    def minor: Long = m
    def +(other: Money): Money = m + other
    def *(units: Units): Money = m * units

/** 週。1〜50（AC1.1.5）。 */
opaque type Week = Int

object Week:
  val Min: Int = 1
  val Max: Int = 50

  def of(n: Int): Either[ValidationError, Week] =
    if n >= Min && n <= Max then Right(n) else Left(ValidationError.WeekOutOfRange(n, Max))

  val first: Week = Min

  extension (w: Week)
    def value: Int = w

    /** 次の週。最後の週（50）の次は無い。 */
    def next: Option[Week] = if w < Max then Some(w + 1) else None
    def isBefore(other: Week): Boolean = w < other
