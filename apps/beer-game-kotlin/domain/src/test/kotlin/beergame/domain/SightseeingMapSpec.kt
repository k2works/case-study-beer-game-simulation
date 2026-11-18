package beergame.domain

import io.kotest.core.spec.style.FunSpec
import io.kotest.matchers.collections.shouldContain
import io.kotest.matchers.collections.shouldContainAll
import io.kotest.matchers.ints.shouldBeGreaterThanOrEqual
import io.kotest.matchers.ints.shouldBeLessThanOrEqual
import io.kotest.matchers.shouldBe
import io.kotest.matchers.string.shouldMatch
import java.nio.file.Files
import io.kotest.matchers.string.shouldContain as shouldContainText

/** 注釈を走査する単体検査に使う、小さな入力。順序を持たない（rank が無い）ことが、ガイドツアーとの違い。 */
private const val SAMPLE =
    """
package sample

/** 説明 */
@KeyLandmark(
    map = "試験",
    layer = "核",
    description = "括弧 ) を含む" + "説明（全角）",
)
fun landmarkFunction(value: Int): Int = value

@KeyLandmark(map = "試験", layer = "境界", description = "単一行")
@Other
class LandmarkType

@GuidedTour(name = "ツアー", rank = 1, stage = "段階", description = "別の注釈は読まない")
fun notALandmark() = Unit
"""

/**
 * サイトシーイング・マップ（Living Documentation の Dynamic Curation。ガイド
 * `docs/reference/ガイドツアー・サイトシーイング導入ガイド.md` 3 章）。注釈 [KeyLandmark] を付けた要素を、順序を付けずに、
 * 層ごとにまとめて示す。見どころは 5〜7 個（多くても 10 個）に絞る。名前や場所は名指ししない（注釈で選ぶ）。
 * 数・層・場所・図の別名が崩れたら失敗にする。更新は `./gradlew :domain:generateLivingDocs`（`-Dbeergame.docs.update=true`）。
 */
class SightseeingMapSpec :
    FunSpec({
        val landmarks by lazy { SightseeingMaps.landmarks(LivingDocumentation.repoRoot()) }
        val architecture by lazy { landmarks.filter { it.map == SightseeingMaps.ARCHITECTURE }.sortedBy { it.element } }

        test("[マップ] 注釈の走査: 複数行・文字列の連結・文字列中の括弧・他の注釈・順序（rank）を持たないことを、正しく読む") {
            val parsed = SightseeingMaps.parse(SAMPLE, "sample/Sample.kt")

            parsed.size shouldBe 2
            parsed[0].element shouldBe "landmarkFunction"
            parsed[0].kind shouldBe "関数"
            parsed[0].layer shouldBe "核"
            parsed[0].description shouldBe "括弧 ) を含む説明（全角）"
            parsed[1].element shouldBe "LandmarkType"
            parsed[1].kind shouldBe "型"
            parsed.forEach { it.map shouldBe "試験" }
        }

        test("[マップ] アプリケーションアーキテクチャの見どころは、5〜7 個に絞る（上限 10。多すぎると、意味が薄れる）") {
            architecture.size shouldBeGreaterThanOrEqual 5
            architecture.size shouldBeLessThanOrEqual 7
            architecture.size shouldBeLessThanOrEqual SightseeingMaps.MAX_LANDMARKS
            architecture.map { it.element }.toSet().size shouldBe architecture.size
        }

        test("[マップ] 核・境界・組み立て・副作用の層のすべてに、見どころがある（アーキテクチャの構造が偏らず見える）") {
            val layers = architecture.map { it.layer }.toSet()

            layers shouldContainAll SightseeingMaps.LAYERS
            layers.all { it in SightseeingMaps.LAYERS } shouldBe true
        }

        test("[マップ] 核の見どころは domain と application の純粋関数、副作用の層の見どころは adapter のモジュールにある") {
            val byLayer = architecture.groupBy { it.layer }

            fun modules(layer: String) =
                byLayer.getValue(layer).map { it.file.substringAfter("beer-game-kotlin/").substringBefore('/') }

            modules("核").toSet() shouldBe setOf("domain", "application")
            modules("副作用").toSet() shouldBe setOf("adapter-http", "adapter-persistence")
            modules("組み立て") shouldBe listOf("app")
            modules("境界") shouldBe listOf("application")
        }

        test("[マップ] 各見どころは、説明が空でなく、ソースの場所（src/main の .kt）が見つかる") {
            architecture.forEach { landmark ->
                landmark.description.isNotBlank() shouldBe true
                landmark.file shouldMatch Regex("""^apps/beer-game-kotlin/[\w-]+/src/main/.+\.kt$""")
                Files.exists(LivingDocumentation.repoRoot().resolve(landmark.file)) shouldBe true
            }
        }

        test("[マップ] 主要な見どころ（週の計算・進行の規則・副作用の束・開示の規則・組み立て・HTTP の入口・永続化の入口）を含む") {
            architecture.map { it.element } shouldContainAll
                listOf(
                    "simulateWeek",
                    "decideSession",
                    "Ports",
                    "Disclosure",
                    "appPorts",
                    "Route.commandRoutes",
                    "JdbcEventStore",
                )
        }

        test("[マップ] 順序を持たない: 文書は、順序を示す番号や矢印を使わず、層ごとの一覧で示す") {
            val markdown = SightseeingMaps.markdown(SightseeingMaps.ARCHITECTURE, landmarks)

            markdown shouldContainText "順序は付けない"
            markdown.lines().filter { it.startsWith("#### ") }.forEach {
                it shouldMatch
                    Regex("""^#### `[^`]+`（[^）]+）$""")
            }
        }

        test("[マップ] 生成したマップが、コミット済みの docs/design/beer-game-kotlin/generated/ の文書と一致する") {
            val generated = SightseeingMaps.markdown(SightseeingMaps.ARCHITECTURE, landmarks)

            val committed =
                LivingDocumentation.committedBody(
                    LivingDocumentation.designFile("generated/${SightseeingMaps.FILE}"),
                    generated,
                    SightseeingMaps.frontMatter(),
                )

            committed shouldBe generated
        }

        test("[マップ] 図は、層の枠に見どころを並べるだけで、矢印を引かない（見どころ同士の依存を、誤って示さない）") {
            val diagram =
                SightseeingMaps
                    .markdown(SightseeingMaps.ARCHITECTURE, landmarks)
                    .substringAfter("```plantuml\n")
                    .substringBefore("\n```")
                    .lines()
            val component = Regex("""^\s*\[[^\]]+\] as (\w+)$""")
            val declared = diagram.mapNotNull { component.find(it)?.groupValues?.get(1) }

            declared.toSet().size shouldBe declared.size
            declared.size shouldBe architecture.size
            diagram.filter { it.contains("-->") || it.contains("..>") } shouldBe emptyList()
            diagram.first() shouldBe "@startuml"
            diagram.last() shouldBe "@enduml"
        }

        test("[マップ] 層の間の依存の向きは、ビルドの定義（モジュールの依存）から導いて、文章で示す（手で書かない）") {
            val dependencies = SightseeingMaps.moduleDependencies(LivingDocumentation.repoRoot())
            val markdown = SightseeingMaps.markdown(SightseeingMaps.ARCHITECTURE, landmarks)

            dependencies.getValue("application") shouldBe setOf("domain")
            dependencies.getValue("adapter-http") shouldContainAll setOf("application", "domain")
            dependencies.getValue("adapter-persistence") shouldContainAll setOf("application", "domain")
            dependencies.getValue("app") shouldContainAll setOf("adapter-http", "adapter-persistence", "application")
            // 内側（domain）は、どのモジュールにも依存しない
            dependencies.getValue("domain") shouldBe emptySet()
            markdown shouldContainText "`application` は `domain` に依存する"
            markdown shouldContainText "`app` は `adapter-http`"
        }
    })
