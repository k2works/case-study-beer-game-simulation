package beergame.acceptance

import io.cucumber.java.en.Given
import io.cucumber.java.en.Then
import io.cucumber.java.en.When
import kotlinx.serialization.json.jsonObject
import java.util.UUID

private const val HTTP_OK = 200
private const val HTTP_FORBIDDEN = 403
private const val ROLE_COUNT = 4
private const val DEFAULT_QUANTITY = 4
private const val OBSERVER_WEEK = 1

/** 発行した観察用の招待（ID と、発行の応答だけが運ぶ招待コード）。 */
private class Invitation(
    val id: String,
    val code: String,
)

/** 観察者（US1.3・US4.1）のステップ定義。薄く保つ。 */
class ObserverSteps {
    private val ctx get() = Scenario.current
    private var invitation: Invitation? = null
    private var observerCookie: String? = null

    // ---- 観察用の招待（US1.3） ----

    @Given("進行役が観察用の招待を発行している")
    fun invitationIssued() {
        invite(ctx.game.facilitator)
        val response = ctx.response()
        expect(response.status == HTTP_OK) { "招待を発行できない: ${response.status} ${response.text}" }
    }

    @When("進行役が観察用の招待を求める")
    fun facilitatorInvites() = invite(ctx.game.facilitator)

    @When("{word}の参加者が観察用の招待を求める")
    fun participantInvites(label: String) = invite(ctx.game.playerOf(Role.ofLabel(label)).cookie)

    @When("資格の無い人が観察用の招待を求める")
    fun anonymousInvites() = invite(null)

    @When("観察者が、観察用の招待を求める")
    fun observerInvites() = invite(observerCookie)

    @Given("進行役が、その観察用の招待を失効させている")
    fun invitationRevoked() {
        revoke(ctx.game.facilitator)
        expect(ctx.response().status == HTTP_OK) { "失効できない: ${ctx.response().status} ${ctx.response().text}" }
    }

    @When("{word}の参加者が、その観察用の招待を失効させようとする")
    fun participantRevokes(label: String) = revoke(ctx.game.playerOf(Role.ofLabel(label)).cookie)

    @When("招待コードを参加コードとして使って、参加者が参加しようとする")
    fun inviteCodeAsJoinCode() {
        ctx.last = ctx.api.join(checkNotNull(invitation).code, "紛れ込み")
    }

    @When("観察者「{}」が、招待コードで参加しようとする")
    fun observerTriesToJoin(name: String) = join(name)

    @When("観察者「{}」が、招待コードで参加する")
    fun observerJoins(name: String) = join(name)

    @Given("観察者「{}」が、招待コードで参加している")
    fun observerHasJoined(name: String) {
        join(name)
        val response = ctx.response()
        expect(response.status == HTTP_OK && observerCookie != null) {
            "観察者として参加できない: ${response.status} ${response.text}"
        }
    }

    @Then("観察用の招待コードが発行される")
    fun codeIssued() {
        val response = ctx.response()
        expect(response.status == HTTP_OK) { "発行されていない: ${response.status} ${response.text}" }
        expect(response.json.text("invitationCode").isNotBlank()) { "招待コードが無い: ${response.text}" }
    }

    @Then("招待コードは参加コードと異なる")
    fun codeDiffersFromJoinCode() {
        val code = ctx.response().json.text("invitationCode")
        expect(code != ctx.game.joinCode) { "招待コードが参加コードと同じ" }
    }

    @Then("招待コードは含まれない")
    fun noInvitationCode() {
        expect("invitationCode" !in ctx.response().text) { "招待コードが含まれている: ${ctx.response().text}" }
    }

    @Then("招待が無効という理由で拒否される")
    fun invitationInvalid() {
        val response = ctx.response()
        expect(response.status == HTTP_FORBIDDEN && response.code() == "game.invitation_invalid") {
            "招待が無効という拒否ではない: ${response.status} ${response.text}"
        }
        expect(response.credential() == null) { "拒否されたのに資格が発行されている" }
    }

    @Then("観察者として参加できる")
    fun joinedAsObserver() {
        val response = ctx.response()
        expect(response.status == HTTP_OK) { "参加できていない: ${response.status} ${response.text}" }
        expect(response.json.text("kind") == "OBSERVER") { "観察者の種別ではない: ${response.text}" }
        expect(response.recoveryCredential() == null) { "観察者に復帰資格が発行されている" }
    }

    @Then("進行役のロビーに、観察者「{}」が役割なしで載る")
    fun lobbyHasObserver(name: String) {
        val lobby = ctx.api.lobby(ctx.game.id, ctx.game.facilitator)
        expect(lobby.status == HTTP_OK) { "ロビーを取得できない: ${lobby.status} ${lobby.text}" }
        val entry =
            lobby.json
                .array("observers")
                .map { it.jsonObject }
                .firstOrNull { it.text("displayName") == name }
        expect(entry != null) { "ロビーに観察者が載っていない: ${lobby.text}" }
        expect(checkNotNull(entry).keys.none { it == "role" }) { "観察者が役割を持っている: $entry" }
    }

    @Then("参加者の一覧に、観察者は含まれない")
    fun participantsExcludeObserver() {
        val lobby = ctx.api.lobby(ctx.game.id, ctx.game.facilitator)
        val names = lobby.json.array("participants").map { it.jsonObject.text("displayName") }
        expect(names.size == ROLE_COUNT) { "参加者が ${ROLE_COUNT} 人ではない: $names" }
    }

    // ---- 観察画面（US4.1） ----

    @When("観察者が観察画面を開く")
    fun observerOpensObservation() = observation(observerCookie)

    @When("進行役が観察画面を開く")
    fun facilitatorOpensObservation() = observation(ctx.game.facilitator)

    @When("資格の無い人が観察画面を開こうとする")
    fun anonymousOpensObservation() = observation(null)

    @When("{word}の参加者が観察画面を開こうとする")
    fun participantOpensObservation(label: String) = observation(ctx.game.playerOf(Role.ofLabel(label)).cookie)

    @Given("{word}と{word}の参加者が、第 {int} 週の入力を保存している")
    fun twoRolesSaved(
        first: String,
        second: String,
        week: Int,
    ) {
        listOf(first, second).forEach { label ->
            val saved =
                ctx.api.saveDecision(
                    ctx.game.id,
                    week,
                    "$DEFAULT_QUANTITY",
                    ctx.game.playerOf(Role.ofLabel(label)).cookie,
                )
            expect(saved.status == HTTP_OK) { "保存できない: ${saved.status} ${saved.text}" }
        }
    }

    @Then("観察画面の内容が返る")
    fun observationReturned() {
        val response = ctx.response()
        expect(response.status == HTTP_OK && response.json.containsKey("totals")) {
            "観察画面の内容ではない: ${response.status} ${response.text}"
        }
    }

    @Then("観察画面の現在週は {int} である")
    fun currentWeekIs(week: Int) =
        expect(ctx.response().json.number("week") == week) { "現在週が違う: ${ctx.response().text}" }

    @Then("観察画面の入力済みの役割数は {int} である")
    fun submittedCountIs(count: Int) =
        expect(ctx.response().json.number("submittedRoleCount") == count) { "入力済みの役割数が違う: ${ctx.response().text}" }

    @Then("観察画面に、第 {int} 週のチーム合計として、注文 {int}・在庫・受注残が含まれる")
    fun totalsOfWeek(
        week: Int,
        order: Int,
    ) {
        val weeks =
            ctx
                .response()
                .json
                .obj("totals")
                .array("weeks")
                .map { it.jsonObject }
        val entry = weeks.firstOrNull { it.number("week") == week }
        expect(entry != null) { "第 $week 週の合計が無い: ${ctx.response().text}" }
        val total = checkNotNull(entry)
        expect(total.number("order") == order) { "注文の合計が $order ではない: $total" }
        expect(total.number("inventory") >= 0 && total.number("backlog") >= 0) { "在庫・受注残が無い: $total" }
    }

    @Then("観察画面に、役割別の項目は含まれない")
    fun noRoleSpecificValues() {
        val text = ctx.response().text
        val leaked =
            Role.entries.filter { it.apiName in text }.map { it.apiName } +
                listOf("roles", "roleStatus", "results").filter { "\"$it\"" in text }
        expect(leaked.isEmpty()) { "役割別の項目が含まれている: $leaked" }
    }

    @Then("観察画面にチーム合計は含まれず、公開されていないという理由が示される")
    fun totalsNotDisclosed() {
        val totals = ctx.response().json.obj("totals")
        expect(totals.array("weeks").isEmpty()) { "合計が含まれている: $totals" }
        expect(totals.text("hiddenReason") == "DISCLOSURE_NONE") { "理由が示されていない: $totals" }
    }

    // ---- 観察者の権限（AC4.1.2・AC4.1.5） ----

    @When("観察者が、{word}の状況を取得しようとする")
    fun observerFetchesRole(label: String) {
        ctx.last = ctx.api.sessionState(ctx.game.id, observerCookie, Role.ofLabel(label))
    }

    @When("観察者が、ゲームの状態を取得しようとする")
    fun observerFetchesGameState() {
        ctx.last = ctx.api.gameState(ctx.game.id, observerCookie)
    }

    @When("観察者が、ロビーを取得しようとする")
    fun observerFetchesLobby() {
        ctx.last = ctx.api.lobby(ctx.game.id, observerCookie)
    }

    @When("観察者が、{word}の入力として {int} を保存しようとする")
    fun observerSaves(
        label: String,
        quantity: Int,
    ) {
        expect(Role.ofLabel(label) in Role.entries) { "知らない役割: $label" }
        ctx.last = ctx.api.saveDecision(ctx.game.id, OBSERVER_WEEK, "$quantity", observerCookie)
    }

    @When("観察者が、第 {int} 週を確定しようとする")
    fun observerCommits(week: Int) {
        val body = ctx.api.commitBody(week, ctx.basisOf(ctx.game))
        ctx.last = ctx.api.commitWeek(ctx.game.id, week, body, observerCookie)
    }

    @When("観察者が、ゲームを一時停止しようとする")
    fun observerPauses() {
        ctx.last = ctx.api.pause(ctx.game.id, observerCookie)
    }

    @When("観察者が、{word}の参加者の資格を失効させようとする")
    fun observerRevokesCredential(label: String) {
        val target = ctx.game.playerOf(Role.ofLabel(label))
        ctx.last = ctx.api.revokeCredential(ctx.game.id, target.participantId, observerCookie)
    }

    @When("観察者が、自分に{word}の役割を割り当てようとする")
    fun observerAssignsSelf(label: String) {
        ctx.last = ctx.api.assignRole(ctx.game.id, UUID.randomUUID().toString(), Role.ofLabel(label), observerCookie)
    }

    @When("観察者が振り返りを取得する")
    fun observerFetchesReview() {
        ctx.last = ctx.api.review(ctx.game.id, observerCookie)
        expect(ctx.response().status == HTTP_OK) { "取得できない: ${ctx.response().status} ${ctx.response().text}" }
    }

    @When("観察者が振り返りを取得しようとする")
    fun observerTriesToFetchReview() {
        ctx.last = ctx.api.review(ctx.game.id, observerCookie)
    }

    @Then("将来の需要は含まれない")
    fun noFutureDemand() {
        val text = ctx.response().text
        val leaked = FUTURE_DEMANDS.filter { Regex("\\b$it\\b").containsMatchIn(text) }
        expect(leaked.isEmpty()) { "将来の需要が含まれている: $leaked" }
    }

    @Then("参加コードは含まれない")
    fun noJoinCode() {
        expect(ctx.game.joinCode !in ctx.response().text) { "参加コードが含まれている" }
    }

    private fun invite(cookie: String?) {
        val response = ctx.api.inviteObserver(ctx.game.id, cookie)
        ctx.last = response
        if (response.status == HTTP_OK) {
            invitation = Invitation(response.json.text("invitationId"), response.json.text("invitationCode"))
        }
    }

    private fun revoke(cookie: String?) {
        ctx.last = ctx.api.revokeInvitation(ctx.game.id, checkNotNull(invitation).id, cookie)
    }

    private fun join(name: String) {
        val response = ctx.api.observe(checkNotNull(invitation).code, name)
        ctx.last = response
        if (response.status == HTTP_OK) observerCookie = response.credential()
    }

    private fun observation(cookie: String?) {
        ctx.last = ctx.api.observation(ctx.game.id, cookie)
    }
}
