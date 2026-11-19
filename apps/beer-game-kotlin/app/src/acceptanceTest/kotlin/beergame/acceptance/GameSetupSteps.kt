package beergame.acceptance

import io.cucumber.java.en.Given
import io.cucumber.java.en.Then
import io.cucumber.java.en.When
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/** 期待と違うときに、業務の言葉で失敗させる。 */
fun expect(
    condition: Boolean,
    message: () -> String,
) {
    if (!condition) throw AssertionError(message())
}

private const val UNKNOWN_JOIN_CODE = "ZZZZZZZZZZZZ"
private const val HTTP_UNPROCESSABLE = 422
private const val HTTP_FORBIDDEN = 403
private const val HTTP_CONFLICT = 409
private const val ROLE_LABELS = "小売店|二次卸|一次卸|工場"

/** ゲームの作成・参加・割り当て・開始のステップ定義（US1.1、US1.2、および他のフィーチャーの背景）。薄く保つ。 */
class GameSetupSteps {
    private val ctx get() = Scenario.current

    // ---- 作成（US1.1） ----

    @Given("進行役がゲームを作成していない")
    fun noGameYet() = expect(ctx.games.isEmpty()) { "すでにゲームがある" }

    @Given("進行役が、キット準拠のゲームを作成している")
    fun facilitatorCreatedKitGame() {
        val response = ctx.createGame()
        expect(response.status == ScenarioContext.HTTP_CREATED) { "作成できない: ${response.status} ${response.text}" }
    }

    @When("進行役が、有効なキット準拠の設定でゲームを作成する")
    fun createWithValidKitSettings() {
        val key = ctx.api.newKey()
        ctx.last = ctx.createGame(kitGameBody(), key)
        createKey = key
    }

    @When("進行役が、最終週 {int} で第 {int} 週の需要が {int} の設定でゲームを作成しようとする")
    fun createWithInvalidDemand(
        finalWeek: Int,
        week: Int,
        demand: Int,
    ) {
        val series = List(finalWeek) { DEMAND_SERIES[1] }.toMutableList()
        series[week - 1] = demand
        ctx.last = ctx.createGame(kitGameBody(finalWeek, series))
    }

    @Then("参加コードの付いた、準備中のゲームが作成される")
    fun gameCreatedInPreparation() {
        val created = ctx.response()
        expect(created.status == ScenarioContext.HTTP_CREATED) { "ゲームが作成されていない: ${created.status} ${created.text}" }
        val state = ctx.api.gameState(ctx.game.id, ctx.game.facilitator).json
        expect(state.text("status") == "PREPARING") { "準備中ではない: ${state.text("status")}" }
        expect(state.text("joinCode").isNotBlank()) { "参加コードがない" }
    }

    @Then("作成を同じ要求でもう一度送っても、ゲームは 1 つのままである")
    fun resendCreateKeepsOneGame() {
        val first = ctx.response()
        val again = ctx.api.createGame(kitGameBody(), checkNotNull(createKey))
        expect(again.status == ScenarioContext.HTTP_CREATED) { "再送の応答が違う: ${again.status} ${again.text}" }
        expect(again.createdGameId() == first.createdGameId()) {
            "再送で別のゲームが作られた: ${first.createdGameId()} と ${again.createdGameId()}"
        }
        expect(again.credential() == first.credential()) { "再送で別の資格が発行された" }
    }

    @Then("ゲームは作成されない")
    fun gameNotCreated() {
        val response = ctx.response()
        expect(response.status == HTTP_UNPROCESSABLE) { "拒否されていない: ${response.status} ${response.text}" }
        expect(response.header("Location") == null && response.credential() == null) { "拒否したのに、ゲームの参照や資格が返った" }
        expect(ctx.games.isEmpty()) { "ゲームが作られている" }
    }

    @Then("誤りの対象は第 {int} 週であり、需要は 0 以上 1000 以下の整数にするという修正内容が示される")
    fun errorPointsAtWeekWithCorrection(week: Int) {
        val errors =
            ctx
                .response()
                .json
                .array("errors")
                .map { it.jsonObject }
        val error =
            checkNotNull(errors.singleOrNull { it["week"]?.jsonPrimitive?.content == week.toString() }) {
                "第 $week 週を示す誤りがない: $errors"
            }
        expect(error.text("field") == "demand") { "対象が需要ではない: ${error.text("field")}" }
        val message = error.text("message")
        expect("0" in message && "1000" in message && "整数" in message) { "修正内容が、0〜1000 の整数を示していない: $message" }
    }

    // ---- 参加（US1.2） ----

    @When("参加者が、有効な参加コードと表示名「{}」で参加する")
    fun joinWithValidCode(name: String) {
        ctx.last = ctx.api.join(ctx.game.joinCode, name)
        joinedName = name
    }

    @When("参加者が、存在しない参加コードと表示名「{}」で参加しようとする")
    fun joinWithUnknownCode(name: String) {
        expect(UNKNOWN_JOIN_CODE != ctx.game.joinCode) { "存在しない参加コードが、実在のコードと一致した" }
        ctx.last = ctx.api.join(UNKNOWN_JOIN_CODE, name)
    }

    @When("新しい参加者が、そのゲームの参加コードと表示名「{}」で参加しようとする")
    fun joinClosedGame(name: String) {
        ctx.last = ctx.api.join(ctx.game.joinCode, name)
    }

    @Then("参加者はロビーに参加している")
    fun participantIsInLobby() {
        val response = ctx.response()
        expect(response.status in ScenarioContext.HTTP_OK..ScenarioContext.HTTP_CREATED) {
            "参加できていない: ${response.status} ${response.text}"
        }
        val lobby =
            ctx.api
                .lobby(ctx.game.id, ctx.game.facilitator)
                .json
                .array("participants")
        val names = lobby.map { it.jsonObject["displayName"]?.jsonPrimitive?.content }
        expect(joinedName in names) { "ロビーに「$joinedName」がいない: $names" }
    }

    @Then("参加者の復帰資格が保存されている")
    fun recoveryCredentialIsStored() {
        val cookie = ctx.response().credential()
        expect(cookie != null) { "復帰資格が発行されていない" }
        // 資格が使える（サーバーが保存し、認証できる）ことを、その資格での問い合わせで確かめる。
        val state = ctx.api.gameState(ctx.game.id, cookie)
        expect(state.status == ScenarioContext.HTTP_OK && state.json.text("participantId").isNotBlank()) {
            "発行された資格で、自分の状態を取得できない: ${state.status} ${state.text}"
        }
    }

    @Then("参加者は参加できない")
    fun participantCannotJoin() {
        val response = ctx.response()
        expect(response.status >= ApiResponse.HTTP_ERROR && response.credential() == null) {
            "参加できてしまった: ${response.status} ${response.text}"
        }
    }

    @Then("参加コードが無効であるという理由が示される")
    fun reasonIsInvalidJoinCode() = reasonIs(HTTP_FORBIDDEN, "game.invitation_invalid")

    @Then("参加の受付が終了しているという理由が示される")
    fun reasonIsJoinClosed() = reasonIs(HTTP_CONFLICT, "game.not_preparing")

    private fun reasonIs(
        status: Int,
        code: String,
    ) {
        val response = ctx.response()
        expect(response.status == status && response.code() == code) {
            "理由が $code（$status）ではない: ${response.status} ${response.text}"
        }
        expect(response.json.text("title").isNotBlank()) { "理由の文がない" }
    }

    // ---- 役割の割り当てと開始（US1.2） ----

    @Given("{int} 人の参加者が、{}にそれぞれ割り当てられている")
    fun participantsAssignedToRoles(
        count: Int,
        labels: String,
    ) {
        val roles = labels.split("、").map(Role::ofLabel)
        expect(roles.size == count) { "人数 $count と役割の数 ${roles.size} が違う" }
        ctx.joinAndAssign(ctx.game, roles)
    }

    @Given("参加者「{}」が{word}に割り当てられている")
    fun participantAssignedToRole(
        name: String,
        label: String,
    ) {
        val participant = ctx.join(ctx.game, name)
        val response = ctx.assign(ctx.game, participant, Role.ofLabel(label))
        expect(response.status == ScenarioContext.HTTP_OK) { "割り当てられない: ${response.status} ${response.text}" }
        roleBeforeMove =
            ctx.api
                .lobby(ctx.game.id, ctx.game.facilitator)
                .json
                .roleOf(name)
    }

    @Given("進行役がゲームを開始している")
    fun facilitatorStartedGame() {
        val response = ctx.start(ctx.game)
        expect(response.status == ScenarioContext.HTTP_OK) { "開始できない: ${response.status} ${response.text}" }
    }

    @When("進行役がゲームを開始しようとする")
    fun facilitatorTriesToStart() {
        ctx.last = ctx.start(ctx.game)
    }

    @Then("ゲームは開始されない")
    fun gameNotStarted() {
        val response = ctx.response()
        expect(response.status == HTTP_UNPROCESSABLE) { "開始が拒否されていない: ${response.status} ${response.text}" }
        val status =
            ctx.api
                .gameState(ctx.game.id, ctx.game.facilitator)
                .json
                .text("status")
        expect(status == "PREPARING") { "ゲームの状態が準備中のままではない: $status" }
    }

    @Then("不足している役割として{word}が示される")
    fun missingRoleShown(label: String) = missingRolesAre(listOf(Role.ofLabel(label)))

    private fun missingRolesAre(expected: List<Role>) {
        val response = ctx.response()
        val missing = response.json.array("missingRoles").map { Role.ofApi(it.jsonPrimitive.content) }
        expect(missing == expected) { "不足している役割が違う: ${missing.map { it.label }}（期待: ${expected.map { it.label }}）" }
    }

    @When("進行役が、{}を{word}に割り当てる")
    fun facilitatorAssigns(
        name: String,
        label: String,
    ) {
        val participant = ctx.game.participantNamed(name.trim())
        ctx.last = ctx.assign(ctx.game, participant, Role.ofLabel(label))
    }

    @Then("{}は{word}に割り当てられている")
    fun participantIsAssigned(
        name: String,
        label: String,
    ) {
        val role =
            ctx.api
                .lobby(ctx.game.id, ctx.game.facilitator)
                .json
                .roleOf(name.trim())
        expect(
            role == Role.ofLabel(label).apiName,
        ) { "$name の役割は ${role ?: "未割当て"}（期待: ${Role.ofLabel(label).apiName}）" }
    }

    @Then("{}は{word}には割り当てられていない")
    fun participantIsNotAssigned(
        name: String,
        label: String,
    ) {
        val lobby = ctx.api.lobby(ctx.game.id, ctx.game.facilitator).json
        val holders =
            lobby.array("participants").map { it.jsonObject }.filter {
                it["role"]?.jsonPrimitive?.content ==
                    Role.ofLabel(label).apiName
            }
        expect(holders.none { it.text("displayName") == name.trim() }) { "$name は ${label}に割り当てられたまま" }
    }

    /**
     * 「小売店から二次卸へ移したことが示される」。API は、移した旨を明示するフィールドや文を返さない（応答は versions だけ）。
     * そのため、観測できる範囲で、割り当ての前後の差（移動元の役割 → 移動先の役割）と、割り当ての成功（200）を確かめる。
     * 明示の通知がないことは、Step 11 の結果に未決として記録する。
     */
    @Then("{}から{}へ移したことが示される")
    fun moveIsShown(
        fromLabel: String,
        toLabel: String,
    ) {
        val response = ctx.response()
        expect(response.status == ScenarioContext.HTTP_OK) { "割り当てが成功していない: ${response.status} ${response.text}" }
        val participant = ctx.game.participants.first { it.role == Role.ofLabel(toLabel.trim()) }
        val after =
            ctx.api
                .lobby(ctx.game.id, ctx.game.facilitator)
                .json
                .roleOf(participant.name)
        expect(
            roleBeforeMove == Role.ofLabel(fromLabel.trim()).apiName && after == Role.ofLabel(toLabel.trim()).apiName,
        ) {
            "移動の前後が $fromLabel → $toLabel ではない: $roleBeforeMove → $after"
        }
    }

    private fun JsonObject.roleOf(name: String): String? =
        array("participants")
            .map { it.jsonObject }
            .first { it.text("displayName") == name }["role"]
            ?.takeIf { it !is JsonNull }
            ?.jsonPrimitive
            ?.content

    // ステップ定義のクラスはシナリオごとに作られるため、シナリオ内で受け渡す値はインスタンスに持つ。
    private var createKey: String? = null
    private var joinedName: String? = null
    private var roleBeforeMove: String? = null
}
