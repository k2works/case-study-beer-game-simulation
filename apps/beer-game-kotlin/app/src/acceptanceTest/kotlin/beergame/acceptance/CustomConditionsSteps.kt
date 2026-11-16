package beergame.acceptance

import io.cucumber.java.en.Given
import io.cucumber.java.en.Then
import io.cucumber.java.en.When
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

private const val HTTP_UNPROCESSABLE = 422
private const val ROLE_PATTERN = "小売店|二次卸|一次卸|工場"

/** 変更した項目の呼び名（画面・受入の言葉）と、API の値。 */
private val FIELD_LABELS =
    mapOf(
        "初期在庫" to "INITIAL_INVENTORY",
        "初期の流れ" to "INITIAL_FLOW",
        "注文の遅延" to "ORDER_DELAY",
        "配送の遅延" to "SHIPMENT_DELAY",
        "生産の遅延" to "PRODUCTION_DELAY",
        "在庫の単価" to "HOLDING_COST",
        "受注残の単価" to "BACKLOG_COST",
        "公開範囲" to "DISCLOSURE",
    )

/** 条件の呼び名と、作成の入力（`conditions`）の項目名。 */
private val CONDITION_FIELDS =
    mapOf(
        "初期の流れ" to "initialFlow",
        "注文の遅延" to "orderDelayWeeks",
        "配送の遅延" to "shipmentDelayWeeks",
        "生産の遅延" to "productionDelayWeeks",
        "在庫の単価" to "holdingCostMinor",
        "受注残の単価" to "backlogCostMinor",
        "公開範囲" to "disclosurePolicy",
    )

private val DISCLOSURE_VALUES = mapOf("なし" to "NONE", "チーム合計" to "TEAM_TOTAL")

/** `小売店の初期在庫を 20、配送の遅延を 3 週` のような言い方を、`conditions` の JSON にする。 */
private fun conditionsJson(phrase: String): String {
    val inventory = mutableMapOf<String, String>()
    val others = mutableMapOf<String, String>()
    phrase.split("、").map(String::trim).filter(String::isNotEmpty).forEach { part ->
        val (label, rawValue) =
            part
                .split(
                    Regex("を\\s*"),
                    limit = 2,
                ).also { check(it.size == 2) { "条件の言い方が違う: $part" } }
        val value = rawValue.removeSuffix("週").trim().removeSurrounding("「", "」")
        val inventoryOf = Regex("^($ROLE_PATTERN)の初期在庫$").find(label)
        if (inventoryOf != null) {
            inventory[Role.ofLabel(inventoryOf.groupValues[1]).apiName] = value
        } else {
            val name = checkNotNull(CONDITION_FIELDS[label]) { "知らない条件: $label" }
            others[name] = if (name == "disclosurePolicy") "\"${DISCLOSURE_VALUES[value] ?: value}\"" else value
        }
    }
    val parts = mutableListOf<String>()
    if (inventory.isNotEmpty()) {
        parts += "\"initialInventory\":{${inventory.entries.joinToString(",") { "\"${it.key}\":${it.value}" }}}"
    }
    others.forEach { (name, value) -> parts += "\"$name\":$value" }
    return "{${parts.joinToString(",")}}"
}

private fun customBody(
    phrase: String,
    kind: String = "CUSTOM",
): String =
    kitGameBody().replace("\"kind\":\"KIT\"", "\"kind\":\"$kind\"").removeSuffix("}") +
        ",\"conditions\":${conditionsJson(phrase)}}"

/** カスタム条件のステップ定義（US1.1 の AC1.1.3〜1.1.5）。薄く保つ。 */
class CustomConditionsSteps {
    private val ctx get() = Scenario.current

    @When("進行役が、{}に変えて、ゲームを作成する")
    fun createCustom(phrase: String) {
        ctx.last = ctx.createGame(customBody(phrase))
    }

    @When("進行役が、{}に変えて、ゲームを作成しようとする")
    fun tryCreateCustom(phrase: String) {
        ctx.last = ctx.createGame(customBody(phrase))
    }

    @Given("進行役が、{}に変えて、ゲームを作成している")
    fun createdCustom(phrase: String) {
        val response = ctx.createGame(customBody(phrase))
        expect(response.status == ScenarioContext.HTTP_CREATED) { "作成できない: ${response.status} ${response.text}" }
    }

    @When("進行役が、キットの値のままの条件を指定して、ゲームをカスタムで作成する")
    fun createCustomWithKitValues() {
        ctx.last =
            ctx.createGame(
                customBody("初期の流れを 4、注文の遅延を 2、配送の遅延を 2、生産の遅延を 2、在庫の単価を 50、受注残の単価を 100、公開範囲を チーム合計"),
            )
    }

    @When("進行役が、キット準拠の作成に、配送の遅延 3 週の条件を付けて作成しようとする")
    fun createKitWithConditions() {
        ctx.last = ctx.createGame(customBody("配送の遅延を 3 週", kind = "KIT"))
    }

    @When("進行役が、最終週 {int} の設定でゲームを作成しようとする")
    fun createWithFinalWeek(finalWeek: Int) {
        ctx.last = ctx.createGame(kitGameBody(finalWeek, List(finalWeek) { 4 }))
    }

    @Then("ゲームが作成される")
    fun gameCreated() {
        val response = ctx.response()
        expect(response.status == ScenarioContext.HTTP_CREATED) { "作成されていない: ${response.status} ${response.text}" }
        expect(ctx.games.size == 1) { "ゲームの数が 1 ではない: ${ctx.games.size}" }
    }

    @Then("ゲームの設定の種別は「カスタム」で、変更した項目は{}である")
    fun kindIsCustom(labels: String) {
        val expected =
            Regex(
                "「([^」]+)」",
            ).findAll(labels).map { checkNotNull(FIELD_LABELS[it.groupValues[1]]) { "知らない項目: $labels" } }.toSet()
        val (kind, changes) = settingsOfCreatedGame()
        expect(kind == "CUSTOM") { "種別が CUSTOM ではない: $kind" }
        expect(changes == expected) { "変更した項目が違う: 期待 $expected、実際 $changes" }
    }

    @Then("ゲームの設定の種別は「キット準拠」で、変更した項目は無い")
    fun kindIsKit() {
        val (kind, changes) = settingsOfCreatedGame()
        expect(kind == "KIT") { "種別が KIT ではない: $kind" }
        expect(changes.isEmpty()) { "変更した項目がある: $changes" }
    }

    @Then("誤りの対象は「条件」であり、カスタムで作成するという修正内容が示される")
    fun errorSaysUseCustom() {
        val error = errors().single { it.text("field") == "conditions" }
        expect("CUSTOM" in error.text("message") || "カスタム" in error.text("message")) {
            "修正内容がカスタムを示さない: ${error.text("message")}"
        }
    }

    @Then("誤りの対象は「{}」であり、「{}」にするという修正内容が示される")
    fun errorPointsAtConditionWithCorrection(
        name: String,
        correction: String,
    ) {
        assertRejected()
        val error =
            checkNotNull(
                errors().firstOrNull {
                    it.text("field").removePrefix("conditions.").substringBefore('.') ==
                        name
                },
            ) {
                "「$name」を示す誤りがない: ${errors()}"
            }
        expect(correction.replace(" ", "") in error.text("message").replace(" ", "")) {
            "修正内容に「$correction」が無い: ${error.text("message")}"
        }
    }

    @Then("誤りの対象として「{}」と「{}」の両方が示される")
    fun bothErrorsShown(
        first: String,
        second: String,
    ) {
        assertRejected()
        val fields = errors().map { it.text("field").removePrefix("conditions.").substringBefore('.') }
        expect(first in fields && second in fields) { "両方が示されていない: $fields" }
    }

    @Then("最終週は 1 以上 50 以下の整数にするという修正内容が示される")
    fun finalWeekCorrectionShown() {
        assertRejected()
        val messages = errors().map { it.text("message") }
        expect(messages.any { "1" in it && "50" in it && "整数" in it }) { "最終週の修正内容が示されていない: $messages" }
    }

    @Then("小売店の第 {int} 週の在庫は {int} である")
    fun retailerInventory(
        week: Int,
        inventory: Int,
    ) {
        val retailer = ctx.game.playerOf(Role.RETAILER)
        val state = ctx.api.sessionState(ctx.game.id, retailer.cookie).json
        expect(state.text("week") == week.toString()) { "第 $week 週ではない: ${state.text("week")}" }
        val actual = state.getValue("roleStatus").jsonObject.text("inventory")
        expect(actual == inventory.toString()) { "在庫が $inventory ではない: $actual" }
    }

    private fun assertRejected() {
        val response = ctx.response()
        expect(response.status == HTTP_UNPROCESSABLE) { "拒否されていない: ${response.status} ${response.text}" }
        expect(ctx.games.isEmpty()) { "ゲームが作られている" }
    }

    private fun errors() =
        ctx
            .response()
            .json
            .array("errors")
            .map { it.jsonObject }

    private fun settingsOfCreatedGame(): Pair<String, Set<String>> {
        val state = ctx.api.gameState(ctx.game.id, ctx.game.facilitator).json
        val changes =
            state["changedSettings"]
                ?.jsonArray
                ?.map { it.jsonPrimitive.content }
                ?.toSet()
                .orEmpty()
        return state.text("settingsKind") to changes
    }
}
