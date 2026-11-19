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

@KeyLandmark(map = "試験", layer = "核", description = "注釈クラスも見どころにできる")
annotation class LandmarkAnnotation(val value: String)

@GuidedTour(name = "ツアー", rank = 1, stage = "段階", description = "別の注釈は読まない")
fun notALandmark() = Unit
"""

/**
 * サイトシーイング・マップ（Living Documentation の Dynamic Curation。ガイド
 * `docs/reference/ガイドツアー・サイトシーイング導入ガイド.md` 3 章）。注釈 [KeyLandmark] を付けた要素を、順序を付けずに、
 * 区分ごとにまとめて示す。マップは 2 枚（アプリケーションアーキテクチャ、DDD）で、どれも同じ仕組みで選ぶ。
 * 見どころは 5〜7 個（多くても 10 個）に絞る。名前や場所は名指ししない（注釈で選ぶ）。
 * 数・区分・場所・図の別名が崩れたら失敗にする。更新は `./gradlew :domain:generateLivingDocs`（`-Dbeergame.docs.update=true`）。
 */
class SightseeingMapSpec :
    FunSpec({
        val landmarks by lazy { SightseeingMaps.landmarks(LivingDocumentation.repoRoot()) }

        fun mapOf(file: String) = SightseeingMaps.docs.first { it.file == file }

        fun landmarksOf(doc: MapDoc) = landmarks.filter { it.map == doc.map }.sortedBy { it.element }

        val architectureDoc = mapOf("architecture-sightseeing-map.md")
        val dddDoc = mapOf("ddd-sightseeing-map.md")
        val architecture by lazy { landmarksOf(architectureDoc) }
        val ddd by lazy { landmarksOf(dddDoc) }

        test("[マップ] 注釈の走査: 複数行・文字列の連結・文字列中の括弧・他の注釈・注釈クラス・順序（rank）を持たないことを、正しく読む") {
            val parsed = SightseeingMaps.parse(SAMPLE, "sample/Sample.kt")

            parsed.size shouldBe 3
            parsed[0].element shouldBe "landmarkFunction"
            parsed[0].kind shouldBe "関数"
            parsed[0].layer shouldBe "核"
            parsed[0].description shouldBe "括弧 ) を含む説明（全角）"
            parsed[1].element shouldBe "LandmarkType"
            parsed[1].kind shouldBe "型"
            parsed[2].element shouldBe "LandmarkAnnotation"
            parsed[2].kind shouldBe "型"
            parsed.forEach { it.map shouldBe "試験" }
        }

        test("[マップ] 注釈のあるマップは、文書の定義（2 枚）と過不足なく対応する（定義の無いマップ名・注釈の無い定義が無い）") {
            landmarks.map { it.map }.toSet() shouldBe SightseeingMaps.docs.map { it.map }.toSet()
            SightseeingMaps.docs
                .map { it.file }
                .toSet()
                .size shouldBe SightseeingMaps.docs.size
        }

        test("[マップ] どのマップも、見どころは 5〜7 個に絞る（上限 10。多すぎると、意味が薄れる）。名前は一意で、区分は定義の中にある") {
            SightseeingMaps.docs.forEach { doc ->
                val ofMap = landmarksOf(doc)
                ofMap.size shouldBeGreaterThanOrEqual 5
                ofMap.size shouldBeLessThanOrEqual 7
                ofMap.size shouldBeLessThanOrEqual SightseeingMaps.MAX_LANDMARKS
                ofMap.map { it.element }.toSet().size shouldBe ofMap.size
                ofMap.map { it.layer }.toSet() shouldContainAll doc.categories.map { it.first }
                ofMap.all { it.layer in doc.categories.map { category -> category.first } } shouldBe true
            }
        }

        test("[マップ] 各見どころは、説明が空でなく、ソースの場所（src/main の .kt）が見つかる") {
            SightseeingMaps.docs.flatMap { landmarksOf(it) }.forEach { landmark ->
                landmark.description.isNotBlank() shouldBe true
                landmark.file shouldMatch Regex("""^apps/beer-game-kotlin/[\w-]+/src/main/.+\.kt$""")
                Files.exists(LivingDocumentation.repoRoot().resolve(landmark.file)) shouldBe true
            }
        }

        test("[アーキテクチャ] 核は domain と application の純粋関数、副作用の層は adapter のモジュール、組み立ては app にある") {
            val byLayer = architecture.groupBy { it.layer }

            fun modules(layer: String) =
                byLayer.getValue(layer).map { it.file.substringAfter("beer-game-kotlin/").substringBefore('/') }

            modules("核").toSet() shouldBe setOf("domain", "application")
            modules("副作用").toSet() shouldBe setOf("adapter-http", "adapter-persistence")
            modules("組み立て") shouldBe listOf("app")
            modules("境界") shouldBe listOf("application")
        }

        test("[アーキテクチャ] 主要な見どころ（週の計算・進行の規則・副作用の束・開示の規則・組み立て・HTTP の入口・永続化の入口）を含む") {
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

        test("[DDD] 戦略的設計（ユビキタス言語・中核の識別）と戦術的設計（集約・値オブジェクト・イベント・サービス・手続き）の見どころがある") {
            val byCategory = ddd.groupBy { it.layer }

            byCategory.getValue("戦略的設計").map { it.element }.toSet() shouldBe setOf("Term", "CoreConcept")
            byCategory.getValue("戦術的設計").map { it.element }.toSet() shouldBe
                setOf("SessionState", "Quantity", "SessionEvent", "simulateWeek", "RetentionSaga")
        }

        test("[DDD] 戦術的設計の見どころは、説明に DDD の部品の名前（集約・値オブジェクト・ドメインイベント・ドメインサービス・プロセスマネージャー）を持つ") {
            val tactical = ddd.filter { it.layer == "戦術的設計" }.associate { it.element to it.description }

            tactical.getValue("SessionState") shouldContainText "集約"
            tactical.getValue("Quantity") shouldContainText "値オブジェクト"
            tactical.getValue("SessionEvent") shouldContainText "ドメインイベント"
            tactical.getValue("simulateWeek") shouldContainText "ドメインサービス"
            tactical.getValue("RetentionSaga") shouldContainText "プロセスマネージャー"
        }

        test("[DDD] 設計書の「中核」と整合する: 戦略的設計の見どころは、中核の識別（@CoreConcept）と、設計書のコンテキスト分類を指す") {
            val design = Files.readString(LivingDocumentation.designFile("domain-model.md"))
            val coreContexts = CoreHighlight.coreContexts(design).map { it.name }

            coreContexts shouldBe listOf("シミュレーション計算", "進行（プレイ）")
            ddd.first { it.element == "CoreConcept" }.description shouldContainText "中核"
        }

        test("[マップ] 順序を持たない: どの文書も、順序を示す番号や矢印を使わず、区分ごとの一覧で示す") {
            SightseeingMaps.docs.forEach { doc ->
                val markdown = SightseeingMaps.markdown(doc, landmarks)

                markdown shouldContainText "順序は付けない"
                markdown.lines().filter { it.startsWith("#### ") }.forEach {
                    it shouldMatch Regex("""^#### `[^`]+`（[^）]+）$""")
                }
            }
        }

        test("[マップ] 生成した各マップが、コミット済みの docs/design/beer-game-kotlin/generated/ の文書と一致する") {
            SightseeingMaps.docs.forEach { doc ->
                val generated = SightseeingMaps.markdown(doc, landmarks)

                val committed =
                    LivingDocumentation.committedBody(
                        LivingDocumentation.designFile("generated/${doc.file}"),
                        generated,
                        SightseeingMaps.frontMatter(doc),
                    )

                committed shouldBe generated
            }
        }

        test("[マップ] 図は、区分の枠に見どころを並べるだけで、矢印を引かない（見どころ同士の依存を、誤って示さない）") {
            SightseeingMaps.docs.forEach { doc ->
                val diagram =
                    SightseeingMaps
                        .markdown(doc, landmarks)
                        .substringAfter("```plantuml\n")
                        .substringBefore("\n```")
                        .lines()
                val component = Regex("""^\s*\[[^\]]+\] as (\w+)$""")
                val declared = diagram.mapNotNull { component.find(it)?.groupValues?.get(1) }

                declared.toSet().size shouldBe declared.size
                declared.size shouldBe landmarksOf(doc).size
                diagram.filter { it.contains("-->") || it.contains("..>") } shouldBe emptyList()
                diagram.first() shouldBe "@startuml"
                diagram.last() shouldBe "@enduml"
            }
        }

        test("[アーキテクチャ] 層の間の依存の向きは、ビルドの定義（モジュールの依存）から導いて、文章で示す（手で書かない）") {
            val dependencies = SightseeingMaps.moduleDependencies(LivingDocumentation.repoRoot())
            val markdown = SightseeingMaps.markdown(architectureDoc, landmarks)

            dependencies.getValue("application") shouldBe setOf("domain")
            dependencies.getValue("adapter-http") shouldContainAll setOf("application", "domain")
            dependencies.getValue("adapter-persistence") shouldContainAll setOf("application", "domain")
            dependencies.getValue("app") shouldContainAll setOf("adapter-http", "adapter-persistence", "application")
            // 内側（domain）は、どのモジュールにも依存しない
            dependencies.getValue("domain") shouldBe emptySet()
            markdown shouldContainText "`application` は `domain` に依存する"
            markdown shouldContainText "`app` は `adapter-http`"
            // DDD のマップには、モジュールの依存の文章を載せない（目的が違う）
            SightseeingMaps.markdown(dddDoc, landmarks).contains("層の間の依存の向き") shouldBe false
        }
    })
