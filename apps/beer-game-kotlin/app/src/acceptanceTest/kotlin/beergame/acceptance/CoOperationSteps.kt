package beergame.acceptance

import io.cucumber.java.en.Given
import io.cucumber.java.en.Then
import io.cucumber.java.en.When
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.time.OffsetDateTime
import java.time.format.DateTimeParseException

private const val HTTP_OK = 200
private const val HTTP_FORBIDDEN = 403
private const val HTTP_CONFLICT = 409
private const val CONFLICT_CODE = "session.decision_conflict"
private const val CHANGED_CODE = "session.decisions_changed"
private const val OVER_LIMIT_QUANTITY = 100
private const val FILLER_QUANTITY = 10
private const val PARTICIPANT_KIND = "PARTICIPANT"
private const val PROXY_KIND = "FACILITATOR_PROXY"
private const val PARTICIPANT_SUFFIX = "の参加者"

/** 値の葉（数値・文字列・null）をすべて集める。開示しない値が、どの項目にも無いことの確認に使う（部分文字列は使わない）。 */
private fun JsonElement.leafValues(): List<String> =
    when (this) {
        is JsonObject -> values.flatMap { it.leafValues() }
        is JsonArray -> flatMap { it.leafValues() }
        is JsonPrimitive -> listOf(content)
    }

/** 項目が無い、または null のときは null。あれば文字列にする。 */
private fun optionalText(
    json: JsonObject,
    name: String,
): String? = json[name]?.takeIf { it !is JsonNull }?.jsonPrimitive?.content

/**
 * 共同担当（同じ役割の複数の参加者）の入力・競合・確定の区別のステップ定義（B6。AC1.2.4、AC2.1.4、AC2.2.3、AC2.2.4）。
 * 薄く保ち、HTTP を呼んで、期待値を確かめるだけ。応答の形は contracts/openapi.yaml の提案（ゲート 1 で人が決める）。
 * 実装が無い間は、保存者・時刻の項目が無いことなどで失敗する（Red）。
 */
class CoOperationSteps {
    private val ctx get() = Scenario.current

    private var viewedVersion = 0
    private var basis: Map<Role, Int>? = null

    /** 「小売店の参加者」は、その役割に最初に割り当てた参加者。それ以外は、表示名で引く。 */
    private fun holder(who: String): Participant =
        if (who.endsWith(PARTICIPANT_SUFFIX)) {
            ctx.game.playerOf(Role.ofLabel(who.removeSuffix(PARTICIPANT_SUFFIX)))
        } else {
            ctx.game.participantNamed(who.trim())
        }

    private fun facilitatorState(): JsonObject = ctx.sessionState(ctx.game).json

    private fun currentWeek(): Int = facilitatorState().number("week")

    private fun versionOf(role: Role): Int = facilitatorState().obj("roles").obj(role.apiName).number("decisionVersion")

    private fun statusOf(who: Participant): ApiResponse {
        val response = ctx.sessionState(ctx.game, who.cookie)
        expect(response.status == HTTP_OK) { "${who.name}の状況を取得できない: ${response.status} ${response.text}" }
        return response
    }

    private fun saveAt(
        who: Participant,
        quantity: Int,
        version: Int,
    ): ApiResponse = ctx.api.saveDecisionAt(ctx.game.id, currentWeek(), quantity, version, who.cookie)

    private fun saveNow(
        who: Participant,
        quantity: Int,
    ): ApiResponse = saveAt(who, quantity, versionOf(checkNotNull(who.role)))

    private fun mustSucceed(
        response: ApiResponse,
        what: String,
    ) = expect(response.status == HTTP_OK) { "$what: ${response.status} ${response.text}" }

    // ---- 割り当てと開始（AC1.2.4） ----

    @When("進行役がゲームを開始する")
    fun facilitatorStartsGame() {
        ctx.last = ctx.start(ctx.game)
    }

    @Then("ゲームは開始されている")
    fun gameIsStarted() {
        val response = ctx.response()
        expect(response.status == HTTP_OK) { "開始できていない: ${response.status} ${response.text}" }
        val state = ctx.api.gameState(ctx.game.id, ctx.game.facilitator)
        val status = state.json.text("status")
        expect(status == "STARTED") { "ゲームの状態が開始後ではない: $status" }
    }

    @Then("{word}に {int} 人の参加者が割り当てられている")
    fun roleHasHolders(
        label: String,
        count: Int,
    ) {
        val role = Role.ofLabel(label).apiName
        val participants =
            ctx.api
                .lobby(ctx.game.id, ctx.game.facilitator)
                .json
                .array("participants")
                .map { it.jsonObject }
        val holders = participants.filter { optionalText(it, "role") == role }
        expect(holders.size == count) { "${label}の担当者は $count 人のはずが、${holders.size} 人: $holders" }
    }

    @Then("共同担当だった{}の資格も、自動で失効している")
    fun coHolderCredentialIsRevoked(name: String) {
        val who = holder(name)
        val session = ctx.api.gameState(ctx.game.id, who.cookie)
        expect(session.status == HTTP_FORBIDDEN && session.code() == "app.unauthorized") {
            "共同担当だった${name}のブラウザセッションが使える: ${session.status} ${session.text}"
        }
        val recovery = ctx.api.recover(ctx.game.id, recovery = who.recovery)
        expect(recovery.status == HTTP_FORBIDDEN && recovery.credential() == null) {
            "共同担当だった${name}が復帰できてしまう: ${recovery.status} ${recovery.text}"
        }
    }

    // ---- 状況の取得（AC2.1.4、AC2.2.4） ----

    @When("共同担当の{}が、自分の役割の状況を取得する")
    fun coHolderFetchesSituation(name: String) {
        ctx.last = ctx.sessionState(ctx.game, holder(name).cookie)
    }

    private fun roleStatusOf(who: Participant): JsonObject = statusOf(who).json.obj("roleStatus")

    private fun decisionOf(status: JsonObject): Int? = optionalText(status, "decision")?.toInt()

    private fun shouldSee(
        name: String,
        quantity: Int,
        version: Int,
    ) {
        val status = roleStatusOf(holder(name))
        expect(decisionOf(status) == quantity && status.number("decisionVersion") == version) {
            "${name}が見る入力値・版は $quantity・$version のはずが: ${decisionOf(status)}・${status["decisionVersion"]}"
        }
    }

    @Then("{}が見る入力値は {int}、版は {int} である")
    fun seesDecision(
        name: String,
        quantity: Int,
        version: Int,
    ) = shouldSee(name, quantity, version)

    @Then("共同担当の{}が取得した状況は、入力値 {int}、版 {int} になる")
    fun coHolderSeesDecision(
        name: String,
        quantity: Int,
        version: Int,
    ) = shouldSee(name, quantity, version)

    /** 状況の共通部分。誰が見ても同じ値になる項目だけを比べる（「自分かどうか」の印は、見る人ごとに違う）。 */
    private fun sharedView(response: ApiResponse): Map<String, Any?> {
        val json = response.json
        val status = json.obj("roleStatus")
        val editor = status["decisionEditor"]?.takeIf { it !is JsonNull }?.jsonObject
        return mapOf(
            "status" to json["status"],
            "week" to json["week"],
            "role" to json["role"],
            "submittedRoleCount" to json["submittedRoleCount"],
            "roleStatus" to JsonObject(status.filterKeys { it != "decisionEditor" }),
            "editorKind" to editor?.get("kind"),
            "editorName" to editor?.get("displayName"),
        )
    }

    @Then("{}が見る状況は、{}が見る状況と同じである")
    fun seesSameSituation(
        one: String,
        other: String,
    ) {
        val first = sharedView(statusOf(holder(one)))
        val second = sharedView(statusOf(holder(other)))
        expect(first == second) { "${one}と${other}が見る状況が違う: $first / $second" }
    }

    @Then("同じ役割の共同担当として、{}と{}が示される")
    fun coHoldersAreShown(
        one: String,
        other: String,
    ) {
        val response = ctx.response()
        val coHolders = response.json["coHolders"]
        expect(coHolders is JsonArray) { "状況に、同じ役割の共同担当（coHolders）が含まれない: ${response.text}" }
        val entries = (coHolders as JsonArray).map { it.jsonObject }
        val names = entries.map { it.text("displayName") }.toSet()
        expect(names == setOf(holder(one).name, holder(other).name)) { "共同担当の表示名が違う: $names" }
        val self = entries.filter { it["isSelf"]?.jsonPrimitive?.boolean == true }.map { it.text("displayName") }
        expect(self.size == 1) { "自分の印が 1 人分だけ付くはずが: $self" }
    }

    @Then("{}が見る最後の保存者は、{}である")
    fun seesLastEditor(
        name: String,
        editorName: String,
    ) {
        val viewer = holder(name)
        val editor = roleStatusOf(viewer)["decisionEditor"]
        expect(editor is JsonObject) { "状況に、最後の保存者（decisionEditor）が含まれない" }
        val fields = (editor as JsonObject)
        val self = editorName == "自分自身"
        val expectedName = if (self) viewer.name else holder(editorName).name
        expect(
            fields.text("kind") == PARTICIPANT_KIND &&
                fields["displayName"]?.jsonPrimitive?.content == expectedName &&
                fields["isSelf"]?.jsonPrimitive?.boolean == self,
        ) { "最後の保存者が $expectedName（自分: $self）ではない: $fields" }
    }

    @Then("他の役割の担当者の表示名・ID は、どの項目にも含まれない")
    fun otherRolesHoldersAreNotDisclosed() {
        val response = ctx.response()
        val ownRole = response.json.text("role")
        val leaves = response.json.leafValues().toSet()
        val others = ctx.game.participants.filter { it.role?.apiName != ownRole }
        expect(others.isNotEmpty()) { "他の役割の参加者がいない（試験の前提が崩れている）" }
        others.forEach {
            expect(it.name !in leaves && it.participantId !in leaves) {
                "他の役割の担当者 ${it.name} の表示名または ID が含まれている: ${response.text}"
            }
        }
    }

    @Then("入力値・版は、自分の役割のもの（入力なし、版 0）である")
    fun valuesAreOwn() {
        val status = ctx.response().json.obj("roleStatus")
        expect(decisionOf(status) == null && status.number("decisionVersion") == 0) {
            "入力値・版が自分の役割のもの（入力なし、版 0）ではない: $status"
        }
        expect(status["decisionEditor"].let { it == null || it is JsonNull }) { "他の役割の保存者が含まれている: $status" }
    }

    // ---- 共同入力の競合（AC2.2.3） ----

    @Given("{}と{}が、同じ版の画面を見ている")
    fun bothSeeSameVersion(
        one: String,
        other: String,
    ) {
        val versions = listOf(holder(one), holder(other)).map { roleStatusOf(it).number("decisionVersion") }
        expect(versions.distinct().size == 1) { "同じ版を見ていない: $versions" }
        viewedVersion = versions.first()
    }

    @Given("{}が、見ていた版のまま、数量 {int} を保存している")
    fun hasSavedAtViewedVersion(
        name: String,
        quantity: Int,
    ) = mustSucceed(saveAt(holder(name), quantity, viewedVersion), "保存できない")

    @When("{}が、見ていた版のまま、数量 {int} を保存しようとする")
    fun triesToSaveAtViewedVersion(
        name: String,
        quantity: Int,
    ) {
        ctx.last = saveAt(holder(name), quantity, viewedVersion)
    }

    @Given("{}が、見ていた版のまま、数量 {int} を保存しようとして、競合している")
    fun hasConflictedAtViewedVersion(
        name: String,
        quantity: Int,
    ) {
        val response = saveAt(holder(name), quantity, viewedVersion)
        expect(response.status == HTTP_CONFLICT && response.code() == CONFLICT_CODE) {
            "競合になっていない: ${response.status} ${response.text}"
        }
    }

    @When("{}が、最新の版を指定して、数量 {int} を保存し直す")
    fun savesAgainAtLatestVersion(
        name: String,
        quantity: Int,
    ) {
        ctx.last = saveNow(holder(name), quantity)
    }

    @Then("保存は競合として拒否される")
    fun rejectedAsConflict() {
        val response = ctx.response()
        expect(response.status == HTTP_CONFLICT && response.code() == CONFLICT_CODE) {
            "競合として拒否されていない: ${response.status} ${response.text}"
        }
    }

    private fun latestOf(response: ApiResponse): JsonObject {
        val latest = response.json["latest"]
        expect(latest is JsonObject) { "競合の応答に、最新の入力（latest）が含まれない: ${response.text}" }
        return latest as JsonObject
    }

    @Then("競合の応答に、最新の入力 {int}、版 {int} が含まれる")
    fun conflictHasLatest(
        quantity: Int,
        version: Int,
    ) {
        val latest = latestOf(ctx.response())
        expect(latest.number("quantity") == quantity && latest.number("version") == version) {
            "最新の入力・版が $quantity・$version ではない: $latest"
        }
    }

    @Then("最後の保存者として{}が、保存の時刻とともに示される")
    fun conflictHasEditorAndTime(name: String) {
        val latest = latestOf(ctx.response())
        val editor = latest["editor"]
        expect(editor is JsonObject) { "競合の応答に、保存者（editor）が含まれない: $latest" }
        val fields = editor as JsonObject
        expect(
            fields.text("kind") == PARTICIPANT_KIND &&
                fields["displayName"]?.jsonPrimitive?.content == holder(name).name &&
                fields["isSelf"]?.jsonPrimitive?.boolean == false,
        ) { "保存者が ${holder(name).name} ではない: $fields" }
        val savedAt = latest["savedAt"]?.jsonPrimitive?.content
        expect(savedAt != null && isTimestamp(savedAt)) { "保存の時刻（savedAt）が含まれない、または時刻の形ではない: $savedAt" }
    }

    private fun isTimestamp(text: String): Boolean =
        try {
            OffsetDateTime.parse(text)
            true
        } catch (_: DateTimeParseException) {
            false
        }

    @Then("最後の保存者は、進行役の代理入力として示される")
    fun editorIsFacilitatorProxy() {
        val latest = latestOf(ctx.response())
        val editor = latest["editor"]
        expect(editor is JsonObject) { "競合の応答に、保存者（editor）が含まれない: $latest" }
        val fields = editor as JsonObject
        expect(fields.text("kind") == PROXY_KIND && !fields.containsKey("displayName")) {
            "保存者が進行役の代理入力（表示名なし）ではない: $fields"
        }
    }

    @Then("競合した入力 {int} は、応答に含まれない")
    fun conflictedInputIsNotEchoed(quantity: Int) {
        val leaves = ctx.response().json.leafValues()
        expect(quantity.toString() !in leaves) { "競合した入力 $quantity が応答に含まれている: ${ctx.response().text}" }
    }

    @Then("保存が受け付けられる")
    fun saveAccepted() = mustSucceed(ctx.response(), "保存が受け付けられていない")

    @Then("当週の{word}の入力は {int}、版は {int} である")
    fun roleHasDecisionAndVersion(
        label: String,
        quantity: Int,
        version: Int,
    ) {
        val status = facilitatorState().obj("roles").obj(Role.ofLabel(label).apiName)
        expect(decisionOf(status) == quantity && status.number("decisionVersion") == version) {
            "${label}の入力・版は $quantity・$version のはずが: $status"
        }
    }

    // ---- 保存回数の上限（NF-C8。共同担当で共有） ----

    private fun saveManyTimes(
        who: Participant,
        times: Int,
    ) {
        repeat(times) { index ->
            mustSucceed(saveNow(who, FILLER_QUANTITY + index), "${index + 1} 回目の保存ができない")
        }
    }

    @Given("共同担当の{}が、当週の数量をさらに {int} 回保存している")
    fun coHolderSavedMore(
        name: String,
        times: Int,
    ) = saveManyTimes(holder(name), times)

    @Given("{}が、当週の数量をあと {int} 回保存している")
    fun holderSavedMore(
        name: String,
        times: Int,
    ) = saveManyTimes(holder(name), times)

    @When("共同担当の{}が、当週の数量をもう 1 回保存しようとする")
    fun coHolderTriesOneMore(name: String) {
        ctx.last = saveNow(holder(name), OVER_LIMIT_QUANTITY)
    }

    // ---- 週の確定の区別（WeekAdvanced と DecisionsChanged） ----

    @Given("共同担当の{}が、当週の数量を {int} に保存し直している")
    fun coHolderSavedAgain(
        name: String,
        quantity: Int,
    ) = mustSucceed(saveNow(holder(name), quantity), "保存し直せない")

    @Given("進行役が、確定の確認画面を開いて、各役割の入力の版を控えている")
    fun facilitatorOpensConfirmation() {
        basis = ctx.basisOf(ctx.game)
    }

    @When("進行役が、控えた版のまま第 {int} 週を確定しようとする")
    fun facilitatorCommitsWithRememberedBasis(week: Int) {
        val remembered = checkNotNull(basis) { "確認画面で版を控えていない" }
        ctx.last =
            ctx.api.commitWeek(ctx.game.id, week, ctx.api.commitBody(week, remembered), ctx.game.facilitator)
    }

    @Then("確定の根拠にした入力が変わったという理由で拒否される")
    fun rejectedAsDecisionsChanged() {
        val response = ctx.response()
        expect(response.status == HTTP_CONFLICT && response.code() == CHANGED_CODE) {
            "確定の根拠が変わった理由で拒否されていない: ${response.status} ${response.text}"
        }
    }

    @Then("現在の入力として、{word}の {int}（保存者: {}）が示される")
    fun currentDecisionIsShown(
        label: String,
        quantity: Int,
        editorName: String,
    ) {
        val current = ctx.response().json["current"]
        expect(current is JsonObject) { "応答に、現在の入力（current）が含まれない: ${ctx.response().text}" }
        val entry = (current as JsonObject)[Role.ofLabel(label).apiName]?.jsonObject
        expect(entry != null && entry.number("quantity") == quantity) { "${label}の現在の入力が $quantity ではない: $current" }
        val editor = checkNotNull(entry)["editor"]
        expect(editor is JsonObject && editor.jsonObject["displayName"]?.jsonPrimitive?.content == editorName) {
            "${label}の保存者が $editorName ではない（保存者の項目: $editor）"
        }
    }

    @Then("確定の根拠が変わったという理由ではない")
    fun notDecisionsChanged() {
        val response = ctx.response()
        expect(response.code() != CHANGED_CODE) { "確定の根拠が変わった理由になっている（週が先に判定されるはず）: ${response.text}" }
    }
}
