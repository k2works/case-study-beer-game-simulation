package beergame.domain

import arrow.core.left
import arrow.core.nonEmptyListOf
import arrow.core.right
import io.kotest.core.spec.style.FunSpec
import io.kotest.matchers.shouldBe

private const val REASON = "需要は 0〜1000 の整数"

class GameSettingsSpec :
    FunSpec({
        context("[US1.1/AC1.1.1] キット準拠の設定を作る") {
            test("有効な最終週と需要系列から、キット準拠の費用方針と手動確定の設定ができる") {
                val demand = List(12) { 4 }
                GameSettings.kit(12, demand) shouldBe
                    GameSettings(w(12), demandOf(demand, 12), KitPreset.costPolicy, CommitMode.MANUAL).right()
            }
            test("週次計算の設定へ、最終週・需要・費用方針をそのまま渡す") {
                val settings = gameSettings(listOf(4, 8, 4))
                settings.simulation() shouldBe
                    SimulationSettings(w(3), demandOf(listOf(4, 8, 4), 3), KitPreset.costPolicy)
            }
            test("[US1.1/AC1.1.5] 最終週の境界 1 と 50 は受け付ける") {
                GameSettings.kit(1, listOf(4)).isRight() shouldBe true
                GameSettings.kit(50, List(50) { 4 }).isRight() shouldBe true
            }
        }

        context("[US1.1/AC1.1.2] 無効な設定は、対象の週と修正内容を、項目ごとにすべて集めて返す") {
            test("最終週 12 で第 5 週の需要が 1001 なら、対象は第 5 週で、修正内容（0〜1000 の整数）を示す") {
                val demand = List(12) { if (it == 4) 1001 else 4 }
                GameSettings.kit(12, demand) shouldBe
                    nonEmptyListOf<ValidationError>(ValidationError.DemandSeriesInvalid(5, REASON)).left()
            }
            test("複数の週が無効なら、すべての週を返す") {
                GameSettings.kit(3, listOf(-1, 4, 1001)) shouldBe
                    nonEmptyListOf<ValidationError>(
                        ValidationError.DemandSeriesInvalid(1, REASON),
                        ValidationError.DemandSeriesInvalid(3, REASON),
                    ).left()
            }
            test("最終週と需要系列の誤りも、一度にすべて集める") {
                GameSettings.kit(0, listOf(-1, 1001)) shouldBe
                    nonEmptyListOf<ValidationError>(
                        ValidationError.WeekOutOfRange(0, 50),
                        ValidationError.DemandSeriesInvalid(1, REASON),
                        ValidationError.DemandSeriesInvalid(2, REASON),
                    ).left()
            }
            test("最終週が範囲外（51）なら、最終週の誤りだけを返す") {
                GameSettings.kit(51, List(51) { 4 }) shouldBe
                    nonEmptyListOf<ValidationError>(ValidationError.WeekOutOfRange(51, 50)).left()
            }
            test("需要系列が最終週に届かないなら、届かない週を示す") {
                GameSettings.kit(5, listOf(4, 4, 4)) shouldBe
                    nonEmptyListOf<ValidationError>(
                        ValidationError.DemandSeriesInvalid(4, "需要系列が最終週（5）に届かない"),
                    ).left()
            }
        }

        context("[US1.2/AC1.2.1] 参加コードと保持日数") {
            listOf(7, 0).forEach { n ->
                test("参加コードが 8 桁未満（$n 桁）なら拒否する") {
                    JoinCode.of("1".repeat(n)) shouldBe ValidationError.JoinCodeInvalid(n).left()
                }
            }
            test("参加コードが 8 桁以上なら受け付け、値を保つ") {
                JoinCode.of("K7M2Q9XW").map { it.value } shouldBe "K7M2Q9XW".right()
            }
            listOf(0, 3651, -1).forEach { n ->
                test("[US1.1/AC1.1.1] 保持日数 $n は範囲外") {
                    RetentionDays.of(n) shouldBe ValidationError.RetentionOutOfRange(n).left()
                }
            }
            listOf(1, 90, 3650).forEach { n ->
                test("[US1.1/AC1.1.1] 保持日数 $n は受け付ける") {
                    RetentionDays.of(n).map { it.value } shouldBe n.right()
                }
            }
        }
    })
