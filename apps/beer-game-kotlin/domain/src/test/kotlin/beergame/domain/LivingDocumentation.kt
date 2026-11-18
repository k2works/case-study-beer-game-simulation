package beergame.domain

import java.io.File
import java.lang.reflect.Modifier
import java.nio.file.Files
import java.nio.file.Path

/*
 * Living Documentation の生成（B5 Step 8.4）。型の注釈（[Term]・[EventSpec]）とソースから、用語集とイベント一覧を作る。
 * 追加の依存は無い（標準のリフレクションと、ソースの走査だけ。開発戦略の「追加の依存関係が最小の方式」）。
 *
 * - イベントの一覧: `GameEvent`・`SessionEvent` の部分型（sealed）を全件。ストリーム・ペイロードの項目は型から、
 *   購読する投影は `Projection.kt` の走査から、発生する条件は [EventSpec] から。注釈の無いイベントは失敗にする。
 * - 用語集: [Term] を付けた型。
 * - 設計書の表（ドメインモデルの EV-G*・EV-S*）との突き合わせは、試験が行う。
 */

internal data class EventRow(
    val id: String,
    val name: String,
    val stream: StreamType,
    val trigger: String,
    val fields: List<String>,
    val projections: List<String>,
)

internal data class TermRow(
    val name: String,
    val code: String,
    val definition: String,
    val source: String,
)

internal object LivingDocumentation {
    const val GENERATED_NOTE =
        "この文書は、コードの注釈とソースから生成した。手で編集しない（試験 `LivingDocumentationSpec` が、コードとの不一致で失敗する）。" +
            "再生成: `./gradlew :domain:generateLivingDocs`。"

    private const val DESIGN_DIR = "docs/design/beer-game-kotlin"
    private const val PROJECTION_SOURCE = "apps/beer-game-kotlin/domain/src/main/kotlin/beergame/domain/Projection.kt"

    val updateMode: Boolean = System.getProperty("beergame.docs.update") == "true"

    /** リポジトリのルート（`docs/design/beer-game-kotlin/domain-model.md` がある、最も近い上位のディレクトリ）。 */
    fun repoRoot(): Path =
        generateSequence(Path.of("").toAbsolutePath()) { it.parent }
            .firstOrNull { Files.exists(it.resolve("$DESIGN_DIR/domain-model.md")) }
            ?: error("リポジトリのルートが見つからない（docs/design/beer-game-kotlin/domain-model.md がある上位のディレクトリ）")

    fun designFile(name: String): Path = repoRoot().resolve("$DESIGN_DIR/$name")

    fun events(): List<EventRow> {
        val subscriptions = projectionSubscriptions(Files.readString(repoRoot().resolve(PROJECTION_SOURCE)))
        val roots = listOf(StreamType.GAME to GameEvent::class.java, StreamType.SESSION to SessionEvent::class.java)
        return roots
            .flatMap { (stream, root) -> root.permittedSubclasses.map { stream to it } }
            .map { (stream, type) ->
                val spec = type.getAnnotation(EventSpec::class.java) ?: error("${type.simpleName} に @EventSpec が無い")
                EventRow(
                    id = spec.id,
                    name = type.simpleName,
                    stream = stream,
                    trigger = spec.trigger,
                    fields = type.declaredFields.filterNot { Modifier.isStatic(it.modifiers) }.map { it.name },
                    projections = subscriptions[type.simpleName].orEmpty(),
                )
            }.sortedBy { it.id }
    }

    /** `Projection.kt` の `val <名前> = Projection { ... is XxxEvent.<イベント名> -> ... }` から、イベントごとの購読する投影を作る。 */
    fun projectionSubscriptions(source: String): Map<String, List<String>> {
        val declaration = Regex("""^ {4}val (\w+) =\s*$""")
        val handled = Regex("""\bis (?:GameEvent|SessionEvent)\.(\w+)""")
        val pairs = mutableListOf<Pair<String, String>>()
        var pending: String? = null
        var current: String? = null
        source.lines().forEach { line ->
            declaration.find(line)?.let { pending = it.groupValues[1] }
            if (line.trim().startsWith("Projection {")) current = pending
            current?.let { name -> handled.findAll(line).forEach { pairs += it.groupValues[1] to name } }
        }
        return pairs.distinct().groupBy({ it.first }, { it.second })
    }

    fun terms(): List<TermRow> =
        domainClasses()
            .mapNotNull { type -> type.getAnnotation(Term::class.java)?.let { it to type } }
            .map { (term, type) ->
                TermRow(
                    term.name,
                    type.name.removePrefix("$DOMAIN_PACKAGE.").replace('$', '.'),
                    term.definition,
                    term.source,
                )
            }.sortedBy { it.name }

    private const val DOMAIN_PACKAGE = "beergame.domain"

    /** domain のクラス（クラスパスのディレクトリ、または jar）を走査して、注釈を探す対象にする。 */
    internal fun domainClasses(): List<Class<*>> {
        val location =
            File(
                Term::class.java.protectionDomain.codeSource.location
                    .toURI(),
            )
        val names =
            if (location.isDirectory) {
                location
                    .walkTopDown()
                    .filter { it.isFile && it.extension == "class" }
                    .map {
                        it
                            .relativeTo(location)
                            .path
                            .removeSuffix(".class")
                            .replace(File.separatorChar, '.')
                    }.toList()
            } else {
                java.util.jar
                    .JarFile(location)
                    .use { jar ->
                        jar
                            .entries()
                            .asSequence()
                            .map { it.name }
                            .filter { it.endsWith(".class") }
                            .toList()
                    }.map { it.removeSuffix(".class").replace('/', '.') }
            }
        return names
            .filter { it.startsWith("$DOMAIN_PACKAGE.") && !it.endsWith("package-info") }
            .map { Class.forName(it, false, Term::class.java.classLoader) }
    }

    /** 設計書の表 `| EV-G08 | \`CredentialRevoked\` ...` から、ID → イベント名を読む。 */
    fun designEvents(designText: String): Map<String, String> {
        val row = Regex("""^\| (EV-[GS]\d+) \| `(\w+)`""")
        return designText.lines().mapNotNull { row.find(it)?.let { m -> m.groupValues[1] to m.groupValues[2] } }.toMap()
    }

    internal fun cell(text: String): String = text.replace("|", "\\|").replace("\n", " ")

    fun eventsMarkdown(
        events: List<EventRow>,
        designOnly: Map<String, String>,
    ): String {
        val rows =
            events.joinToString("\n") { e ->
                val stream = e.stream.name.lowercase()
                val fields = if (e.fields.isEmpty()) "なし" else e.fields.joinToString("、") { "`$it`" }
                val projections = if (e.projections.isEmpty()) "なし" else e.projections.joinToString("、") { "`$it`" }
                "| ${e.id} | `${e.name}` | $stream | ${cell(e.trigger)} | $fields | $projections |"
            }
        val notImplemented =
            designOnly.entries.joinToString("\n") { "- ${it.key} `${it.value}`" }.ifEmpty { "なし" }
        // 表の行は先頭が `|` なので、trimMargin は使わない（行頭の `|` を余白と誤認して削る）
        return listOf(
            "# イベント一覧（生成）",
            "",
            GENERATED_NOTE,
            "",
            "実装済みのドメインイベント ${events.size} 種類。ID は[ドメインモデル設計](../domain-model.md)の「ドメインイベント」の表と同じで、",
            "名前が違うとき、または実装にあって設計書の表に無いときは、試験が失敗する。",
            "ストリームとペイロードの項目は型から、購読する投影は `Projection.kt` の走査から、発生する条件は注釈 `@EventSpec` から作る。",
            "",
            "| ID | イベント | ストリーム | 発生する条件（コマンド） | ペイロードの項目 | 購読する投影（`Projections`） |",
            "| :--- | :--- | :--- | :--- | :--- | :--- |",
            rows,
            "",
            "## 設計書にあり、まだ実装が無いイベント",
            "",
            notImplemented,
            "",
        ).joinToString("\n")
    }

    fun glossaryMarkdown(terms: List<TermRow>): String {
        val rows =
            terms.joinToString("\n") {
                "| ${cell(it.name)} | `${cell(it.code)}` | ${cell(it.definition)} | ${cell(it.source)} |"
            }
        return listOf(
            "# 用語集（生成）",
            "",
            GENERATED_NOTE,
            "",
            "注釈 `@Term` を付けた型の ${terms.size} 項目。これから書くコードと、B5 で足した概念から付け始める（既存コードへの一括適用はしない）。",
            "全体のユビキタス言語は[ドメインモデル設計](../domain-model.md)の「ユビキタス言語」を参照する。",
            "",
            "| 用語 | コード上の名称 | 定義 | 出典 |",
            "| :--- | :--- | :--- | :--- |",
            rows,
            "",
        ).joinToString("\n")
    }

    /** フロントマター（`---` で囲んだ先頭の部分）を除いた本文。 */
    fun body(text: String): String {
        val lines = text.lines()
        if (lines.firstOrNull() != "---") return text
        val end = lines.drop(1).indexOf("---")
        return if (end < 0) text else lines.drop(end + 2).joinToString("\n").trimStart('\n')
    }

    /** 生成物を、更新モードでは書き（既存のフロントマターは保つ）、検査モードでは、コミット済みの本文と比べるための本文を返す。 */
    fun committedBody(
        file: Path,
        generated: String,
        frontMatter: String,
    ): String {
        if (updateMode) {
            val existing = if (Files.exists(file)) Files.readString(file) else null
            val head =
                existing?.let { text -> text.substring(0, text.length - body(text).length) } ?: "$frontMatter\n\n"
            Files.createDirectories(file.parent)
            Files.writeString(file, head + generated)
        }
        return body(Files.readString(file))
    }
}
