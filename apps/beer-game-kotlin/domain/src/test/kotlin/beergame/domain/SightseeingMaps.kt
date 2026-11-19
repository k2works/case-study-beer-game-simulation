package beergame.domain

import java.nio.file.Files
import java.nio.file.Path

/*
 * サイトシーイング・マップ（Living Documentation の Dynamic Curation。ガイド
 * `docs/reference/ガイドツアー・サイトシーイング導入ガイド.md` 3 章）。注釈 [KeyLandmark] を付けた要素を、ソースの走査で集め、
 * マップごとに、区分でまとめて示す。順序は付けない（ガイドツアーとの違い）。見どころは 5〜7 個（多くても [MAX_LANDMARKS] 個）に絞る。
 */

/** マップの見どころ 1 つ。[map] はマップの名前、[layer] は区分、[element] は宣言の名前、[file] はリポジトリのルートからの相対パス。 */
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

    /** 生成するマップ。区分の並びは、アーキテクチャは「核」から「副作用」へ（依存の向き）、DDD は戦略から戦術へ。 */
    val docs: List<MapDoc> =
        listOf(
            MapDoc(
                map = "アプリケーションアーキテクチャ",
                file = "architecture-sightseeing-map.md",
                title = "アプリケーションアーキテクチャ",
                summary = "このアプリケーションの構造は、**核の純粋関数と、外側の薄い副作用の層**。",
                description = "アプリケーションの構造（核の純粋関数と、外側の薄い副作用の層）",
                categories =
                    listOf(
                        "核" to "副作用を持たない純粋な規則。入力から結果を決める。テストが速く、同じ入力は同じ結果になる",
                        "境界" to "核と副作用の層の間の約束。副作用を関数の束に閉じ込め、テストでは同じ型の関数に差し替える",
                        "組み立て" to "本物の実装を束ねて、アプリケーションを起動する唯一の場所。他の層は、ここを知らない",
                        "副作用" to "HTTP・データベースなどの外界との接点。薄く保ち、規則は核へ寄せる",
                    ),
                withDependencies = true,
            ),
            MapDoc(
                map = "ドメイン駆動設計（DDD）",
                file = "ddd-sightseeing-map.md",
                title = "DDD",
                summary = "このアプリケーションの設計は、**戦略的設計（言葉と、力を注ぐ場所）と、戦術的設計（モデルの部品）**で読む。",
                description = "ドメイン駆動設計（戦略的設計と戦術的設計）",
                categories =
                    listOf(
                        "戦略的設計" to "業務の言葉をそろえ、力を注ぐ場所（中核）を決める。何を作り込み、何を割り切るかの判断",
                        "戦術的設計" to "モデルの部品。集約・値オブジェクト・ドメインイベント・ドメインサービス・プロセスマネージャー",
                    ),
            ),
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
    fun frontMatter(doc: MapDoc): String =
        listOf(
            "---",
            "type: Design",
            "title: \"サイトシーイング・マップ（生成）: ${doc.title}\"",
            "description: \"${doc.description}の見どころを、注釈 @KeyLandmark から動的に選び出し、" +
                "順序なしで区分ごとに示す。まず見るべき場所の地図。手で編集しない。\"",
            "tags: [design, generated]",
            "status: draft",
            "---",
        ).joinToString("\n")

    /** 1 枚のマップの Markdown。区分ごとに、見どころを順序なしで示す。 */
    fun markdown(
        doc: MapDoc,
        landmarks: List<Landmark>,
    ): String {
        val order = doc.categories.map { it.first }
        val ofMap =
            landmarks.filter { it.map == doc.map }.sortedWith(compareBy({ order.indexOf(it.layer) }, { it.element }))
        val dependencies =
            if (doc.withDependencies) {
                listOf(
                    "### 層の間の依存の向き",
                    "",
                    "ビルドの定義（各モジュールの `build.gradle.kts`）から導いた、モジュールの依存。内側は、外側を知らない。",
                    "",
                ) + dependencyLines(LivingDocumentation.repoRoot()) + listOf("")
            } else {
                emptyList()
            }
        return (
            listOf(
                "# サイトシーイング・マップ（生成）: ${doc.map}",
                "",
                LivingDocumentation.GENERATED_NOTE,
                "",
                "${doc.summary}まず見るべき場所を、${ofMap.size} つに絞って示す。",
                "見どころは、注釈 `@KeyLandmark` を付けた要素を、ソースの走査で集めたもの（名前や場所は名指ししない）。",
                "順序は付けない（処理の流れを順にたどるには、[ガイドツアー](./cqrs-tour.md)を使う）。",
                "",
                "## 全体の構成",
                "",
                "見どころを、区分ごとの枠に並べる（順序は付けない。枠の間に矢印は引かない）。",
                "",
                "```plantuml",
            ) + diagram(doc, ofMap) + listOf("```", "") + dependencies + sections(doc, ofMap)
        ).joinToString("\n")
    }

    /**
     * 見どころを、区分ごとの枠にまとめた図。**矢印は引かない**（見どころ同士の依存を、誤って示さない。順序を持たないマップなので）。
     * 層の間の依存の向きは、ビルドの定義から導いて、文章で示す（[dependencyLines]）。
     */
    private fun diagram(
        doc: MapDoc,
        ofMap: List<Landmark>,
    ): List<String> {
        val alias = ofMap.withIndex().associate { (index, landmark) -> landmark to "L${index + 1}" }
        val frames =
            doc.categories.flatMap { (category, _) ->
                val group = ofMap.filter { it.layer == category }
                if (group.isEmpty()) {
                    emptyList()
                } else {
                    listOf("package \"$category\" {") + group.map { "  [${it.element}] as ${alias.getValue(it)}" } +
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

    /** 区分ごとの本文。区分の意味と、見どころ（名前・説明・場所）。 */
    private fun sections(
        doc: MapDoc,
        ofMap: List<Landmark>,
    ): List<String> =
        doc.categories.flatMap { (category, meaning) ->
            val group = ofMap.filter { it.layer == category }
            if (group.isEmpty()) {
                emptyList()
            } else {
                listOf("### $category", "", meaning, "") + group.map(::landmarkLines).flatten()
            }
        }

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
