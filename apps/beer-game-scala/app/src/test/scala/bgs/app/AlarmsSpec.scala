package bgs.app

import bgs.application.Alarms
import munit.FunSuite

/** アラームの訓練（B13。AC6.1.3・AC6.1.5）。模擬の時計と、故障を模擬した入力を、閾値の表に与える。実際の待機はしない。 */
class AlarmsSpec extends FunSuite:

  import Alarms.Sample

  /** 5 秒ごとに成功する主要な操作（時刻 [from, until)）。 */
  private def successes(from: Int, until: Int): List[Sample] =
    (from until until by 5).toList.map(t => Sample(t, 1.0))

  test("[AC6.1.5] 研修中に、時刻 120 秒に停止すると、停止から 60 秒以内に main-operation-stall が発報する") {
    val fired = Alarms.firstFiring(
      Alarms.MainOperationStall,
      successes(0, 120),
      trainingActive = true,
      until = 600
    )
    assertEquals(fired.map(_ - 120).exists(_ <= 60), true, fired.toString)
  }

  test("[AC6.1.5] 成功が 40 秒だけ途切れても、main-operation-stall は発報しない") {
    val series = successes(0, 120) ++ successes(160, 600)
    assertEquals(
      Alarms.firstFiring(Alarms.MainOperationStall, series, trainingActive = true, until = 600),
      None
    )
  }

  test("[AC6.1.5] 研修中でなければ、停止から 600 秒が過ぎても、main-operation-stall は発報しない") {
    assertEquals(
      Alarms.firstFiring(
        Alarms.MainOperationStall,
        successes(0, 120),
        trainingActive = false,
        until = 720
      ),
      None
    )
  }

  test("[AC6.1.5] 合成監視（60 秒ごと）の失敗は、停止から 120 秒以内に synthetic-failure が発報する") {
    val checks = (0 until 120 by 60).toList.map(t => Sample(t, 1.0)) ++
      (120 until 600 by 60).toList.map(t => Sample(t, 0.0))
    val fired =
      Alarms.firstFiring(Alarms.SyntheticFailure, checks, trainingActive = true, until = 600)
    assertEquals(fired.map(_ - 120).exists(_ <= 120), true, fired.toString)
  }

  test("[AC6.1.3] 追記の競合率が 1% から 30% に急増すると、警告と重大の両方が発報し、平常では発報しない") {
    val normal = (0 until 300 by 10).toList.map(t => Sample(t, 1.0))
    val spike = (300 until 900 by 10).toList.map(t => Sample(t, 30.0))
    assertEquals(
      Alarms.firstFiring(Alarms.AppendConflictWarning, normal, trainingActive = true, until = 300),
      None
    )
    val warning = Alarms.firstFiring(
      Alarms.AppendConflictWarning,
      normal ++ spike,
      trainingActive = true,
      until = 900
    )
    val critical = Alarms.firstFiring(
      Alarms.AppendConflictCritical,
      normal ++ spike,
      trainingActive = true,
      until = 900
    )
    assert(warning.isDefined && critical.isDefined, s"$warning / $critical")
    assert(warning.exists(w => critical.exists(w <= _)), "警告は重大より先か同時")
  }

  test("[AC6.1.3] JVM のヒープが 90% で 11 分続くと jvm-heap-critical が発報し、40% では発報しない") {
    val high = (0 until 660 by 10).toList.map(t => Sample(t, 90.0))
    val low = (0 until 660 by 10).toList.map(t => Sample(t, 40.0))
    assert(
      Alarms.firstFiring(Alarms.JvmHeapCritical, high, trainingActive = true, until = 660).isDefined
    )
    assertEquals(
      Alarms.firstFiring(Alarms.JvmHeapCritical, low, trainingActive = true, until = 660),
      None
    )
  }

  test("[定義] 閾値の表は、名前が一意で、すべて期間と評価の回数を持つ") {
    val names = Alarms.all.map(_.name)
    assertEquals(names.distinct, names)
    assert(Alarms.all.forall(a => a.periodSeconds > 0 && a.datapoints > 0))
  }
