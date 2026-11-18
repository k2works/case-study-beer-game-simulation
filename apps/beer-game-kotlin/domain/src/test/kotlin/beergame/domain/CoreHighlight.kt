package beergame.domain

import java.nio.file.Files
import java.nio.file.Path

/*
 * コアのハイライト（Living Documentation の Dynamic Curation。ガイド `docs/reference/ダイナミックキュレーション導入ガイド.md`）。
 * - 読み手と目的: 新しく参加する開発者が、最初にどこを読めば、このゲームの核心が分かるか。
 * - 伝えたいメッセージ: 「ここが核心」。主要な概念だけを示す（数は [MAX_CORE] 以内。全部は載せない）。
 * - 選択基準: 注釈 [CoreConcept]。名前や場所は名指しせず、注釈で選ぶので、改名や移動に追従する。
 * - 正本: 設計書の「境界付けられたコンテキストの分類」の「中核」。コンテキストごとに、理由は設計書から読み、概念は注釈から選ぶ。
 */

/** 設計書の表の「中核」のコンテキスト。[reason] は、中核とされた理由（設計書の列）。 */
internal data class CoreContext(
    val name: String,
    val reason: String,
)

/** 注釈 [CoreConcept] を付けた要素 1 つ。[kind] は「関数」か「型」。 */
internal data class CoreElement(
    val kind: String,
    val name: String,
    val context: String,
    val description: String,
    val file: String,
)

internal object CoreHighlight {
    /** 付ける数の上限（ガイドの目安。最初は 3〜5 個から始め、多くても 10 個）。 */
    const val MAX_CORE = 10

    private const val DOMAIN_SOURCE = "apps/beer-game-kotlin/domain/src/main/kotlin/beergame/domain"

    /** 設計書の表（`| コンテキスト | 分類 | 理由 | …`）から、分類が「中核」の行を、表の順に読む。 */
    fun coreContexts(designText: String): List<CoreContext> {
        val row = Regex("""^\| (.+?) \| 中核 \| (.+?) \|""")
        return designText.lines().mapNotNull { line ->
            row.find(line)?.let { CoreContext(it.groupValues[1], it.groupValues[2]) }
        }
    }

    /** 注釈を付けた型と関数をすべて集める（リフレクション）。名前の昇順ではなく、コンテキスト・名前の順に整える。 */
    fun elements(root: Path): List<CoreElement> {
        val sources = domainSources(root)
        val fromTypes =
            LivingDocumentation.domainClasses().flatMap { type ->
                val onType =
                    type
                        .getAnnotation(
                            CoreConcept::class.java,
                        )?.let { listOf(Triple("型", type.simpleName, it)) }
                // 値クラスの引数を持つ関数は、名前に `-ハッシュ` が付くので、取り除く
                val onFunctions =
                    type.declaredMethods.mapNotNull { method ->
                        method.getAnnotation(CoreConcept::class.java)?.let {
                            Triple("関数", method.name.substringBefore('-'), it)
                        }
                    }
                onType.orEmpty() + onFunctions
            }
        return fromTypes
            .map { (kind, name, annotation) ->
                CoreElement(kind, name, annotation.context, annotation.description, locate(sources, kind, name))
            }.sortedWith(compareBy({ it.context }, { it.kind }, { it.name }))
    }

    /** domain のソース（相対パス → 本文）。 */
    private fun domainSources(root: Path): Map<String, String> =
        Files.list(root.resolve(DOMAIN_SOURCE)).use { stream ->
            stream
                .filter { it.fileName.toString().endsWith(".kt") }
                .toList()
                .associate { "$DOMAIN_SOURCE/${it.fileName}" to Files.readString(it) }
        }

    /** 宣言のあるソースの場所。見つからなければ、注釈の付いたコードと走査の前提がずれているので、失敗にする。 */
    private fun locate(
        sources: Map<String, String>,
        kind: String,
        name: String,
    ): String {
        val declaration =
            if (kind == "関数") {
                Regex("""^fun ${Regex.escape(name)}\(""", RegexOption.MULTILINE)
            } else {
                Regex(
                    """^(?:sealed |data |value |enum )*(?:class|interface|object) ${Regex.escape(name)}\b""",
                    RegexOption.MULTILINE,
                )
            }
        return sources.entries.firstOrNull { declaration.containsMatchIn(it.value) }?.key
            ?: error("@CoreConcept を付けた$kind「$name」の宣言が、domain のソースに見つからない")
    }

    /** コアのハイライトの Markdown。中核のコンテキストごとに、理由・概念の表・（進行の）コアが生むイベントを示す。 */
    fun markdown(
        contexts: List<CoreContext>,
        elements: List<CoreElement>,
        events: List<EventRow>,
    ): String {
        val sections =
            contexts.map { context ->
                section(context, elements.filter { it.context == context.name }, events)
            }
        return (
            listOf(
                "# コアのハイライト（生成）",
                "",
                LivingDocumentation.GENERATED_NOTE,
                "",
                "**ここが核心。** このゲームの中核は、遅延と意思決定が変動を増幅する過程を忠実に計算すること（シミュレーション計算）と、",
                "4 役割の入力を揃えて週を一度だけ確定すること（進行）。新しく参加する人は、まず下の ${elements.size} つを読む。",
                "",
                "選び方: 注釈 `@CoreConcept` を付けた概念だけを、コンテキストごとに示す（名前や場所は名指ししない。改名や移動に追従する）。",
                "中核かどうかは、[ドメインモデル設計](../domain-model.md)の「境界付けられたコンテキストの分類」が正本で、",
                "補完・一般のコンテキストの概念は載せない（試験が検出する）。付ける数は ${CoreHighlight.MAX_CORE} 個以内に絞る。",
                "",
            ) + sections.flatMap { it + "" }
        ).joinToString("\n")
    }

    private fun section(
        context: CoreContext,
        elements: List<CoreElement>,
        events: List<EventRow>,
    ): List<String> {
        val rows =
            elements.map {
                "| ${it.kind} | `${it.name}` | `${it.file}` | ${LivingDocumentation.cell(it.description)} |"
            }
        val sessionEvents =
            if (context.name.startsWith("進行")) {
                events.filter {
                    it.stream == StreamType.SESSION
                }
            } else {
                emptyList()
            }
        return listOf(
            "## ${context.name}",
            "",
            "中核の理由（設計書）: ${LivingDocumentation.cell(context.reason)}",
            "",
            "| 種別 | 名前 | 場所 | なぜ核心か |",
            "| :--- | :--- | :--- | :--- |",
        ) + rows + eventLines(sessionEvents)
    }

    /** 進行のコアが事実として残すイベント（session ストリーム）。 */
    private fun eventLines(events: List<EventRow>): List<String> =
        if (events.isEmpty()) {
            emptyList()
        } else {
            listOf("", "コアが事実として残すイベント（session ストリーム。[イベント一覧](./events.md)）:", "") +
                events.map { "- ${it.id} `${it.name}`" }
        }
}
