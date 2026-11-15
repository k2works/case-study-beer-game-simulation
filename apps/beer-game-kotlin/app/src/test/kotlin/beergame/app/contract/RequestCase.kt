package beergame.app.contract

import beergame.app.World
import beergame.http.beerGameModule
import io.ktor.http.HttpMethod
import io.ktor.server.application.Application
import io.ktor.server.application.pluginOrNull
import io.ktor.server.routing.HttpMethodRouteSelector
import io.ktor.server.routing.RoutingNode
import io.ktor.server.routing.RoutingRoot
import io.ktor.server.testing.testApplication
import java.util.concurrent.atomic.AtomicReference

/*
 * リクエストの適合の検査の事例。仕様の要求スキーマの判定と、実装の受理・拒否を、事例ごとに [Expectation] で明示する。
 * 実装が拒否するときの code は、すべて `validation.invalid_input`（400・422）でなければならない。
 */

/**
 * - [VALID]: 仕様に適合し、実装も受理する。
 * - [INVALID]: 仕様に適合せず、実装も拒否する。
 * - [SPEC_VALID_BUT_REJECTED]: 仕様のスキーマには適合するが、実装は拒否する。項目をまたぐ条件など、スキーマでは表せないものだけ。
 */
internal enum class Expectation(
    val specValid: Boolean,
    val accepted: Boolean,
) {
    VALID(true, true),
    INVALID(false, false),
    SPEC_VALID_BUT_REJECTED(true, false),
}

internal class RequestCase(
    val label: String,
    val operationId: String,
    val target: OperationRequest,
    val expectation: Expectation,
)

private fun expectationOf(valid: Boolean): Expectation = if (valid) Expectation.VALID else Expectation.INVALID

/** 事例の組み立て。[operationId] の操作を、[method]・[path]・[cookie] で呼ぶ。 */
private class CaseBuilder(
    private val prefix: String,
    private val operationId: String,
    private val method: HttpMethod,
    private val path: String,
    private val cookie: String?,
) {
    fun case(
        label: String,
        body: String,
        valid: Boolean,
    ): RequestCase =
        RequestCase(
            "$prefix: $label",
            operationId,
            OperationRequest(operationId, method, path, body, cookie),
            expectationOf(valid),
        )
}

private fun basisOf(version: Int): String = ROLES.joinToString(",") { "\"$it\":$version" }

private val POST = HttpMethod.Post
private val PUT = HttpMethod.Put

private fun createCases(): List<RequestCase> {
    val b = CaseBuilder("作成", "createGame", POST, "/games", null)

    fun game(
        fields: String,
        valid: Boolean,
        label: String,
    ) = b.case(label, "{$fields}", valid)
    return listOf(
        game("\"kind\":\"KIT\",\"finalWeek\":3", false, "需要系列が欠けている"),
        game("\"kind\":\"CUSTOM\",\"finalWeek\":3,\"demand\":[4,4,8]", false, "kind が KIT でない"),
        game("\"kind\":\"KIT\",\"finalWeek\":\"3\",\"demand\":[4,4,8]", false, "最終週が文字列"),
        game("\"kind\":\"KIT\",\"finalWeek\":3,\"demand\":[4,\"x\",8]", false, "需要に文字列が混じる"),
        game("\"kind\":\"KIT\",\"finalWeek\":0,\"demand\":[4,4,8]", false, "最終週が 0（下限 1 の外）"),
        game("\"kind\":\"KIT\",\"finalWeek\":51,\"demand\":[4,4,8]", false, "最終週が 51（上限 50 の外）"),
        game("\"kind\":\"KIT\",\"finalWeek\":3,\"demand\":[4,1001,8]", false, "需要が 1001（上限 1000 の外）"),
        game("\"kind\":\"KIT\",\"finalWeek\":3,\"demand\":[4,-1,8]", false, "需要が -1（下限 0 の外）"),
        game("\"kind\":\"KIT\",\"finalWeek\":3,\"demand\":[4,4,8],\"retentionDays\":3651", false, "保持日数が 3651（上限の外）"),
        game("\"kind\":\"KIT\",\"finalWeek\":3,\"demand\":[4,4,8],\"retentionDays\":0", false, "保持日数が 0（下限の外）"),
        b.case("正しい要求", KIT_GAME, true),
        game("\"kind\":\"KIT\",\"finalWeek\":3,\"demand\":[4,4,8],\"retentionDays\":90", true, "保持日数つきの正しい要求"),
        game("\"kind\":\"KIT\",\"finalWeek\":3,\"demand\":[4,4,8],\"extra\":1", true, "仕様に無い項目（仕様は許す）"),
    )
}

private fun joinCases(prepared: PlayedGame): List<RequestCase> {
    val b = CaseBuilder("参加", "joinGame", POST, "/participations/join", null)
    val code = prepared.joinCode
    return listOf(
        b.case("表示名が欠けている", """{"joinCode":"$code"}""", false),
        b.case("参加コードが数値", """{"joinCode":123,"displayName":"山田"}""", false),
        b.case("表示名が空（1 文字以上）", """{"joinCode":"$code","displayName":""}""", false),
        b.case("表示名が 81 文字（80 文字以下）", """{"joinCode":"$code","displayName":"${"あ".repeat(81)}"}""", false),
        b.case("正しい要求", """{"joinCode":"$code","displayName":"山田"}""", true),
    )
}

private fun assignCases(prepared: PlayedGame): List<RequestCase> {
    val path = "/games/${prepared.id}/participants/${prepared.players.getValue("FACTORY").participantId}/role"
    val b = CaseBuilder("割り当て", "assignRole", PUT, path, prepared.facilitator)
    return listOf(
        b.case("役割が仕様の 4 値でない", """{"role":"MANAGER"}""", false),
        b.case("役割が小文字", """{"role":"factory"}""", false),
        b.case("役割が null", """{"role":null}""", false),
        b.case("役割が欠けている", "{}", false),
        b.case("正しい要求", """{"role":"FACTORY"}""", true),
    )
}

private fun saveCases(started: PlayedGame): List<RequestCase> {
    val b = CaseBuilder("入力", "saveDecision", PUT, "/sessions/${started.id}/decisions", started.cookieOf("FACTORY"))
    return listOf(
        b.case("数量が 1001", """{"week":1,"quantity":1001}""", false),
        b.case("数量が -1", """{"week":1,"quantity":-1}""", false),
        b.case("数量が文字列", """{"week":1,"quantity":"4"}""", false),
        b.case("数量が小数", """{"week":1,"quantity":4.5}""", false),
        b.case("数量が欠けている", """{"week":1}""", false),
        b.case("週が 0", """{"week":0,"quantity":4}""", false),
        b.case("週が欠けている", """{"quantity":4}""", false),
        b.case("正しい要求", """{"week":1,"quantity":4}""", true),
    )
}

private fun commitCases(started: PlayedGame): List<RequestCase> {
    val path = "/sessions/${started.id}/weeks/1/commit"
    val b = CaseBuilder("確定", "commitWeek", POST, path, started.facilitator)
    val crossField =
        RequestCase(
            "確定: 経路の週（1）と requestedWeek（2）が違う（項目をまたぐ条件。スキーマでは表せない）",
            "commitWeek",
            OperationRequest(
                "commitWeek",
                POST,
                path,
                """{"requestedWeek":2,"basis":{${basisOf(1)}}}""",
                started.facilitator,
            ),
            Expectation.SPEC_VALID_BUT_REJECTED,
        )
    return listOf(
        b.case("requestedWeek が欠けている", """{"basis":{${basisOf(1)}}}""", false),
        b.case("basis が欠けている", """{"requestedWeek":1}""", false),
        b.case(
            "basis に RETAILER が無い",
            """{"requestedWeek":1,"basis":{"FACTORY":1,"DISTRIBUTOR":1,"WHOLESALER":1}}""",
            false,
        ),
        b.case("basis の版が -1", """{"requestedWeek":1,"basis":{${basisOf(-1)}}}""", false),
        b.case("requestedWeek が 0", """{"requestedWeek":0,"basis":{${basisOf(1)}}}""", false),
        b.case("requestedWeek が文字列", """{"requestedWeek":"1","basis":{${basisOf(1)}}}""", false),
        crossField,
        b.case("正しい要求", commitBody(1, 1), true),
    )
}

private fun proxyCases(started: PlayedGame): List<RequestCase> {
    val path = "/sessions/${started.id}/proxy-decisions/FACTORY"
    val b = CaseBuilder("代理入力", "submitProxyDecision", PUT, path, started.facilitator)
    return listOf(
        b.case("requestedWeek が欠けている", """{"quantity":4}""", false),
        b.case("requestedWeek が 0", """{"requestedWeek":0,"quantity":4}""", false),
        b.case("数量が欠けている", """{"requestedWeek":1}""", false),
        b.case("数量が 1001", """{"requestedWeek":1,"quantity":1001}""", false),
        b.case("数量が文字列", """{"requestedWeek":1,"quantity":"4"}""", false),
        // 確定の事例（先に実行される）で第 1 週が確定済みなので、現在の週は 2
        b.case("正しい要求", """{"requestedWeek":2,"quantity":4}""", true),
    )
}

/** 失効・再発行・復帰。受理される事例（失効 → 再発行）は、状態を変えるので、拒否される事例の後に、この順で置く。 */
private fun credentialCases(prepared: PlayedGame): List<RequestCase> {
    val retailer = prepared.players.getValue("RETAILER").participantId
    val revoke =
        CaseBuilder("失効", "revokeCredential", POST, "/games/${prepared.id}/credentials/revoke", prepared.facilitator)
    val reissue =
        CaseBuilder("再発行", "reissueCredential", POST, "/games/${prepared.id}/credentials/reissue", prepared.facilitator)
    val recover = CaseBuilder("復帰", "recoverParticipation", POST, "/participations/recover", null)
    val code = prepared.players.getValue("DISTRIBUTOR").recovery
    return listOf(
        revoke.case("subject が欠けている", "{}", false),
        revoke.case("subject.kind が進行役（参加者だけ）", """{"subject":{"kind":"FACILITATOR","id":"$retailer"}}""", false),
        revoke.case("subject.id が欠けている", """{"subject":{"kind":"PARTICIPANT"}}""", false),
        reissue.case("subject が欠けている", "{}", false),
        reissue.case("subject.kind が観察者（B9。参加者だけ）", """{"subject":{"kind":"OBSERVER","id":"$retailer"}}""", false),
        recover.case("gameId が欠けている", """{"recoveryCode":"$code"}""", false),
        recover.case("recoveryCode が数値", """{"gameId":"${prepared.id}","recoveryCode":5}""", false),
        revoke.case("正しい要求", subjectBody(retailer), true),
        reissue.case("正しい要求（失効した資格）", subjectBody(retailer), true),
        recover.case("正しい要求", """{"gameId":"${prepared.id}","recoveryCode":"$code"}""", true),
    )
}

/**
 * [prepared] は準備中（作成・参加・割り当て済みで未開始）、[started] は開始済みで、FACTORY 以外の 3 役割は入力済みのゲーム。
 * 状態を変える事例（受理される要求）は、各操作の拒否される事例の後に置く（拒否は状態を変えない）。
 */
internal fun requestCases(
    prepared: PlayedGame,
    started: PlayedGame,
): List<RequestCase> =
    createCases() + joinCases(prepared) + assignCases(prepared) + saveCases(started) + commitCases(started) +
        proxyCases(started) + credentialCases(prepared)

/** 実装のルート（`METHOD /api/v1/...`）。Ktor のルーティングの木から集める。 */
internal fun implementedRoutes(): Set<String> {
    val collected = AtomicReference<Set<String>>(emptySet())
    World().use { world ->
        testApplication {
            application {
                beerGameModule(world.deps())
                collected.set(routesOf(this))
            }
            startApplication()
        }
    }
    return collected.get()
}

private val ROUTE_PATTERN = Regex("""^(.+?)/?\(method:([A-Z]+)\)$""")

private fun routesOf(application: Application): Set<String> =
    application
        .pluginOrNull(RoutingRoot)
        ?.descendants()
        .orEmpty()
        .filter { it is RoutingNode && it.selector is HttpMethodRouteSelector }
        .mapNotNull { ROUTE_PATTERN.matchEntire(it.toString()) }
        .map { "${it.groupValues[2]} ${it.groupValues[1]}" }
        .toSet()
