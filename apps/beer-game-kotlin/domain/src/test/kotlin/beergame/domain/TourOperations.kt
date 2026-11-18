package beergame.domain

import java.nio.file.Files
import java.nio.file.Path

/*
 * ウォーキングスケルトンのツアーの、各ステップに添える情報。ステップの要素（アプリケーションの `Ports.<操作>`）から、
 * (1) API の経路を、仕様 `contracts/openapi.yaml` の操作から、(2) 発行するイベントを、注釈 `@EventSpec` の発生条件から導く。
 * 手で書かない。導けなければ（関数と操作が対応しなくなったら）、ツアーが古いので、失敗にする。
 */
internal class TourOperations private constructor(
    private val openApi: String,
    private val events: List<EventRow>,
) {
    /** ステップに添える行。要素が `Ports.<操作>` でなければ、何も添えない。 */
    fun lines(step: TourStep): List<String> {
        val function = step.element.removePrefix("Ports.")
        if (function == step.element) return emptyList()
        val operationId = OPERATION_ALIAS[function] ?: function
        val eventsOf = eventsOf(function)
        return listOf(
            "API: `${httpOf(operationId)}`（操作 `$operationId`）",
            "",
            "発行するイベント: " + eventsOf.joinToString("、") { "${it.id} `${it.name}`" }.ifEmpty { "なし（問い合わせ）" },
            "",
        )
    }

    /** 関数名の先頭を大文字にした名前（`createGame` → `CreateGame`）で始まる発生条件のイベント。開始後の入れ替えは、ツアーの外。 */
    private fun eventsOf(function: String): List<EventRow> {
        val command = function.replaceFirstChar { it.uppercase() }
        return events.filter { it.trigger.startsWith(command) && !it.trigger.contains("（開始後の入れ替え）") }
    }

    /** `openapi.yaml` から、操作の ID に対する「メソッド パス」を読む。 */
    private fun httpOf(operationId: String): String {
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
        error("openapi.yaml に操作 $operationId が無い（ツアーのステップと、仕様の操作が対応しない）")
    }

    companion object {
        private const val APP = "apps/beer-game-kotlin"

        /** アプリケーションの関数名と、仕様の操作の ID が違うもの（問い合わせの入口 `snapshot` は、状態の取得の操作）。 */
        private val OPERATION_ALIAS = mapOf("snapshot" to "getSessionState")

        fun load(root: Path): TourOperations =
            TourOperations(
                Files.readString(root.resolve("$APP/contracts/openapi.yaml")),
                LivingDocumentation.events(),
            )
    }
}
