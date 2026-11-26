package bgs.domain

import munit.FunSuite

/** ゲーム設定の検証（AC1.1.1・AC1.1.2）。入力の誤りは、項目ごとにすべて集めて返す。 */
class GameSettingsSpec extends FunSuite:

  test("[AC1.1.1] 有効なキット準拠の設定は作れ、費用はキットの値になる") {
    val settings = GameSettings.kit(12, List.fill(12)(4), CommitMode.Manual)
    assert(settings.isValid)
    settings.toOption.foreach { s =>
      assertEquals(s.finalWeek.value, 12)
      assertEquals(s.costPolicy, KitPreset.costPolicy)
      assertEquals(s.commitMode, CommitMode.Manual)
    }
  }

  test("[AC1.1.2] 第 5 週の需要が 1001 なら、対象の週（5）と修正内容を示す") {
    val errors = GameSettings
      .kit(12, List(4, 4, 4, 4, 1001, 4, 4, 4, 4, 4, 4, 4), CommitMode.Manual)
      .fold(_.toNonEmptyList.toList, _ => Nil)
    assertEquals(errors, List(ValidationError.DemandSeriesInvalid(5, "需要は 0 以上 1000 以下の整数にしてください")))
  }

  test("[AC1.1.2] 複数の誤りは、1 つで止めずにすべて集める（第 2 週が負、第 5 週が 1001）") {
    val errors = GameSettings
      .kit(12, List(4, -1, 4, 4, 1001, 4, 4, 4, 4, 4, 4, 4), CommitMode.Manual)
      .fold(_.toNonEmptyList.toList, _ => Nil)
    assertEquals(
      errors,
      List(
        ValidationError.DemandSeriesInvalid(2, "需要は 0 以上 1000 以下の整数にしてください"),
        ValidationError.DemandSeriesInvalid(5, "需要は 0 以上 1000 以下の整数にしてください")
      )
    )
  }

  test("[AC1.1.2] 最終週が範囲外でも、需要系列の誤りも一緒に返す") {
    val errors = GameSettings
      .kit(51, List(1001), CommitMode.Manual)
      .fold(_.toNonEmptyList.toList, _ => Nil)
    assertEquals(
      errors,
      List(
        ValidationError.WeekOutOfRange(51, 50),
        ValidationError.DemandSeriesInvalid(1, "需要は 0 以上 1000 以下の整数にしてください")
      )
    )
  }

  test("[AC1.1.2] 各週が正しくても、系列が最終週に届かないなら誤り") {
    val errors = GameSettings
      .kit(12, List.fill(11)(4), CommitMode.Manual)
      .fold(_.toNonEmptyList.toList, _ => Nil)
    assertEquals(errors, List(ValidationError.DemandSeriesInvalid(12, "需要系列が最終週（12）に届かない")))
  }

  test("[表示名] 前後の空白を除いて 1〜80 文字（コードポイント数）") {
    assertEquals(DisplayName.of("  太郎  ").map(_.value), Right("太郎"))
    assertEquals(DisplayName.of("   "), Left(ValidationError.DisplayNameInvalid(0)))
    assertEquals(DisplayName.of("あ".repeat(81)), Left(ValidationError.DisplayNameInvalid(81)))
    assertEquals(DisplayName.of("あ".repeat(80)).map(_.value.length), Right(80))
  }

  test("[参加コード] 8 文字以上") {
    assertEquals(JoinCode.of("ABCD2345").map(_.value), Right("ABCD2345"))
    assertEquals(JoinCode.of("ABC"), Left(ValidationError.JoinCodeInvalid(3)))
  }

  test("[保持日数] 1〜3650") {
    assertEquals(RetentionDays.of(1).map(_.value), Right(1))
    assertEquals(RetentionDays.of(0), Left(ValidationError.RetentionOutOfRange(0)))
    assertEquals(RetentionDays.of(3651), Left(ValidationError.RetentionOutOfRange(3651)))
  }
