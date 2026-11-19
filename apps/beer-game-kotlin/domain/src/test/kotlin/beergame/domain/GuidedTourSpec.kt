package beergame.domain

import io.kotest.core.spec.style.FunSpec
import io.kotest.matchers.collections.shouldContain
import io.kotest.matchers.collections.shouldContainAll
import io.kotest.matchers.ints.shouldBeGreaterThanOrEqual
import io.kotest.matchers.ints.shouldBeLessThanOrEqual
import io.kotest.matchers.shouldBe
import io.kotest.matchers.string.shouldContain
import io.kotest.matchers.string.shouldMatch
import java.nio.file.Files

/** 注釈を走査する単体検査に使う、小さな入力。 */
private const val SAMPLE =
    """
package sample

/** 説明 */
@GuidedTour(
    name = "テスト",
    rank = 2,
    stage = "段階 A",
    description = "括弧 ) を含む" + "説明（全角）",
)
internal suspend fun Ports.sampleStep(
    value: Int,
): Int = value

@GuidedTour(name = "テスト", rank = 1, stage = "段階 A", description = "単一行")
@Other
class SampleType

@GuidedTour(name = "ツアー甲", rank = 1, stage = "段階 B", description = "繰り返し 1")
@GuidedTour(name = "ツアー乙", rank = 3, stage = "段階 C", description = "繰り返し 2")
fun repeated() = Unit
"""

/**
 * ガイドツアー（Living Documentation の Dynamic Curation。ガイド `docs/reference/ダイナミックキュレーション導入ガイド.md`）。
 * 注釈 [GuidedTour] を付けた要素を、ツアー名で分類し、rank の順に並べて、ステップの説明とともに案内する。
 * ツアーは 3 本（CQRS、イベントソーシング、ウォーキングスケルトン）で、どれも同じ仕組みで選ぶ。名前や場所は名指ししない（注釈で選ぶ）。
 * ステップの数・順序・段階・場所が崩れたら失敗にする。更新は `./gradlew :domain:generateLivingDocs`（`-Dbeergame.docs.update=true`）。
 */
class GuidedTourSpec :
    FunSpec({
        val steps by lazy { GuidedTours.steps(LivingDocumentation.repoRoot()) }

        fun tour(doc: TourDoc) = steps.filter { it.tour == doc.tour }.sortedBy { it.rank }

        test("[ツアー] 注釈の走査: 複数行・文字列の連結・文字列中の括弧・他の注釈・拡張関数の名前を、正しく読む") {
            val parsed = GuidedTours.parse(SAMPLE, "sample/Sample.kt")

            parsed.take(2).map { it.rank } shouldBe listOf(2, 1)
            parsed[0].description shouldBe "括弧 ) を含む説明（全角）"
            parsed[0].element shouldBe "Ports.sampleStep"
            parsed[0].kind shouldBe "関数"
            parsed[1].element shouldBe "SampleType"
            parsed[1].kind shouldBe "型"
            parsed.take(2).forEach { it.stage shouldBe "段階 A" }
        }

        test("[ツアー] 注釈の走査: 同じ要素に繰り返して付けた注釈は、どちらも同じ要素のステップになる（複数のツアーに出られる）") {
            val repeated = GuidedTours.parse(SAMPLE, "sample/Sample.kt").drop(2)

            repeated.map { it.tour } shouldBe listOf("ツアー甲", "ツアー乙")
            repeated.map { it.rank } shouldBe listOf(1, 3)
            repeated.map { it.element }.toSet() shouldBe setOf("repeated")
        }

        test("[ツアー] 注釈のあるツアーは、文書の定義（3 本）と過不足なく対応する（定義の無いツアー名・注釈の無い定義が無い）") {
            steps.map { it.tour }.toSet() shouldBe GuidedTours.docs.map { it.tour }.toSet()
            GuidedTours.docs
                .map { it.file }
                .toSet()
                .size shouldBe GuidedTours.docs.size
        }

        test("[ツアー] どのツアーも、rank が一意で、5〜10 ステップで、各ステップは説明と、ソースの場所（src/main の .kt）を持つ") {
            GuidedTours.docs.forEach { doc ->
                val tourSteps = tour(doc)
                tourSteps.size shouldBeGreaterThanOrEqual 5
                tourSteps.size shouldBeLessThanOrEqual GuidedTours.MAX_STEPS
                tourSteps.map { it.rank }.toSet().size shouldBe tourSteps.size
                tourSteps.forEach { step ->
                    step.description.isNotBlank() shouldBe true
                    step.file shouldMatch Regex("""^apps/beer-game-kotlin/[\w-]+/src/main/.+\.kt$""")
                    Files.exists(LivingDocumentation.repoRoot().resolve(step.file)) shouldBe true
                }
            }
        }

        test("[CQRS] コマンド側・イベントと投影・問い合わせ側の 3 段階で、コマンドの入口から読み取りまで順にたどる") {
            val cqrs = tour(GuidedTours.docs.first { it.file == "cqrs-tour.md" })
            val names = cqrs.map { it.element }

            cqrs.map { it.stage }.distinct() shouldBe listOf("コマンド側", "イベントと投影", "問い合わせ側")
            names shouldContainAll
                listOf(
                    "Route.commandRoutes",
                    "decideSession",
                    "JdbcEventStore",
                    "Projections",
                    "JdbcProjectionWriter",
                    "Route.queryRoutes",
                    "Ports.snapshot",
                    "JdbcProjectionReader",
                )
            names.first() shouldBe "Route.commandRoutes"
            names.indexOf("decideSession") shouldBeLessThanOrEqual names.indexOf("JdbcEventStore")
            names.indexOf("JdbcProjectionWriter") shouldBeLessThanOrEqual names.indexOf("Route.queryRoutes")
            names.last() shouldBe "JdbcProjectionReader"
            cqrs.map { step -> step.file.substringAfter("beer-game-kotlin/").substringBefore('/') } shouldContain
                "application"
        }

        test("[イベントソーシング] 事実を決める・事実を残す・状態を取り戻すの 3 段階で、事実が状態の唯一の正本になる流れをたどる") {
            val sourcing = tour(GuidedTours.docs.first { it.file == "event-sourcing-tour.md" })
            val names = sourcing.map { it.element }

            sourcing.map { it.stage }.distinct() shouldBe listOf("事実を決める", "事実を残す", "状態を取り戻す")
            names shouldBe
                listOf(
                    "decideSession",
                    "DomainEvent",
                    "EventEnvelope",
                    "Ports.applySingle",
                    "JdbcEventStore",
                    "EventCodec",
                    "replaySession",
                    "evolveSession",
                    "JdbcProjectionMaintenance",
                )
        }

        test("[ツアー] 同じ要素が複数のツアーに出られる（decideSession と JdbcEventStore は、CQRS とイベントソーシングの両方）") {
            val shared =
                steps
                    .groupBy { it.element }
                    .filterValues {
                        it
                            .map { step ->
                                step.tour
                            }.distinct()
                            .size > 1
                    }.keys

            shared shouldContainAll listOf("decideSession", "JdbcEventStore")
        }

        test("[CQRS] 図は案内の順序であり、実行時の呼び出しの順ではないことを、文書に添える（問い合わせ側は、投影を読むだけ）") {
            val doc = GuidedTours.docs.first { it.file == "cqrs-tour.md" }

            GuidedTours.markdown(doc, steps) shouldContain "矢印は、読む順序を示す"
        }

        test("[ウォーキングスケルトン] 準備（作成・参加・割り当て・開始）とプレイ（入力・確定・状態の表示）の 2 段階で、操作の順にたどる") {
            val skeleton = tour(GuidedTours.docs.first { it.file == "walking-skeleton-tour.md" })

            skeleton.map { it.stage }.distinct() shouldBe listOf("準備", "プレイ")
            skeleton.map { it.element } shouldBe
                listOf(
                    "Ports.createGame",
                    "Ports.joinGame",
                    "Ports.assignRole",
                    "Ports.startGame",
                    "Ports.saveDecision",
                    "Ports.commitWeek",
                    "Ports.snapshot",
                )
        }

        test("[ウォーキングスケルトン] 各ステップに、API の経路（仕様から）と、発行するイベント（注釈から）を添える。問い合わせは、イベントが無い") {
            val markdown = GuidedTours.markdown(GuidedTours.docs.first { it.file == "walking-skeleton-tour.md" }, steps)

            markdown shouldContain "`POST /games`（操作 `createGame`）"
            markdown shouldContain "`GET /sessions/{sessionId}/state`（操作 `getSessionState`）"
            markdown shouldContain "EV-G01 `GameCreated`"
            markdown shouldContain "EV-S08 `WeekCommitted`"
            // 割り当ては準備中の割り当て（EV-G03・EV-G04）だけ。開始後の入れ替え（EV-G12）は、最初の縦の切片の外
            markdown shouldContain "EV-G03 `RoleAssigned`"
            markdown shouldContain "EV-G04 `RoleUnassigned`"
            (markdown.contains("EV-G12")) shouldBe false
        }

        test("[ツアー] 生成した各ツアーが、コミット済みの docs/design/beer-game-kotlin/generated/ の文書と一致する") {
            GuidedTours.docs.forEach { doc ->
                val generated = GuidedTours.markdown(doc, steps)

                val committed =
                    LivingDocumentation.committedBody(
                        LivingDocumentation.designFile("generated/${doc.file}"),
                        generated,
                        GuidedTours.frontMatter(doc),
                    )

                committed shouldBe generated
            }
        }

        test("[ツアー] 全体の流れの PlantUML は、宣言した ASCII の別名だけを矢印の端に使う（壊れない）") {
            GuidedTours.docs.forEach { doc ->
                val diagram =
                    GuidedTours
                        .markdown(doc, steps)
                        .substringAfter("```plantuml\n")
                        .substringBefore("\n```")
                        .lines()
                val rectangle = Regex("""^\s*rectangle "[^"]+" as (\w+)$""")
                val declared = diagram.mapNotNull { rectangle.find(it)?.groupValues?.get(1) }
                val arrows = diagram.filter { it.contains(" --> ") }

                declared.toSet().size shouldBe declared.size
                arrows.isNotEmpty() shouldBe true
                arrows.forEach { line ->
                    line shouldMatch Regex("""^(\w+) --> (\w+)$""")
                    line.split(" --> ").forEach { declared shouldContain it }
                }
                diagram.first() shouldBe "@startuml"
                diagram.last() shouldBe "@enduml"
            }
        }
    })
