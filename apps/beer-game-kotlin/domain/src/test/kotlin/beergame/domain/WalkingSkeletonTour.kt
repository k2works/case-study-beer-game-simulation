package beergame.domain

import java.nio.file.Files
import java.nio.file.Path

/*
 * ウォーキングスケルトンのガイドツアー（Living Documentation）。「1 ゲーム・4 役割・1 週」の最小の縦の切片を、
 * 操作の順に、画面 → API → アプリケーション → ドメイン → イベント → 投影 → 受入の層をたどって案内する。
 * 各層の場所は、コードの走査から導く（手で書かない）。見つからなければ、ツアーが古い（コードが変わった）ので、試験が失敗する。
 * 追加の依存は無い（ソースの走査だけ。[LivingDocumentation] と同じ方式）。
 */

/** ツアーの 1 つの停留所の定義。バックエンドと画面の「探す手がかり」だけを持ち、場所は走査で導く。 */
internal data class TourStop(
    val title: String,
    val actor: String,
    val operationId: String,
    val backend: BackendClues,
    val screen: ScreenClues,
    val acceptanceTags: List<String>,
)

/** アプリケーションの関数名、ドメインのコマンドの宣言、イベントの発生条件の先頭（`@EventSpec` の trigger）。 */
internal data class BackendClues(
    val applicationFunction: String,
    val commandDeclaration: String?,
    val eventTriggerPrefix: String?,
)

/** 画面のファイル名と、その画面が呼ぶ API クライアントの呼び出し。 */
internal data class ScreenClues(
    val file: String,
    val clientCall: String,
)

/** 走査で場所を導いた停留所。 */
internal data class ResolvedStop(
    val stop: TourStop,
    val http: String,
    val routeFile: String,
    val applicationFile: String,
    val commandFile: String?,
    val events: List<EventRow>,
    val screenFile: String,
    val acceptanceFiles: List<String>,
)

internal object WalkingSkeletonTour {
    private const val APP = "apps/beer-game-kotlin"

    val stops: List<TourStop> =
        listOf(
            TourStop(
                "ゲームを作成する",
                "進行役",
                "createGame",
                BackendClues("createGame", "data class CreateGame(", "CreateGame"),
                ScreenClues("CreateGamePage.tsx", "api.createGame("),
                listOf("@AC1.1.1"),
            ),
            TourStop(
                "参加する",
                "参加者",
                "joinGame",
                BackendClues("joinGame", "data class JoinGame(", "JoinGame"),
                ScreenClues("JoinPage.tsx", "api.joinGame("),
                listOf("@AC1.2.1"),
            ),
            TourStop(
                "役割を割り当てる",
                "進行役",
                "assignRole",
                BackendClues("assignRole", "data class AssignRole(", "AssignRole"),
                ScreenClues("LobbyPage.tsx", "api.assignRole("),
                listOf("@AC1.2.5"),
            ),
            TourStop(
                "ゲームを開始する",
                "進行役",
                "startGame",
                BackendClues("startGame", "data class StartGame(", "StartGame"),
                ScreenClues("LobbyPage.tsx", "api.startGame("),
                listOf("@AC1.2.3"),
            ),
            TourStop(
                "発注（入力）を保存する",
                "参加者",
                "saveDecision",
                BackendClues("saveDecision", "data class SaveDecision(", "SaveDecision"),
                ScreenClues("PlayPage.tsx", "api.saveDecision("),
                listOf("@AC2.2.1"),
            ),
            TourStop(
                "週を確定する",
                "進行役",
                "commitWeek",
                BackendClues("commitWeek", "data class CommitWeek(", "CommitWeek"),
                ScreenClues("ConsolePage.tsx", "api.commitWeek("),
                listOf("@AC2.3.1"),
            ),
            TourStop(
                "状態を表示する",
                "進行役・参加者",
                "getSessionState",
                BackendClues("snapshot", null, null),
                ScreenClues("PlayPage.tsx", "api.getSessionState("),
                listOf("@AC2.1.1"),
            ),
        )

    /** ソースの全体（相対パス → 本文）。ツアーが見る範囲（バックエンド・画面・受入）だけを読む。 */
    private fun sources(root: Path): Map<String, String> {
        val dirs =
            listOf(
                "$APP/adapter-http/src/main",
                "$APP/application/src/main",
                "$APP/domain/src/main",
                "$APP/web/src",
                "$APP/features",
            )
        return dirs
            .map { root.resolve(it) }
            .filter { Files.exists(it) }
            .flatMap { dir -> Files.walk(dir).use { stream -> stream.filter { Files.isRegularFile(it) }.toList() } }
            .filter {
                it.fileName.toString().let { name ->
                    name.endsWith(".kt") || name.endsWith(".tsx") ||
                        name.endsWith(".feature")
                }
            }.associate { root.relativize(it).toString().replace('\\', '/') to Files.readString(it) }
    }

    /** `openapi.yaml` から、操作の ID に対する「メソッド パス」を読む。 */
    fun httpOf(
        openApi: String,
        operationId: String,
    ): String {
        val path = Regex("""^ {2}(/\S*):$""")
        val method = Regex("""^ {4}(get|post|put|delete|patch):$""")
        val operation = Regex("""^ {6}operationId: (\w+)""")
        var currentPath: String? = null
        var currentMethod: String? = null
        openApi.lines().forEach { line ->
            path.find(line)?.let { currentPath = it.groupValues[1] }
            method.find(line)?.let { currentMethod = it.groupValues[1] }
            if (operation.find(line)?.groupValues?.get(1) == operationId) {
                return "${currentMethod?.uppercase()} $currentPath"
            }
        }
        error("openapi.yaml に操作 $operationId が無い")
    }

    private fun fileWith(
        sources: Map<String, String>,
        stop: String,
        layer: String,
        needle: String,
        under: String? = null,
    ): String =
        sources.entries
            .filter { under == null || it.key.contains(under) }
            .firstOrNull { it.value.contains(needle) }
            ?.key
            ?: error("停留所「$stop」の$layer が見つからない（探した文字列: $needle）。ツアーを見直す")

    fun resolve(
        root: Path,
        events: List<EventRow>,
    ): List<ResolvedStop> {
        val sources = sources(root)
        val openApi = Files.readString(root.resolve("$APP/contracts/openapi.yaml"))
        return stops.map { stop ->
            val title = stop.title
            val clues = stop.backend
            ResolvedStop(
                stop = stop,
                http = httpOf(openApi, stop.operationId),
                routeFile = fileWith(sources, title, "ルート", "operation(\"${stop.operationId}\")", "adapter-http"),
                applicationFile =
                    fileWith(
                        sources,
                        title,
                        "アプリケーションの関数",
                        "fun Ports.${clues.applicationFunction}(",
                        "application",
                    ),
                commandFile = clues.commandDeclaration?.let { fileWith(sources, title, "コマンド", it, "domain") },
                events =
                    clues.eventTriggerPrefix
                        ?.let { prefix ->
                            // 開始後の入れ替え（「AssignRole（開始後の入れ替え）」）は、最初の縦の切片の外
                            events.filter { it.trigger.startsWith(prefix) && !it.trigger.contains("（開始後の入れ替え）") }
                        }.orEmpty(),
                screenFile = fileWith(sources, title, "画面", stop.screen.clientCall, "/${stop.screen.file}"),
                acceptanceFiles = acceptanceFiles(sources, stop),
            )
        }
    }

    /** ツアーの Markdown。層ごとの場所を表にし、操作の流れをシーケンス図にする。 */
    fun markdown(stops: List<ResolvedStop>): String {
        val sequence =
            stops.mapIndexed { index, resolved ->
                val lines =
                    listOf(
                        "${resolved.stop.actor} -> 画面 : ${index + 1}. ${resolved.stop.title}",
                        "画面 -> API : ${resolved.http}",
                        "API -> アプリケーション : ${resolved.stop.backend.applicationFunction}",
                    ) + domainLines(resolved)
                lines.joinToString("\n")
            }
        val sections = stops.mapIndexed { index, resolved -> section(index + 1, resolved) }
        return (
            listOf(
                "# ウォーキングスケルトンのガイドツアー（生成）",
                "",
                LivingDocumentation.GENERATED_NOTE,
                "",
                "最初の縦の切片（1 ゲーム・4 役割・1 週）を、操作の順に、画面からイベントと投影までたどる。",
                "各層の場所は、コードの走査から導く。見つからなければ、ツアーが古いので、試験が失敗する。",
                "API の経路は、仕様（`contracts/openapi.yaml`。基準の URL は `/api/v1`）の操作から読む。",
                "",
                "## 全体の流れ",
                "",
                "```plantuml",
                "@startuml",
                "autonumber",
            ) + sequence + listOf("@enduml", "```", "") + sections
        ).joinToString("\n")
    }

    private fun domainLines(resolved: ResolvedStop): List<String> {
        val events = resolved.events.map { it.name }
        return if (events.isEmpty()) {
            listOf("アプリケーション -> ドメイン : 投影を読む（開示の規則を掛ける）")
        } else {
            listOf(
                "アプリケーション -> ドメイン : decide",
                "ドメイン --> アプリケーション : ${events.joinToString("、")}",
            )
        }
    }

    private fun section(
        number: Int,
        resolved: ResolvedStop,
    ): String {
        val stop = resolved.stop
        val events =
            resolved.events
                .joinToString("<br>") { "${it.id} `${it.name}`（${it.stream.name.lowercase()}）" }
                .ifEmpty { "なし（問い合わせ）" }
        val projections =
            resolved.events
                .flatMap { it.projections }
                .distinct()
                .joinToString("、") { "`$it`" }
                .ifEmpty { "なし" }
        val rows =
            listOf(
                "画面" to "`${resolved.screenFile}`（`${stop.screen.clientCall}…`を呼ぶ）",
                "API" to "`${resolved.http}`（操作 `${stop.operationId}`）",
                "ルート" to "`${resolved.routeFile}`",
                "アプリケーション" to "`${resolved.applicationFile}` の `Ports.${stop.backend.applicationFunction}`",
                "コマンド" to (resolved.commandFile?.let { "`$it`（`${stop.backend.commandDeclaration}…`）" } ?: "なし（問い合わせ）"),
                "イベント" to events,
                "購読する投影" to projections,
                "受入" to
                    resolved.acceptanceFiles.joinToString("<br>") { "`$it`（${stop.acceptanceTags.joinToString("、")}）" },
            )
        return (
            listOf(
                "## $number. ${stop.title}（${stop.actor}）",
                "",
                "| 層 | 場所 |",
                "| :--- | :--- |",
            ) + rows.map { (layer, place) -> "| $layer | $place |" } + listOf("")
        ).joinToString("\n")
    }

    /** 受入条件のタグ（`@AC1.1.1` など）を持つ feature ファイル。1 つも無ければ、ツアーが古い。 */
    private fun acceptanceFiles(
        sources: Map<String, String>,
        stop: TourStop,
    ): List<String> {
        val files =
            stop.acceptanceTags
                .flatMap { tag -> sources.filter { it.key.endsWith(".feature") && it.value.contains(tag) }.keys }
                .distinct()
                .sorted()
        check(files.isNotEmpty()) { "停留所「${stop.title}」の受入（${stop.acceptanceTags}）が見つからない" }
        return files
    }
}
