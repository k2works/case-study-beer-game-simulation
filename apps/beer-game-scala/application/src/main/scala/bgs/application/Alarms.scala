package bgs.application

/** アラームの定義（閾値の表）と評価（B13。AC6.1.3・AC6.1.5）。**純粋関数**で、模擬の時計と故障を模擬した入力を与えて「訓練」できる （実際の待機はしない）。AWS
  * 上の定義（CloudWatch のアラーム・Terraform）は、この表から作る（B14）。閾値は仮置き（未計測。B15 で見直す）。
  */
object Alarms:

  /** 時刻（秒。試験では模擬の時計）と、その時点のメトリクスの値。 */
  final case class Sample(timeSeconds: Int, value: Double)

  enum Statistic:
    case Sum, Min, Average

  enum Comparison:
    case LessThan, GreaterOrEqual

  enum Severity:
    case Warning, Critical

  /** 1 つのアラーム。`periodSeconds` ごとに [[statistic]] で集計した値が [[threshold]] を越える期間が、[[datapoints]]
    * 回連続したら発報する。 [[requiresTraining]] が真なら、研修中のときだけ評価する（研修中でない時間の無音は、異常ではない）。
    */
  final case class AlarmDefinition(
      name: String,
      severity: Severity,
      metric: String,
      statistic: Statistic,
      comparison: Comparison,
      threshold: Double,
      periodSeconds: Int,
      datapoints: Int,
      requiresTraining: Boolean
  )

  /** 研修中に、主要な操作（入力の保存・確定・代理入力・状況の取得）の成功が、60 秒の期間で 1 件も無い。停止から 60 秒以内に発報する。 */
  val MainOperationStall: AlarmDefinition = AlarmDefinition(
    "main-operation-stall",
    Severity.Critical,
    "MainOperationSuccess",
    Statistic.Sum,
    Comparison.LessThan,
    1.0,
    60,
    1,
    requiresTraining = true
  )

  /** 合成監視（1 分ごと）の失敗が、連続 2 期間。最悪でも 2 分以内に発報する。 */
  val SyntheticFailure: AlarmDefinition = AlarmDefinition(
    "synthetic-failure",
    Severity.Critical,
    "SyntheticSuccess",
    Statistic.Min,
    Comparison.LessThan,
    1.0,
    60,
    2,
    requiresTraining = false
  )

  /** 追記の競合率（%）が 5% 以上で連続 2 期間（警告）。 */
  val AppendConflictWarning: AlarmDefinition = AlarmDefinition(
    "append-conflict-rate-warning",
    Severity.Warning,
    "AppendConflictRate",
    Statistic.Average,
    Comparison.GreaterOrEqual,
    5.0,
    60,
    2,
    requiresTraining = false
  )

  /** 追記の競合率（%）が 20% 以上で連続 3 期間（重大）。 */
  val AppendConflictCritical: AlarmDefinition = AlarmDefinition(
    "append-conflict-rate-critical",
    Severity.Critical,
    "AppendConflictRate",
    Statistic.Average,
    Comparison.GreaterOrEqual,
    20.0,
    60,
    3,
    requiresTraining = false
  )

  /** JVM のヒープの使用率（%）が 85% 以上で連続 10 期間（10 分）。 */
  val JvmHeapCritical: AlarmDefinition = AlarmDefinition(
    "jvm-heap-critical",
    Severity.Critical,
    "JvmHeapUsedPercent",
    Statistic.Average,
    Comparison.GreaterOrEqual,
    85.0,
    60,
    10,
    requiresTraining = false
  )

  val all: List[AlarmDefinition] =
    List(
      MainOperationStall,
      SyntheticFailure,
      AppendConflictWarning,
      AppendConflictCritical,
      JvmHeapCritical
    )

  private def aggregate(defn: AlarmDefinition, values: List[Double]): Option[Double] =
    defn.statistic match
      case Statistic.Sum     => Some(values.sum) // 件数の指標は、無ければ 0
      case Statistic.Min     => values.minOption
      case Statistic.Average => Option.when(values.nonEmpty)(values.sum / values.size)

  private def breaches(defn: AlarmDefinition, value: Option[Double]): Boolean =
    value.exists(v =>
      defn.comparison match
        case Comparison.LessThan       => v < defn.threshold
        case Comparison.GreaterOrEqual => v >= defn.threshold
    )

  /** 最初に発報する時刻（秒。連続の最後の期間の終わり）。[[until]] 秒までを評価する。発報しなければ None。欠測の期間は、違反に数えない。 */
  def firstFiring(
      defn: AlarmDefinition,
      samples: List[Sample],
      trainingActive: Boolean,
      until: Int
  ): Option[Int] =
    if defn.requiresTraining && !trainingActive then None
    else
      val periods = until / defn.periodSeconds
      val breaching: Vector[Boolean] = (0 until periods).toVector.map { k =>
        val from = k * defn.periodSeconds
        val values =
          samples
            .filter(s => s.timeSeconds >= from && s.timeSeconds < from + defn.periodSeconds)
            .map(_.value)
        breaches(defn, aggregate(defn, values))
      }
      (defn.datapoints to periods)
        .find(end => breaching.slice(end - defn.datapoints, end).forall(identity))
        .map(_ * defn.periodSeconds)
