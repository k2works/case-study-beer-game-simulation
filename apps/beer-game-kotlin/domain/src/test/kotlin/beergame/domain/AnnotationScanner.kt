package beergame.domain

import java.nio.file.Files
import java.nio.file.Path

/*
 * ダイナミックキュレーションの注釈（[GuidedTour]・[KeyLandmark]）を、ソースの文字列から読む共通の部品。
 * 注釈は domain・application・adapter にまたがるので、リフレクションではなく、各モジュールの `src/main` を走査する
 * （追加の依存は無い。[LivingDocumentation] と同じ方式）。
 */

/** 走査で見つけた注釈 1 つ。[args] は注釈の引数の本文、[kind] は「関数」か「型」、[element] は直後の宣言の名前、[file] は相対パス。 */
internal data class FoundAnnotation(
    val args: String,
    val kind: String,
    val element: String,
    val file: String,
)

internal object AnnotationScanner {
    private const val APP = "apps/beer-game-kotlin"
    private val MODULES = listOf("domain", "application", "adapter-persistence", "adapter-http", "app")

    private const val MODIFIERS = "internal|private|public|suspend|inline|data|sealed|value|enum|open|abstract"
    private val DECLARATION =
        Regex("""^\s*(?:(?:$MODIFIERS)\s+)*(fun|class|interface|object)\s+(?:<[^>]*>\s*)?([\w.]+)""")

    /** すべてのモジュールの `src/main` の `.kt` を、順に読んで、[annotation] の注釈を集める。 */
    fun scan(
        root: Path,
        annotation: String,
    ): List<FoundAnnotation> =
        MODULES
            .map { root.resolve("$APP/$it/src/main") }
            .filter { Files.exists(it) }
            .flatMap { dir ->
                Files.walk(dir).use { stream -> stream.filter { it.toString().endsWith(".kt") }.toList() }
            }.sorted()
            .flatMap { parse(Files.readString(it), root.relativize(it).toString().replace('\\', '/'), annotation) }

    /** 1 つのソースから、[annotation] の注釈をすべて読む。注釈の直後の宣言（他の注釈を挟んでもよい）が、その要素。 */
    fun parse(
        source: String,
        file: String,
        annotation: String,
    ): List<FoundAnnotation> {
        val marker = "@$annotation("
        val found = mutableListOf<FoundAnnotation>()
        var from = source.indexOf(marker)
        while (from >= 0) {
            val argsStart = from + marker.length
            val argsEnd = closingParenthesis(source, argsStart, annotation)
            val (kind, element) = nextDeclaration(source.substring(argsEnd + 1), annotation)
            found += FoundAnnotation(source.substring(argsStart, argsEnd), kind, element, file)
            from = source.indexOf(marker, argsEnd)
        }
        return found
    }

    /** 引数の、文字列リテラル（`"…"`。`+` で連結してもよい）の値。無ければ、注釈の定義と使い方がずれているので失敗にする。 */
    fun text(
        found: FoundAnnotation,
        name: String,
    ): String =
        Regex("""\b$name\s*=\s*((?:"(?:[^"\\]|\\.)*"\s*\+?\s*)+)""")
            .find(found.args)
            ?.groupValues
            ?.get(1)
            ?.let { literal ->
                Regex(""""((?:[^"\\]|\\.)*)"""").findAll(literal).joinToString("") { it.groupValues[1] }
            }
            ?: error("注釈に $name が無い（${found.file}）")

    /** 引数の、整数リテラルの値。 */
    fun number(
        found: FoundAnnotation,
        name: String,
    ): Int =
        Regex("""\b$name\s*=\s*(\d+)""")
            .find(found.args)
            ?.groupValues
            ?.get(1)
            ?.toInt()
            ?: error("注釈に $name が無い（${found.file}）")

    /** [start] から始まる引数の、対応する閉じ括弧の位置。文字列リテラルの中の括弧と、エスケープした引用符は、数えない。 */
    private fun closingParenthesis(
        source: String,
        start: Int,
        annotation: String,
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
        error("@$annotation の閉じ括弧が見つからない")
    }

    /** 注釈の後ろから、最初の宣言（fun・class・interface・object）を探す。注釈の行と KDoc の行は、読み飛ばす。 */
    private fun nextDeclaration(
        after: String,
        annotation: String,
    ): Pair<String, String> {
        val line =
            after.lines().drop(1).firstOrNull { DECLARATION.containsMatchIn(it) }
                ?: error("@$annotation の直後に宣言が見つからない")
        val match = DECLARATION.find(line) ?: error("宣言を読めない: $line")
        val kind = if (match.groupValues[1] == "fun") "関数" else "型"
        return kind to match.groupValues[2]
    }
}
