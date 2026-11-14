package beergame.acceptance

import io.cucumber.java.en.Given
import io.cucumber.java.en.Then
import io.cucumber.java.en.When
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

private const val HTTP_OK = 200
private const val HTTP_FORBIDDEN = 403
private const val HTTP_CONFLICT = 409
private const val HTTP_UNPROCESSABLE = 422
private const val OTHER_INPUT = 4

/** 値の葉（数値・文字列）をすべて集める。将来の需要が、応答のどこにも出ていないことの確認に使う。 */
private fun JsonElement.leaves(): List<String> =
    when (this) {
        is JsonObject -> values.flatMap { it.leaves() }
        is JsonArray -> flatMap { it.leaves() }
        is JsonPrimitive -> listOf(content)
    }

/** 1 週の入力・確定・役割別の状況のステップ定義（US2.1〜US2.3）。薄く保ち、HTTP を呼んで、期待値を確かめるだけ。 */
class WeeklyPlaySteps {
    private val ctx get() = Scenario.current

    private var lastActor: Participant? = null
    private var savedQuantity: Int? = null

    // ---- 入力（Given） ----

    private fun saveAll(
        game: GameContext,
        week: Int,
        quantities: Map<Role, Int>,
    ) = quantities.forEach { (role, quantity) ->
        val response = ctx.api.saveDecision(game.id, week, quantity.toString(), game.playerOf(role).cookie)
        expect(response.status == HTTP_OK) { "${role.label}の入力を保存できない: ${response.status} ${response.text}" }
    }

    @Given("第 {int} 週の入力が、小売店 {int}、二次卸 {int}、一次卸 {int}、工場 {int} でそろっている")
    fun decisionsAreComplete(
        week: Int,
        retailer: Int,
        wholesaler: Int,
        distributor: Int,
        factory: Int,
    ) = saveAll(
        ctx.game,
        week,
        mapOf(
            Role.RETAILER to retailer,
            Role.WHOLESALER to wholesaler,
            Role.DISTRIBUTOR to distributor,
            Role.FACTORY to factory,
        ),
    )

    @Given("第 {int} 週の入力が、小売店 {int}、二次卸 {int}、一次卸 {int} であり、工場は未入力である")
    fun factoryHasNoDecision(
        week: Int,
        retailer: Int,
        wholesaler: Int,
        distributor: Int,
    ) = saveAll(
        ctx.game,
        week,
        mapOf(
            Role.RETAILER to retailer,
            Role.WHOLESALER to wholesaler,
            Role.DISTRIBUTOR to distributor,
        ),
    )

    @Given("どちらのゲームも、第 {int} 週の入力が、小売店 {int}、二次卸 {int}、一次卸 {int}、工場 {int} でそろっている")
    fun bothGamesHaveCompleteDecisions(
        week: Int,
        retailer: Int,
        wholesaler: Int,
        distributor: Int,
        factory: Int,
    ) = ctx.games.forEach {
        saveAll(
            it,
            week,
            mapOf(
                Role.RETAILER to retailer,
                Role.WHOLESALER to wholesaler,
                Role.DISTRIBUTOR to distributor,
                Role.FACTORY to factory,
            ),
        )
    }

    @Given("同じ設定の 2 つのゲームが、どちらも開始されている")
    fun twoStartedGamesWithSameSettings() {
        expect(ctx.games.size == 1) { "背景のゲームが 1 つだけのはず: ${ctx.games.size}" }
        ctx.createStartedGame()
    }

    // ---- 確定 ----

    private fun commit(
        game: GameContext,
        week: Int,
        key: String = ctx.api.newKey(),
    ): ApiResponse {
        val body = ctx.api.commitBody(week, ctx.basisOf(game))
        ctx.lastCommit = CommitRequest(game, week, body, key)
        return ctx.api.commitWeek(game.id, week, body, game.facilitator, key)
    }

    @Given("進行役が第 {int} 週を確定している")
    fun facilitatorCommittedWeek(week: Int) {
        val response = commit(ctx.game, week)
        expect(response.status == HTTP_OK) { "確定できない: ${response.status} ${response.text}" }
    }

    @When("進行役が第 {int} 週を確定する")
    fun facilitatorCommitsWeek(week: Int) {
        ctx.last = commit(ctx.game, week)
        expect(ctx.response().status == HTTP_OK) { "確定できない: ${ctx.response().status} ${ctx.response().text}" }
    }

    @When("進行役が第 {int} 週を確定しようとする")
    fun facilitatorTriesToCommitWeek(week: Int) {
        ctx.last = commit(ctx.game, week)
    }

    @When("どちらのゲームも第 {int} 週を確定する")
    fun bothGamesCommitWeek(week: Int) {
        ctx.games.forEach {
            val response = commit(it, week)
            expect(response.status == HTTP_OK) { "確定できない: ${response.status} ${response.text}" }
        }
    }

    @When("進行役が、同じ確定の要求をもう一度送る")
    fun facilitatorResendsSameCommit() {
        val request = checkNotNull(ctx.lastCommit) { "確定の要求がない" }
        ctx.last =
            ctx.api.commitWeek(request.game.id, request.week, request.body, request.game.facilitator, request.key)
    }

    @When("進行役が、新しい要求で第 {int} 週をもう一度確定しようとする")
    fun facilitatorCommitsAgainWithNewRequest(week: Int) {
        ctx.last = commit(ctx.game, week)
    }

    @When("進行役が第 {int} 週の結果を取得する")
    fun facilitatorFetchesWeekResults(
        @Suppress("UNUSED_PARAMETER") week: Int,
    ) {
        ctx.last = ctx.sessionState(ctx.game)
    }

    // ---- 確定の結果（Then） ----

    private fun facilitatorState(game: GameContext = ctx.game): JsonObject = ctx.sessionState(game).json

    @Then("現在の週は第 {int} 週になる")
    fun currentWeekIs(week: Int) = currentWeekShouldBe(week)

    @Then("現在の週は第 {int} 週のままである")
    fun currentWeekStays(week: Int) = currentWeekShouldBe(week)

    private fun currentWeekShouldBe(week: Int) {
        val actual = facilitatorState().number("week")
        expect(actual == week) { "現在の週は第 $week 週のはずが、第 $actual 週" }
    }

    private fun resultsOf(
        state: JsonObject,
        week: Int,
    ): List<JsonObject> = state.array("results").map { it.jsonObject }.filter { it.number("week") == week }

    @Then("第 {int} 週の結果が、{int} 役割のそれぞれについて記録される")
    fun weekResultsAreRecorded(
        week: Int,
        roles: Int,
    ) {
        val recorded = resultsOf(facilitatorState(), week).map { Role.ofApi(it.text("role")) }.toSet()
        expect(recorded.size == roles && recorded == Role.entries.toSet()) {
            "第 $week 週の結果が記録された役割: ${recorded.map { it.label }}（期待: $roles 役割すべて）"
        }
    }

    @Then("各役割の参加者が見る状況は、第 {int} 週のものになる")
    fun everyRoleSeesWeek(week: Int) {
        Role.entries.forEach { role ->
            val view = ctx.sessionState(ctx.game, ctx.game.playerOf(role).cookie)
            expect(view.status == HTTP_OK && view.json.number("week") == week) {
                "${role.label}の状況は第 $week 週のはずが: ${view.status} ${view.text}"
            }
        }
    }

    @Then("第 {int} 週の結果は 1 回分だけである")
    fun weekResultsAreRecordedOnce(week: Int) {
        val state = facilitatorState()
        val results = resultsOf(state, week)
        expect(results.size == Role.entries.size && results.map { it.text("role") }.toSet().size == Role.entries.size) {
            "第 $week 週の結果が 1 回分（4 役割 × 1）ではない: ${results.size} 件"
        }
        expect(state.array("results").size == results.size) { "他の週の結果が混ざっている" }
    }

    @Then("第 {int} 週はすでに確定されているという理由で拒否される")
    fun rejectedBecauseWeekAdvanced(
        @Suppress("UNUSED_PARAMETER") week: Int,
    ) {
        val response = ctx.response()
        expect(response.status == HTTP_CONFLICT && response.code() == "session.week_advanced") {
            "確定済みの理由で拒否されていない: ${response.status} ${response.text}"
        }
    }

    @Then("2 つのゲームの全役割の状態と費用が一致する")
    fun bothGamesMatch() {
        val states = ctx.games.map { facilitatorState(it) }
        expect(states.size == 2) { "ゲームが 2 つではない: ${states.size}" }
        expect(states[0].obj("roles") == states[1].obj("roles")) { "全役割の状態が一致しない" }
        expect(states[0].array("results") == states[1].array("results")) { "結果（費用を含む）が一致しない" }
    }

    @Then("{int} 役割のそれぞれについて、注文、在庫、受注残、出荷、費用が含まれる")
    fun resultsHaveFields(roles: Int) {
        val results =
            ctx
                .response()
                .json
                .array("results")
                .map { it.jsonObject }
        expect(results.map { it.text("role") }.toSet().size == roles) { "結果の役割の数が $roles ではない" }
        results.forEach { result ->
            listOf("order", "inventory", "backlog", "shipment", "cost").forEach { field ->
                expect(result.containsKey(field)) { "${result.text("role")} の結果に $field がない" }
            }
        }
    }

    @Then("週は確定されない")
    fun weekNotCommitted() {
        val response = ctx.response()
        expect(response.status == HTTP_UNPROCESSABLE && response.code() == "session.incomplete_decisions") {
            "確定が拒否されていない: ${response.status} ${response.text}"
        }
        expect(facilitatorState().number("week") == 1) { "週が進んでいる" }
    }

    @Then("入力が不足している役割として{word}が示される")
    fun missingDecisionShown(label: String) {
        val missing =
            ctx
                .response()
                .json
                .array("missingRoles")
                .map { Role.ofApi(it.jsonPrimitive.content) }
        expect(missing == listOf(Role.ofLabel(label))) { "不足している役割が違う: ${missing.map { it.label }}" }
    }

    // ---- 入力の保存（US2.2） ----

    @When("{word}の参加者が、当週の数量として {int} を保存する")
    fun participantSavesQuantity(
        label: String,
        quantity: Int,
    ) {
        val player = ctx.game.playerOf(Role.ofLabel(label))
        lastActor = player
        savedQuantity = quantity
        ctx.last = ctx.api.saveDecision(ctx.game.id, 1, quantity.toString(), player.cookie)
        expect(ctx.response().status == HTTP_OK) { "保存できない: ${ctx.response().status} ${ctx.response().text}" }
    }

    @When("{word}の参加者が、当週の数量として「{}」を保存しようとする")
    fun participantTriesToSaveQuantity(
        label: String,
        input: String,
    ) {
        val player = ctx.game.playerOf(Role.ofLabel(label))
        lastActor = player
        // 空白は、空の文字列の値として送る。それ以外は、入力された値をそのまま JSON の値にする。
        val json = if (input.isBlank()) "\"\"" else input
        ctx.last = ctx.api.saveDecision(ctx.game.id, 1, json, player.cookie)
    }

    private fun decisionOf(player: Participant): String? =
        ctx.sessionState(ctx.game, player.cookie).json.obj("roleStatus")["decision"]?.jsonPrimitive?.content?.takeIf {
            it !=
                "null"
        }

    @Then("当週の{word}の入力として {int} が保存される")
    fun decisionIsSaved(
        label: String,
        quantity: Int,
    ) {
        val stored = decisionOf(ctx.game.playerOf(Role.ofLabel(label)))
        expect(stored == quantity.toString()) { "${label}の入力は $quantity のはずが: $stored" }
    }

    /**
     * 発注か生産要請かは、API の状況には出ない。そこで、4 役割の入力をそろえて確定し、その週の結果の「注文」（`order`。
     * 工場は生産要請）が、保存した数量になっていることで確かめる。種類は、原文（流通役は発注、生産役は生産要請）に従う。
     */
    @Then("その入力は{word}として扱われる")
    fun inputIsTreatedAs(kind: String) {
        val role = checkNotNull(lastActor?.role)
        val expectedKind = if (role == Role.FACTORY) "生産要請" else "発注"
        expect(kind == expectedKind) { "${role.label}の入力は${expectedKind}のはずが、シナリオは${kind}としている" }
        val others = Role.entries.filter { it != role }.associateWith { OTHER_INPUT }
        saveAll(ctx.game, 1, others)
        val committed = commit(ctx.game, 1)
        expect(committed.status == HTTP_OK) { "確定できない: ${committed.status} ${committed.text}" }
        val result = resultsOf(facilitatorState(), 1).first { it.text("role") == role.apiName }
        expect(result.number("order") == savedQuantity) {
            "${role.label}の${kind}が結果に反映されていない: ${result.text("order")}（保存: $savedQuantity）"
        }
    }

    @Then("数量は保存されない")
    fun quantityIsNotSaved() {
        val response = ctx.response()
        expect(response.status == HTTP_UNPROCESSABLE) { "拒否されていない: ${response.status} ${response.text}" }
        val stored = decisionOf(checkNotNull(lastActor))
        expect(stored == null) { "拒否したのに、入力が保存されている: $stored" }
    }

    @Then("数量の修正方法が示される")
    fun quantityCorrectionIsShown() {
        val errors =
            ctx
                .response()
                .json
                .array("errors")
                .map { it.jsonObject }
        val error = errors.singleOrNull()
        expect(error != null && error.text("field") == "quantity") { "数量の誤りが示されていない: $errors" }
        // 修正方法は、整数で指定することを含む（範囲外の数値の応答は、範囲も含むが、ここでは固定しない）。
        val message = error!!.text("message")
        expect("整数" in message) { "修正方法が、整数で指定することを示していない: $message" }
    }

    @Then("数量の保存は受け付けられる")
    fun quantityIsAccepted() {
        val response = ctx.response()
        expect(response.status == HTTP_OK) { "受け付けられていない: ${response.status} ${response.text}" }
    }

    @Then("数量の保存は拒否される")
    fun quantityIsRejected() {
        val response = ctx.response()
        expect(response.status == HTTP_UNPROCESSABLE) { "拒否されていない: ${response.status} ${response.text}" }
    }

    // ---- 役割別の状況（US2.1） ----

    @When("{word}の参加者が、自分の役割の状況を取得する")
    fun participantFetchesOwnSituation(label: String) {
        val player = ctx.game.playerOf(Role.ofLabel(label))
        lastActor = player
        ctx.last = ctx.sessionState(ctx.game, player.cookie)
    }

    @When("{word}の参加者が、{word}の状況を取得しようとする")
    fun participantTriesToFetchOthersSituation(
        label: String,
        otherLabel: String,
    ) {
        val player = ctx.game.playerOf(Role.ofLabel(label))
        lastActor = player
        ctx.last = ctx.api.sessionState(ctx.game.id, player.cookie, Role.ofLabel(otherLabel))
    }

    @Then("{word}の在庫、受注残、入荷、受注が返る")
    fun ownSituationIsReturned(label: String) {
        val response = ctx.response()
        expect(response.status == HTTP_OK) { "状況を取得できない: ${response.status} ${response.text}" }
        expect(response.json.text("role") == Role.ofLabel(label).apiName) { "役割が違う: ${response.json.text("role")}" }
        val status = response.json.obj("roleStatus")
        listOf("inventory", "backlog", "arrivals", "orders").forEach {
            expect(status.containsKey(it)) { "${label}の状況に $it がない: $status" }
        }
    }

    @Then("他の役割の値は含まれない")
    fun othersValuesAreNotIncluded() {
        val json = ctx.response().json
        expect(!json.containsKey("roles") && !json.containsKey("results")) { "全役割の状況・結果が含まれている: ${json.keys}" }
        val ownName = checkNotNull(lastActor).name
        ctx.game.participants.filter { it.name != ownName }.forEach {
            expect(it.name !in ctx.response().text) { "他の参加者の表示名が含まれている: ${it.name}" }
        }
        expect(ctx.game.joinCode !in ctx.response().text) { "参加コードが含まれている" }
    }

    @Then("権限エラーが返る")
    fun forbiddenIsReturned() {
        val response = ctx.response()
        expect(response.status == HTTP_FORBIDDEN && response.code() == "app.unauthorized") {
            "権限エラーではない: ${response.status} ${response.text}"
        }
    }

    @Then("{word}の値は返らない")
    fun valuesAreNotReturned(label: String) {
        val response = ctx.response()
        expect(!response.json.containsKey("roleStatus") && !response.json.containsKey("roles")) {
            "${label}の値が返っている: ${response.text}"
        }
        listOf("inventory", "backlog", "arrivals").forEach {
            expect(it !in response.text) { "${label}の値の項目 $it が返っている" }
        }
    }

    @Then("当週の顧客需要は含まれない")
    fun customerDemandIsNotIncluded() {
        val status = ctx.response().json.obj("roleStatus")
        expect(!status.containsKey("customerDemand")) { "当週の顧客需要が含まれている: $status" }
    }

    @Then("当週の顧客需要が含まれる")
    fun customerDemandIsIncluded() {
        val status = ctx.response().json.obj("roleStatus")
        expect(status.number("customerDemand") == DEMAND_SERIES.first()) {
            "当週の顧客需要が第 1 週の値（${DEMAND_SERIES.first()}）ではない: $status"
        }
    }

    @Then("将来の週の需要は含まれない")
    fun futureDemandsAreNotIncluded() {
        val leaked =
            ctx
                .response()
                .json
                .leaves()
                .filter { it in FUTURE_DEMANDS }
        expect(leaked.isEmpty()) { "将来の週の需要が含まれている: $leaked" }
    }
}
