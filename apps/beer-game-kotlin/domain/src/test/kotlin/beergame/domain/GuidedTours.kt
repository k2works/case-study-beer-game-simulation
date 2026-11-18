package beergame.domain

import java.nio.file.Files
import java.nio.file.Path

/*
 * ガイドツアー（Living Documentation の Dynamic Curation。ガイド `docs/reference/ダイナミックキュレーション導入ガイド.md` 5.4）。
 * ソースを走査して [GuidedTour] の付いた要素をすべて集め、ツアー名で分類し、rank の順に並べ、ステップの説明を取り出して Markdown にする。
 * 注釈は domain・application・adapter にまたがるので、リフレクションではなく、各モジュールの `src/main` を文字列として走査する
 * （追加の依存は無い。[LivingDocumentation] と同じ方式）。
 */

/** ツアーの 1 ステップ。[element] は宣言の名前（拡張関数は `Ports.saveDecision` の形）、[file] はリポジトリのルートからの相対パス。 */
internal data class TourStep(
    val tour: String,
    val rank: Int,
    val stage: String,
    val description: String,
    val kind: String,
    val element: String,
    val file: String,
)

/** ツアー 1 本が生む文書の定義。[tour] は注釈の `name`、[file] は `generated/` の中のファイル名。 */
internal data class TourDoc(
    val tour: String,
    val file: String,
    val title: String,
    val description: String,
    val intro: String,
    val withOperations: Boolean = false,
)

internal object GuidedTours {
    /** ツアー 1 本あたりのステップの上限（ガイドの目安は数ステップ）。 */
    const val MAX_STEPS = 10

    /** 文書にするツアー。ツアー名は、注釈の `name` と同じ（試験が、注釈のあるツアーと過不足なく対応するかを検査する）。 */
    val docs: List<TourDoc> =
        listOf(
            TourDoc(
                tour = "CQRS（コマンドと問い合わせの分離）",
                file = "cqrs-tour.md",
                title = "ガイドツアー（生成）: CQRS",
                description =
                    "コマンド側・イベントと投影・問い合わせ側の流れを、注釈 @GuidedTour から動的に選び出し、rank の順に案内する。" +
                        "処理の流れを追いたい開発者が、順に読む入口になる。手で編集しない。",
                intro = "処理の流れを、コマンド側 → イベントと投影 → 問い合わせ側の順に案内する。",
            ),
            TourDoc(
                tour = "ウォーキングスケルトン（最初の縦の切片）",
                file = "walking-skeleton-tour.md",
                title = "ガイドツアー（生成）: ウォーキングスケルトン",
                description =
                    "最初の縦の切片（1 ゲーム・4 役割・1 週）を、準備とプレイの操作の順に、注釈 @GuidedTour から動的に選び出して案内する。" +
                        "各操作の API の経路と発行するイベントを添える。手で編集しない。",
                intro = "最初の縦の切片（1 ゲーム・4 役割・1 週）を、準備（作成・参加・割り当て・開始）とプレイ（入力・確定・状態の表示）の操作の順に案内する。",
                withOperations = true,
            ),
        )

    /** 文書のフロントマター（更新モードで、新しい文書に付ける）。 */
    fun frontMatter(doc: TourDoc): String =
        listOf(
            "---",
            "type: Design",
            "title: \"${doc.title}\"",
            "description: \"${doc.description}\"",
            "tags: [design, generated]",
            "status: draft",
            "---",
        ).joinToString("\n")

    private const val APP = "apps/beer-game-kotlin"
    private val MODULES = listOf("domain", "application", "adapter-persistence", "adapter-http", "app")

    private const val MODIFIERS = "internal|private|public|suspend|inline|data|sealed|value|enum|open|abstract"
    private val DECLARATION =
        Regex("""^\s*(?:(?:$MODIFIERS)\s+)*(fun|class|interface|object)\s+(?:<[^>]*>\s*)?([\w.]+)""")

    /** すべてのモジュールの `src/main` から、ステップを集める。 */
    fun steps(root: Path): List<TourStep> =
        MODULES
            .map { root.resolve("$APP/$it/src/main") }
            .filter { Files.exists(it) }
            .flatMap { dir ->
                Files.walk(dir).use { stream -> stream.filter { it.toString().endsWith(".kt") }.toList() }
            }.sorted()
            .flatMap { parse(Files.readString(it), root.relativize(it).toString().replace('\\', '/')) }

    /** 1 つのソースから、[GuidedTour] の注釈を読む。注釈の直後の宣言（他の注釈を挟んでもよい）が、ステップの要素。 */
    fun parse(
        source: String,
        file: String,
    ): List<TourStep> {
        val marker = "@GuidedTour("
        val steps = mutableListOf<TourStep>()
        var from = source.indexOf(marker)
        while (from >= 0) {
            val argsStart = from + marker.length
            val argsEnd = closingParenthesis(source, argsStart)
            val args = source.substring(argsStart, argsEnd)
            val after = source.substring(argsEnd + 1)
            val declaration = nextDeclaration(after)
            steps += step(args, declaration, file)
            from = source.indexOf(marker, argsEnd)
        }
        return steps
    }

    /** [start] から始まる引数の、対応する閉じ括弧の位置。文字列リテラルの中の括弧と、エスケープした引用符は、数えない。 */
    private fun closingParenthesis(
        source: String,
        start: Int,
    ): Int {
        var depth = 1
        var inString = false
        var index = start
        while (index < source.length) {
            val c = source[index]
            when {
                inString && c == '\\' -> index++
                c == '"' -> inString = !inString
                !inString && c == '(' -> depth++
                !inString && c == ')' && --depth == 0 -> return index
            }
            index++
        }
        error("@GuidedTour の閉じ括弧が見つからない")
    }

    /** 注釈の後ろから、最初の宣言（fun・class・interface・object）を探す。注釈の行と KDoc の行は、読み飛ばす。 */
    private fun nextDeclaration(after: String): Pair<String, String> {
        val line =
            after
                .lines()
                .drop(1)
                .firstOrNull { DECLARATION.containsMatchIn(it) }
                ?: error("@GuidedTour の直後に宣言が見つからない")
        val match = DECLARATION.find(line) ?: error("宣言を読めない: $line")
        val kind = if (match.groupValues[1] == "fun") "関数" else "型"
        return kind to match.groupValues[2]
    }

    private fun step(
        args: String,
        declaration: Pair<String, String>,
        file: String,
    ): TourStep {
        fun text(name: String): String =
            Regex("""\b$name\s*=\s*((?:"(?:[^"\\]|\\.)*"\s*\+?\s*)+)""")
                .find(args)
                ?.groupValues
                ?.get(1)
                ?.let { literal ->
                    Regex(""""((?:[^"\\]|\\.)*)"""").findAll(literal).joinToString("") { it.groupValues[1] }
                }
                ?: error("@GuidedTour に $name が無い（$file）")
        val rank =
            Regex("""\brank\s*=\s*(\d+)""")
                .find(args)
                ?.groupValues
                ?.get(1)
                ?.toInt()
                ?: error("@GuidedTour に rank が無い（$file）")
        return TourStep(
            text("name"),
            rank,
            text("stage"),
            text("description"),
            declaration.first,
            declaration.second,
            file,
        )
    }

    /** 1 本のツアーの Markdown。rank の順に、段階ごとにまとめて示す。操作を持つツアーは、API の経路とイベントを添える。 */
    fun markdown(
        doc: TourDoc,
        steps: List<TourStep>,
    ): String {
        val ordered = steps.filter { it.tour == doc.tour }.sortedBy { it.rank }
        val operations = if (doc.withOperations) TourOperations.load(LivingDocumentation.repoRoot()) else null
        return (
            listOf(
                "# ${doc.title}",
                "",
                LivingDocumentation.GENERATED_NOTE,
                "",
                "${doc.intro}（${ordered.size} ステップ）",
                "ステップは、注釈 `@GuidedTour` を付けた要素を、ソースの走査で集めて、rank の順に並べたもの（名前や場所は名指ししない）。",
                "各ステップの説明は、注釈の `description` から取り出す。コマンドとイベントの対応は[イベント一覧](./events.md)を参照する。",
                "",
                "## 全体の流れ",
                "",
                "図の矢印は、読む順序を示す（実行時の呼び出しの順とは限らない。たとえば、問い合わせ側は投影を読むだけで、書き込みの後続ではない）。",
                "",
                "```plantuml",
            ) + diagram(ordered) + listOf("```", "") + stages(ordered, operations)
        ).joinToString("\n")
    }

    /** 段階（コマンド側など）を枠にして、ステップを順につなぐ図。矢印の端は、宣言した ASCII の別名だけで書く。 */
    private fun diagram(ordered: List<TourStep>): List<String> {
        val alias = ordered.withIndex().associate { (index, step) -> step to "S${index + 1}" }
        val frames =
            ordered.groupBy { it.stage }.flatMap { (stage, group) ->
                listOf("package \"$stage\" {") +
                    group.map { "  rectangle \"${it.rank}. ${it.element}\" as ${alias.getValue(it)}" } +
                    listOf("}")
            }
        val arrows = ordered.zipWithNext { a, b -> "${alias.getValue(a)} --> ${alias.getValue(b)}" }
        return listOf("@startuml", "left to right direction") + frames + arrows + listOf("@enduml")
    }

    private fun stages(
        ordered: List<TourStep>,
        operations: TourOperations?,
    ): List<String> =
        ordered.groupBy { it.stage }.flatMap { (stage, group) ->
            listOf("### $stage", "") + group.map { stepLines(it, operations) }.flatten()
        }

    /** 1 ステップの本文。見出し・説明・（操作を持つツアーは）API とイベント・ソースの場所。 */
    private fun stepLines(
        step: TourStep,
        operations: TourOperations?,
    ): List<String> =
        listOf(
            "#### ${step.rank}. `${step.element}`（${step.kind}）",
            "",
            LivingDocumentation.cell(step.description),
            "",
        ) + operations?.lines(step).orEmpty() + listOf("場所: `${step.file}`", "")
}
