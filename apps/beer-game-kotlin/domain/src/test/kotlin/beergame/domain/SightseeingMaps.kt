package beergame.domain

import java.nio.file.Files
import java.nio.file.Path

/*
 * サイトシーイング・マップ（Living Documentation の Dynamic Curation。ガイド
 * `docs/reference/ガイドツアー・サイトシーイング導入ガイド.md` 3 章）。注釈 [KeyLandmark] を付けた要素を、ソースの走査で集め、
 * マップごとに、層でまとめて示す。順序は付けない（ガイドツアーとの違い）。見どころは 5〜7 個（多くても [MAX_LANDMARKS] 個）に絞る。
 */

/** マップの見どころ 1 つ。[map] はマップの名前、[layer] は層、[element] は宣言の名前、[file] はリポジトリのルートからの相対パス。 */
internal data class Landmark(
    val map: String,
    val layer: String,
    val description: String,
    val kind: String,
    val element: String,
    val file: String,
)

internal object SightseeingMaps {
    /** マップ 1 枚あたりの見どころの上限（ガイドの目安は 5〜7 個で、多くても 10 個）。 */
    const val MAX_LANDMARKS = 10

    /** 生成するマップの名前（注釈の `map` と同じ）。 */
    const val ARCHITECTURE = "アプリケーションアーキテクチャ"

    /** 文書のファイル名（`generated/` の中）。 */
    const val FILE = "architecture-sightseeing-map.md"

    /**
     * 層の名前と、その意味。マップの見出しの順序で、「核」から「副作用」の順に、依存の向き（外側が内側に依存する）を物語る。
     * 注釈の `layer` は、この名前のどれかにする（試験が検出する）。
     */
    val LAYERS: List<String> = listOf("核", "境界", "組み立て", "副作用")

    private val LAYER_MEANING =
        mapOf(
            "核" to "副作用を持たない純粋な規則。入力から結果を決める。テストが速く、同じ入力は同じ結果になる",
            "境界" to "核と副作用の層の間の約束。副作用を関数の束に閉じ込め、テストでは同じ型の関数に差し替える",
            "組み立て" to "本物の実装を束ねて、アプリケーションを起動する唯一の場所。他の層は、ここを知らない",
            "副作用" to "HTTP・データベースなどの外界との接点。薄く保ち、規則は核へ寄せる",
        )

    /** すべてのモジュールの `src/main` から、見どころを集める。 */
    fun landmarks(root: Path): List<Landmark> = AnnotationScanner.scan(root, "KeyLandmark").map(::landmark)

    /** 1 つのソースから、[KeyLandmark] の注釈を読む。注釈の直後の宣言（他の注釈を挟んでもよい）が、見どころの要素。 */
    fun parse(
        source: String,
        file: String,
    ): List<Landmark> = AnnotationScanner.parse(source, file, "KeyLandmark").map(::landmark)

    private fun landmark(found: FoundAnnotation): Landmark =
        Landmark(
            map = AnnotationScanner.text(found, "map"),
            layer = AnnotationScanner.text(found, "layer"),
            description = AnnotationScanner.text(found, "description"),
            kind = found.kind,
            element = found.element,
            file = found.file,
        )

    /** 文書のフロントマター（更新モードで、新しい文書に付ける）。 */
    fun frontMatter(): String =
        listOf(
            "---",
            "type: Design",
            "title: \"サイトシーイング・マップ（生成）: アプリケーションアーキテクチャ\"",
            "description: \"アプリケーションの構造（核の純粋関数と、外側の薄い副作用の層）の見どころを、注釈 @KeyLandmark から" +
                "動的に選び出し、順序なしで層ごとに示す。まず見るべき場所の地図。手で編集しない。\"",
            "tags: [design, generated]",
            "status: draft",
            "---",
        ).joinToString("\n")

    /** 1 枚のマップの Markdown。層ごとに、見どころを順序なしで示す。 */
    fun markdown(
        map: String,
        landmarks: List<Landmark>,
    ): String {
        val ofMap =
            landmarks.filter { it.map == map }.sortedWith(
                compareBy({ LAYERS.indexOf(it.layer) }, { it.element }),
            )
        return (
            listOf(
                "# サイトシーイング・マップ（生成）: $map",
                "",
                LivingDocumentation.GENERATED_NOTE,
                "",
                "このアプリケーションの構造は、**核の純粋関数と、外側の薄い副作用の層**。まず見るべき場所を、${ofMap.size} つに絞って示す。",
                "見どころは、注釈 `@KeyLandmark` を付けた要素を、ソースの走査で集めたもの（名前や場所は名指ししない）。",
                "順序は付けない（処理の流れを順にたどるには、[ガイドツアー](./cqrs-tour.md)を使う）。",
                "",
                "## 全体の構成",
                "",
                "見どころを、層ごとの枠に並べる（順序は付けない。枠の間に矢印は引かない）。",
                "",
                "```plantuml",
            ) + diagram(ofMap) + listOf("```", "") +
                listOf(
                    "### 層の間の依存の向き",
                    "",
                    "ビルドの定義（各モジュールの `build.gradle.kts`）から導いた、モジュールの依存。内側は、外側を知らない。",
                    "",
                ) + dependencyLines(LivingDocumentation.repoRoot()) + listOf("") + layers(ofMap)
        ).joinToString("\n")
    }

    /**
     * 見どころを、層ごとの枠にまとめた図。**矢印は引かない**（見どころ同士の依存を、誤って示さない。順序を持たないマップなので）。
     * 層の間の依存の向きは、ビルドの定義から導いて、文章で示す（[dependencyLines]）。
     */
    private fun diagram(ofMap: List<Landmark>): List<String> {
        val alias = ofMap.withIndex().associate { (index, landmark) -> landmark to "L${index + 1}" }
        val frames =
            LAYERS.flatMap { layer ->
                val group = ofMap.filter { it.layer == layer }
                if (group.isEmpty()) {
                    emptyList()
                } else {
                    listOf("package \"$layer\" {") + group.map { "  [${it.element}] as ${alias.getValue(it)}" } +
                        listOf("}")
                }
            }
        return listOf("@startuml", "left to right direction") + frames + listOf("@enduml")
    }

    /** モジュールごとの、依存するモジュール（`build.gradle.kts` の `project(":…")`）。ビルドの定義が正本。 */
    fun moduleDependencies(root: Path): Map<String, Set<String>> =
        listOf("domain", "application", "adapter-persistence", "adapter-http", "app").associateWith { module ->
            val build = root.resolve("apps/beer-game-kotlin/$module/build.gradle.kts")
            Regex("""project\(":([\w-]+)"\)""")
                .findAll(Files.readString(build))
                .map { it.groupValues[1] }
                .toSet()
        }

    /** 依存の向きの文章。「A は B に依存する」を、モジュールごとに 1 行ずつ（ビルドの定義から導いたもの）。 */
    private fun dependencyLines(root: Path): List<String> =
        moduleDependencies(root).map { (module, dependsOn) ->
            if (dependsOn.isEmpty()) {
                "- `$module` は、どのモジュールにも依存しない（最も内側）"
            } else {
                "- `$module` は ${dependsOn.sorted().joinToString("、") { "`$it`" }} に依存する"
            }
        }

    private fun layers(ofMap: List<Landmark>): List<String> =
        LAYERS.flatMap { layer ->
            val group = ofMap.filter { it.layer == layer }
            if (group.isEmpty()) emptyList() else layerLines(layer, group)
        }

    /** 1 つの層の本文。層の意味と、見どころ（名前・説明・場所）。 */
    private fun layerLines(
        layer: String,
        group: List<Landmark>,
    ): List<String> =
        listOf("### $layer", "", LAYER_MEANING.getValue(layer), "") +
            group.map { landmarkLines(it) }.flatten()

    private fun landmarkLines(landmark: Landmark): List<String> =
        listOf(
            "#### `${landmark.element}`（${landmark.kind}）",
            "",
            LivingDocumentation.cell(landmark.description),
            "",
            "場所: `${landmark.file}`",
            "",
        )
}
