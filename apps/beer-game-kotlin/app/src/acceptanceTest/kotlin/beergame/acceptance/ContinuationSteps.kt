package beergame.acceptance

import io.cucumber.java.en.Given
import io.cucumber.java.en.Then
import io.cucumber.java.en.When
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.time.Duration
import java.time.Instant
import java.time.OffsetDateTime
import java.util.UUID

private const val HTTP_OK = 200
private const val HTTP_FORBIDDEN = 403
private const val HTTP_CONFLICT = 409
private const val RECENT_MINUTES = 5L
private const val OVER_LIMIT_QUANTITY = 100

/** 以前に成功した保存の要求（同じキーで再送するために持つ）。 */
private class SentSave(
    val player: Participant,
    val week: Int,
    val quantity: Int,
    val version: Int,
    val key: String,
)

/** 以前に成功した復帰の要求。 */
private class SentRecovery(
    val player: Participant,
    val key: String,
)

/**
 * 継続と資格のステップ定義（US3.1、US3.2。B5）。薄く保ち、HTTP を呼んで、期待値を確かめるだけ。
 * 経路・code は contracts/openapi.yaml の提案（ゲート 1 で人が決める）。実装が無い間は、404 などの違いで失敗する（Red）。
 */
class ContinuationSteps {
    private val ctx get() = Scenario.current

    private var lastRecovered: Participant? = null
    private var lastWasRecovery = false
    private var sentSave: SentSave? = null
    private var sentRecovery: SentRecovery? = null
    private var staleVersion: Int = 0
    private var replaced: Participant? = null
    private val reissuedCodes = mutableMapOf<String, String>()

    private fun player(label: String): Participant = ctx.game.playerOf(Role.ofLabel(label))

    private fun facilitatorState(): JsonObject = ctx.sessionState(ctx.game).json

    private fun currentWeek(): Int = facilitatorState().number("week")

    private fun versionOf(role: Role): Int = facilitatorState().obj("roles").obj(role.apiName).number("decisionVersion")

    private fun decisionOf(role: Role): String? =
        facilitatorState()
            .obj("roles")
            .obj(role.apiName)["decision"]
            ?.jsonPrimitive
            ?.content
            ?.takeIf { it != "null" }

    private fun save(
        who: Participant,
        week: Int,
        quantity: Int,
    ): ApiResponse {
        val version = versionOf(checkNotNull(who.role))
        return ctx.api.saveDecisionAt(ctx.game.id, week, quantity, version, who.cookie)
    }

    private fun JsonObject.roleDecision(): String? =
        obj("roleStatus")["decision"]
            ?.jsonPrimitive
            ?.content

    private fun proxy(
        label: String,
        week: Int,
        quantity: Int,
        cookie: String?,
    ): ApiResponse = ctx.api.proxyDecision(ctx.game.id, Role.ofLabel(label), week, quantity, cookie)

    private fun problemIs(
        status: Int,
        code: String,
    ) {
        val response = ctx.response()
        expect(response.status == status && response.code() == code) {
            "$code（$status）ではない: ${response.status} ${response.text}"
        }
    }

    private fun okOrFail(
        response: ApiResponse,
        what: String,
    ) = expect(response.status == HTTP_OK) { "$what: ${response.status} ${response.text}" }

    // ---- 停止・再開（US3.1） ----

    @Given("進行役がセッションを一時停止している")
    fun facilitatorHasPaused() = okOrFail(ctx.api.pause(ctx.game.id, ctx.game.facilitator), "一時停止できない")

    @When("進行役がセッションを一時停止する")
    fun facilitatorPauses() {
        ctx.last = ctx.api.pause(ctx.game.id, ctx.game.facilitator)
        okOrFail(ctx.response(), "一時停止できない")
    }

    @When("{word}の参加者が、セッションを一時停止しようとする")
    fun participantTriesToPause(label: String) {
        ctx.last = ctx.api.pause(ctx.game.id, player(label).cookie)
    }

    @Given("進行役がセッションを再開している")
    fun facilitatorHasResumed() = okOrFail(ctx.api.resume(ctx.game.id, ctx.game.facilitator), "再開できない")

    @When("進行役がセッションを再開する")
    fun facilitatorResumes() {
        ctx.last = ctx.api.resume(ctx.game.id, ctx.game.facilitator)
        okOrFail(ctx.response(), "再開できない")
    }

    @Then("停止中であるという理由で拒否される")
    fun rejectedBecausePaused() = problemIs(HTTP_CONFLICT, "session.paused")

    @Then("セッションの状態は進行中である")
    fun sessionIsActive() = sessionStatusIs("ACTIVE")

    @Then("セッションの状態は停止中である")
    fun sessionIsPaused() = sessionStatusIs("PAUSED")

    private fun sessionStatusIs(expected: String) {
        val state = ctx.sessionState(ctx.game)
        expect(state.status == HTTP_OK && state.json.text("status") == expected) {
            "状態が $expected ではない: ${state.status} ${state.text}"
        }
    }

    @Then("当週の{word}の入力は {int} のまま残っている")
    fun decisionRemains(
        label: String,
        quantity: Int,
    ) {
        val stored = decisionOf(Role.ofLabel(label))
        expect(stored == quantity.toString()) { "${label}の入力は $quantity のはずが: $stored" }
    }

    @Then("当週の{word}の入力は保存されていない")
    fun decisionIsAbsent(label: String) {
        val stored = decisionOf(Role.ofLabel(label))
        expect(stored == null) { "${label}の入力が保存されている: $stored" }
    }

    @Given("{word}の参加者が、第 {int} 週の数量として {int} を保存している")
    fun participantHasSavedInWeek(
        label: String,
        week: Int,
        quantity: Int,
    ) = okOrFail(save(player(label), week, quantity), "保存できない")

    @Then("{word}の参加者が、第 {int} 週の数量として {int} を保存できる")
    fun participantCanSaveInWeek(
        label: String,
        week: Int,
        quantity: Int,
    ) = okOrFail(save(player(label), week, quantity), "保存できない")

    // ---- 代理入力（AC3.1.2） ----

    @When("進行役が、{word}の代理入力として {int} を入力する")
    fun facilitatorSubmitsProxy(
        label: String,
        quantity: Int,
    ) {
        ctx.last = proxy(label, currentWeek(), quantity, ctx.game.facilitator)
    }

    @Given("進行役が、{word}の代理入力として {int} を入力している")
    fun facilitatorHasSubmittedProxy(
        label: String,
        quantity: Int,
    ) = okOrFail(proxy(label, currentWeek(), quantity, ctx.game.facilitator), "代理入力できない")

    @When("{word}の参加者が、{word}の代理入力として {int} を入力しようとする")
    fun participantTriesProxy(
        actor: String,
        label: String,
        quantity: Int,
    ) {
        ctx.last = proxy(label, currentWeek(), quantity, player(actor).cookie)
    }

    @When("進行役が、第 {int} 週の画面を見たまま、{word}の代理入力として {int} を入力しようとする")
    fun facilitatorSubmitsStaleProxy(
        week: Int,
        label: String,
        quantity: Int,
    ) {
        ctx.last = proxy(label, week, quantity, ctx.game.facilitator)
    }

    @Then("{word}の代理入力 {int} が受け付けられる")
    fun proxyAccepted(
        label: String,
        quantity: Int,
    ) {
        okOrFail(ctx.response(), "代理入力が受け付けられていない")
        val stored = decisionOf(Role.ofLabel(label))
        expect(stored == quantity.toString()) { "${label}の入力は $quantity のはずが: $stored" }
    }

    @Then("第 {int} 週の結果はまだ記録されていない")
    fun weekResultNotRecorded(week: Int) {
        val results = facilitatorState().array("results").map { it.jsonObject }
        expect(results.none { it.number("week") == week }) { "第 $week 週の結果が記録されている: $results" }
    }

    @Then("第 {int} 週はすでに確定されているという理由で、代理入力は拒否される")
    fun proxyRejectedAsAdvanced(week: Int) {
        problemIs(HTTP_CONFLICT, "session.week_advanced")
        val json = ctx.response().json
        val requested = json["requestedWeek"]?.jsonPrimitive?.content
        expect(requested == week.toString()) { "要求した週が $week ではない: $requested" }
    }

    @Then("監査履歴に、操作者が進行役、役割が{word}、値が {int} の代理入力が残っている")
    fun auditTrailHasProxy(
        label: String,
        quantity: Int,
    ) {
        val row = checkNotNull(proxyRow()) { "監査履歴に代理入力（ProxyDecisionSubmitted）が無い" }
        val payload = Json.parseToJsonElement(row.payload).jsonObject
        expect(row.actorKind == "FACILITATOR") { "操作者が進行役ではない: ${row.actorKind}" }
        expect(payload["role"]?.jsonPrimitive?.content == Role.ofLabel(label).apiName) { "役割が違う: $payload" }
        expect(payload["quantity"]?.jsonPrimitive?.content == quantity.toString()) { "値が残っていない: $payload" }
    }

    @Then("その代理入力の時刻が記録されている")
    fun proxyTimeRecorded() {
        val row = checkNotNull(proxyRow()) { "監査履歴に代理入力が無い" }
        val age = Duration.between(row.occurredAt.toInstant(), Instant.now())
        expect(!age.isNegative && age.toMinutes() < RECENT_MINUTES) { "時刻が記録されていない、または古い: ${row.occurredAt}" }
    }

    private fun proxyRow(): AuditRow? =
        ctx.app
            .auditTrail(ctx.game.id)
            .lastOrNull { it.eventType == "ProxyDecisionSubmitted" }

    // ---- 保存回数の上限（NF-C8） ----

    @Given("{word}の参加者が、当週の数量を {int} 回保存している")
    fun participantHasSavedManyTimes(
        label: String,
        times: Int,
    ) {
        val who = player(label)
        for (quantity in 1..times) {
            okOrFail(save(who, currentWeek(), quantity), "$quantity 回目の保存ができない")
        }
    }

    @When("{word}の参加者が、当週の数量をもう 1 回保存しようとする")
    fun participantTriesOneMoreSave(label: String) {
        ctx.last = save(player(label), currentWeek(), OVER_LIMIT_QUANTITY)
    }

    @Then("保存回数の上限に達しているという理由で拒否される")
    fun rejectedBySaveLimit() = problemIs(HTTP_CONFLICT, "session.save_limit_reached")

    // ---- 復帰（US3.2） ----

    @Given("{word}の参加者のブラウザセッションが失われている")
    fun participantLostBrowserSession(label: String) {
        // ブラウザの資格（bg_session）は使わない。復帰は、以降のステップが復帰資格だけで行う。
        expect(player(label).cookie.isNotBlank()) { "参加者の資格が無い" }
    }

    @Given("進行役のブラウザセッションが失われている")
    fun facilitatorLostBrowserSession() = Unit

    @Given("進行役のブラウザセッションと復帰資格が失われている")
    fun facilitatorLostEverything() = Unit

    private fun recoverAs(
        who: Participant,
        key: String = ctx.api.newKey(),
    ): ApiResponse {
        lastWasRecovery = true
        lastRecovered = who
        val response = ctx.api.recover(ctx.game.id, recovery = who.recovery, key = key)
        if (response.status == HTTP_OK) response.credential()?.let { who.cookie = it }
        return response
    }

    @When("{word}の参加者が、復帰資格で再接続する")
    fun participantRecovers(label: String) {
        ctx.last = recoverAs(player(label))
        okOrFail(ctx.response(), "復帰できない")
    }

    @Given("{word}の参加者が、復帰資格で再接続している")
    fun participantHasRecovered(label: String) = participantRecovers(label)

    @When("{word}の参加者が、復帰資格で再接続しようとする")
    fun participantTriesToRecover(label: String) {
        ctx.last = recoverAs(player(label))
    }

    @Then("同じゲームの{word}として復帰する")
    fun recoveredAsRole(label: String) {
        val response = ctx.response()
        okOrFail(response, "復帰できていない")
        expect(response.json.text("gameId") == ctx.game.id) { "別のゲームに復帰した: ${response.text}" }
        val cookie = checkNotNull(response.credential()) { "新しいブラウザセッションが発行されていない" }
        val state = ctx.api.gameState(ctx.game.id, cookie)
        val who = checkNotNull(lastRecovered)
        expect(state.status == HTTP_OK && state.json.text("role") == Role.ofLabel(label).apiName) {
            "役割が $label ではない: ${state.status} ${state.text}"
        }
        expect(state.json.text("participantId") == who.participantId) { "別の参加者として復帰した: ${state.text}" }
    }

    @Then("最新の状況に、保存済みの入力 {int} が含まれる")
    fun latestStateHasDecision(quantity: Int) {
        val cookie = checkNotNull(lastRecovered).cookie
        val state = ctx.sessionState(ctx.game, cookie)
        val stored = state.json.roleDecision()
        expect(state.status == HTTP_OK && stored == quantity.toString()) {
            "最新の状況に入力 $quantity が無い: ${state.status} ${state.text}"
        }
    }

    @Given("{word}の参加者の復帰資格が「{}」になっている")
    fun recoveryCredentialIs(
        label: String,
        state: String,
    ) {
        val who = player(label)
        when (state) {
            "不明" -> {
                who.recovery = "unknown-${UUID.randomUUID()}"
            }

            "失効" -> {
                okOrFail(ctx.api.revokeCredential(ctx.game.id, who.participantId, ctx.game.facilitator), "失効できない")
            }

            "期限切れ" -> {
                ctx.app.expire(ExpirableTable.CREDENTIALS, ctx.game.id, who.participantId)
            }

            else -> {
                throw AssertionError("知らない状態: $state")
            }
        }
    }

    @Then("復帰は拒否される")
    fun recoveryRejected() {
        val response = ctx.response()
        expect(response.status == HTTP_FORBIDDEN && response.code() == "app.unauthorized") {
            "復帰が権限エラーで拒否されていない: ${response.status} ${response.text}"
        }
    }

    @Then("拒否の応答は、不明な復帰資格のときと同じである")
    fun rejectionIsIndistinguishable() {
        val actual = ctx.response()
        val unknown = ctx.api.recover(ctx.game.id, recovery = "unknown-${UUID.randomUUID()}")
        expect(actual.status == unknown.status) { "状態が不明な資格と違う: ${actual.status} と ${unknown.status}" }
        listOf("type", "title", "status", "detail", "code").forEach {
            expect(actual.json[it] == unknown.json[it]) { "$it が不明な資格と違う: ${actual.text} と ${unknown.text}" }
        }
    }

    @Then("新しいブラウザセッションは発行されない")
    fun noNewBrowserSession() = expect(ctx.response().credential() == null) { "新しいブラウザセッションが発行された" }

    // ---- 複数のタブ（AC3.2.3） ----

    @Given("{word}の参加者が、2 つのタブで第 {int} 週の画面を開いている")
    fun participantOpenedTwoTabs(
        label: String,
        week: Int,
    ) {
        expect(currentWeek() == week) { "第 $week 週ではない: ${currentWeek()}" }
        staleVersion = versionOf(Role.ofLabel(label))
    }

    @When("{word}の参加者の古いタブが、第 {int} 週の数量として {int} を保存しようとする")
    fun staleTabSaves(
        label: String,
        week: Int,
        quantity: Int,
    ) {
        ctx.last = ctx.api.saveDecisionAt(ctx.game.id, week, quantity, staleVersion, player(label).cookie)
    }

    @Then("古いタブの保存は、第 {int} 週はすでに確定されているという理由で拒否される")
    fun staleTabRejected(week: Int) {
        problemIs(HTTP_CONFLICT, "session.week_advanced")
        val json = ctx.response().json
        expect(json["requestedWeek"]?.jsonPrimitive?.content == week.toString()) {
            "要求した週が違う: ${ctx.response().text}"
        }
        expect(json["currentWeek"]?.jsonPrimitive?.content == (week + 1).toString()) {
            "現在の週が違う: ${ctx.response().text}"
        }
    }

    @Then("{word}の参加者のもう一方のタブは、最新の状況として第 {int} 週を表示する")
    fun otherTabShowsLatest(
        label: String,
        week: Int,
    ) {
        val state = ctx.sessionState(ctx.game, player(label).cookie)
        expect(state.status == HTTP_OK && state.json.number("week") == week) {
            "最新の状況が第 $week 週ではない: ${state.status} ${state.text}"
        }
        expect(state.json.roleDecision() == "null") {
            "古い入力が残っている: ${state.text}"
        }
    }

    // ---- 進行役の復帰（AC3.2.4） ----

    @When("進行役が、画面を再読み込みする")
    fun facilitatorReloads() {
        lastWasRecovery = false
        ctx.last = ctx.api.gameState(ctx.game.id, ctx.game.facilitator)
    }

    @When("進行役が、復帰資格で再接続する")
    fun facilitatorRecovers() {
        lastWasRecovery = true
        ctx.last = ctx.api.recover(ctx.game.id, recovery = ctx.game.recovery)
    }

    @When("進行役が、作成時に控えた復帰コードで再接続する")
    fun facilitatorRecoversWithCode() {
        lastWasRecovery = true
        ctx.last = ctx.api.recover(ctx.game.id, recoveryCode = ctx.game.recoveryCode)
    }

    @Then("同じゲームの進行コンソールが表示される")
    fun consoleIsShown() {
        val response = ctx.response()
        okOrFail(response, "進行コンソールに戻れない")
        val cookie =
            if (lastWasRecovery) {
                expect(response.json.text("gameId") == ctx.game.id) { "別のゲームに復帰した: ${response.text}" }
                checkNotNull(response.credential()) { "新しいブラウザセッションが発行されていない" }
            } else {
                ctx.game.facilitator
            }
        val state = ctx.api.gameState(ctx.game.id, cookie)
        expect(state.status == HTTP_OK && state.json.text("joinCode") == ctx.game.joinCode) {
            "進行役の状態を取得できない: ${state.status} ${state.text}"
        }
        expect(ctx.sessionState(ctx.game, cookie).status == HTTP_OK) { "進行コンソールの状態を取得できない" }
    }

    // ---- 参加の応答（ゲームの ID。判断項目 7） ----

    @Then("応答に、参加したゲームの ID が含まれる")
    fun responseHasGameId() {
        val response = ctx.response()
        expect(response.status == HTTP_OK && response.json.text("gameId") == ctx.game.id) {
            "参加の応答にゲームの ID が無い: ${response.status} ${response.text}"
        }
    }

    // ---- 失効・再発行（AC3.2.5） ----

    @When("進行役が、{word}の参加者の資格を失効させる")
    fun facilitatorRevokes(label: String) {
        ctx.last = ctx.api.revokeCredential(ctx.game.id, player(label).participantId, ctx.game.facilitator)
    }

    @Given("進行役が、{word}の参加者の資格を失効させている")
    fun facilitatorHasRevoked(label: String) {
        val response = ctx.api.revokeCredential(ctx.game.id, player(label).participantId, ctx.game.facilitator)
        okOrFail(response, "失効できない")
    }

    @When("進行役が、{word}の参加者の資格を失効させようとする")
    fun facilitatorTriesToRevoke(label: String) = facilitatorRevokes(label)

    @When("{word}の参加者が、{word}の参加者の資格を失効させようとする")
    fun participantTriesToRevoke(
        actor: String,
        target: String,
    ) {
        ctx.last = ctx.api.revokeCredential(ctx.game.id, player(target).participantId, player(actor).cookie)
    }

    @Given("別のゲームの進行役がいる")
    fun anotherGameFacilitatorExists() {
        val response = ctx.createGame()
        expect(response.status == ScenarioContext.HTTP_CREATED) {
            "別のゲームを作成できない: ${response.status} ${response.text}"
        }
    }

    @When("別のゲームの進行役が、{word}の参加者の資格を失効させようとする")
    fun otherFacilitatorTriesToRevoke(label: String) {
        ctx.last = ctx.api.revokeCredential(ctx.game.id, player(label).participantId, ctx.games.last().facilitator)
    }

    @Then("失効が受け付けられる")
    fun revokeAccepted() = okOrFail(ctx.response(), "失効が受け付けられていない")

    @Then("資格はすでに失効しているという理由で拒否される")
    fun rejectedAsAlreadyRevoked() = problemIs(HTTP_CONFLICT, "game.credential_already_revoked")

    @Then("{word}の参加者は、復帰資格で復帰できない")
    fun participantCannotRecover(label: String) = cannotRecover(player(label))

    @Then("{word}の参加者は、失効した古い復帰資格では復帰できない")
    fun participantCannotRecoverWithOld(label: String) = cannotRecover(player(label))

    private fun cannotRecover(who: Participant) {
        val response = ctx.api.recover(ctx.game.id, recovery = who.recovery)
        expect(response.status == HTTP_FORBIDDEN && response.code() == "app.unauthorized") {
            "復帰できてしまう、または権限エラーではない: ${response.status} ${response.text}"
        }
        expect(response.credential() == null) { "復帰を拒否したのに、ブラウザセッションが発行された" }
    }

    @Then("{word}の参加者は、以前のブラウザセッションでも状況を取得できない")
    fun participantCannotUseOldSession(label: String) {
        val response = ctx.api.gameState(ctx.game.id, player(label).cookie)
        expect(response.status == HTTP_FORBIDDEN && response.code() == "app.unauthorized") {
            "以前のブラウザセッションが使えてしまう: ${response.status} ${response.text}"
        }
    }

    @Then("{word}の参加者の資格には影響しない")
    fun otherParticipantUnaffected(label: String) = participantCredentialRemains(label)

    @Then("{word}の参加者の資格は有効なままである")
    fun participantCredentialRemains(label: String) {
        okOrFail(ctx.api.gameState(ctx.game.id, player(label).cookie), "資格が使えない")
    }

    @When("進行役が、{word}の参加者の資格を再発行する")
    fun facilitatorReissues(label: String) {
        val who = player(label)
        val response = ctx.api.reissueCredential(ctx.game.id, who.participantId, ctx.game.facilitator)
        ctx.last = response
        val code = if (response.status == HTTP_OK) response.json["recoveryCode"]?.jsonPrimitive?.content else null
        if (code != null) reissuedCodes[who.participantId] = code
    }

    @Given("進行役が、{word}の参加者の資格を再発行している")
    fun facilitatorHasReissued(label: String) {
        facilitatorReissues(label)
        okOrFail(ctx.response(), "再発行できない")
    }

    @Then("再発行が受け付けられる")
    fun reissueAccepted() = okOrFail(ctx.response(), "再発行が受け付けられていない")

    @Then("新しい復帰コードと、現在より後の有効期限が示される")
    fun newCodeAndExpiryShown() {
        val json = ctx.response().json
        expect(json.text("recoveryCode").isNotBlank()) { "復帰コードが無い: ${ctx.response().text}" }
        val expiresAt = OffsetDateTime.parse(json.text("expiresAt")).toInstant()
        expect(expiresAt.isAfter(Instant.now())) { "有効期限が現在より後ではない: $expiresAt" }
    }

    @When("{word}の参加者が、新しい復帰コードで復帰する")
    fun participantRecoversWithNewCode(label: String) {
        val who = player(label)
        lastWasRecovery = true
        lastRecovered = who
        ctx.last = ctx.api.recover(ctx.game.id, recoveryCode = reissuedCodes[who.participantId])
        okOrFail(ctx.response(), "復帰できない")
    }

    @Then("{word}の参加者は、新しい復帰コードで同じゲームの{word}として復帰できる")
    fun participantCanRecoverWithNewCode(
        label: String,
        role: String,
    ) {
        participantRecoversWithNewCode(label)
        recoveredAsRole(role)
    }

    @Given("ゲームは「{}」である")
    fun gameIsInPhase(phase: String) {
        when (phase) {
            "準備中" -> {
                expect(ctx.game.joinCode.isNotBlank()) { "準備中のゲームに参加コードが無い" }
            }

            "開始後" -> {
                okOrFail(ctx.start(ctx.game), "開始できない")
            }

            else -> {
                throw AssertionError("知らない局面: $phase")
            }
        }
    }

    // ---- 期限切れ ----

    @Given("{word}の参加者のブラウザセッションの有効期限が切れている")
    fun browserSessionExpired(label: String) =
        ctx.app.expire(ExpirableTable.BROWSER_SESSIONS, ctx.game.id, player(label).participantId)

    @When("{word}の参加者が、期限が切れた資格で状況を取得しようとする")
    fun participantTriesToGetOwnState(label: String) {
        ctx.last = ctx.api.gameState(ctx.game.id, player(label).cookie)
    }

    // ---- 失効後の再送（ADR-004） ----

    @Given("{word}の参加者が、冪等キー付きで第 {int} 週の数量 {int} を保存している")
    fun participantSavedWithKey(
        label: String,
        week: Int,
        quantity: Int,
    ) {
        val who = player(label)
        val sent = SentSave(who, week, quantity, versionOf(checkNotNull(who.role)), ctx.api.newKey())
        val response = ctx.api.saveDecisionAt(ctx.game.id, week, quantity, sent.version, who.cookie, sent.key)
        okOrFail(response, "保存できない")
        sentSave = sent
    }

    @When("{word}の参加者が、以前に成功した保存の要求を、同じキーでもう一度送る")
    fun participantResendsSave(label: String) {
        val sent = checkNotNull(sentSave) { "以前の保存の要求がない（$label）" }
        ctx.last =
            ctx.api.saveDecisionAt(ctx.game.id, sent.week, sent.quantity, sent.version, sent.player.cookie, sent.key)
    }

    @Then("保存済みの応答は返らない")
    fun storedResponseIsNotReturned() =
        expect("versions" !in ctx.response().text) { "保存済みの応答が返った: ${ctx.response().text}" }

    @Given("{word}の参加者が、冪等キー付きで復帰資格で再接続している")
    fun participantRecoveredWithKey(label: String) {
        val who = player(label)
        val sent = SentRecovery(who, ctx.api.newKey())
        okOrFail(recoverAs(who, sent.key), "復帰できない")
        sentRecovery = sent
    }

    @When("{word}の参加者が、以前に成功した復帰の要求を、同じキーでもう一度送る")
    fun participantResendsRecovery(label: String) {
        val sent = checkNotNull(sentRecovery) { "以前の復帰の要求がない（$label）" }
        lastWasRecovery = true
        ctx.last = ctx.api.recover(ctx.game.id, recovery = sent.player.recovery, key = sent.key)
    }

    // ---- 鍵のローテーション（NF-S4） ----

    @Given("運営者が、資格の署名鍵を新しい版へ更新している")
    fun operatorHasRotatedKey() {
        ctx.app.rotateCredentialKey()
    }

    @When("運営者が、資格の署名鍵を新しい版へ更新する")
    fun operatorRotatesKey() {
        ctx.app.rotateCredentialKey()
    }

    @When("運営者が、旧版の鍵を設定から外す")
    fun operatorDropsOldKey() {
        ctx.app.dropOldCredentialKey()
    }

    @Then("{word}の参加者は、更新前に発行した復帰資格で復帰できる")
    fun participantRecoversWithOldKeyCredential(label: String) = participantRecovers(label)

    @Then("更新前に発行した{word}の参加者のブラウザセッションで、状況を取得できる")
    fun oldSessionStillWorks(label: String) = participantCredentialRemains(label)

    @Then("更新前に発行した{word}の参加者の資格は、復帰もブラウザセッションも権限エラーになる")
    fun oldVersionCredentialsRejected(label: String) {
        cannotRecover(player(label))
        participantCannotUseOldSession(label)
    }

    @Then("別のゲームの進行役の資格は、まだ使える")
    fun otherFacilitatorCredentialStillWorks() {
        val other = ctx.games.last()
        okOrFail(ctx.api.gameState(other.id, other.facilitator), "別のゲームの進行役の資格が使えない")
    }

    // ---- 役割の入れ替え（H4） ----

    @Given("参加者「{}」が、役割なしで参加している")
    fun participantJoinedWithoutRole(name: String) {
        ctx.join(ctx.game, name)
    }

    @When("進行役が、{word}の担当を{}に入れ替える")
    fun facilitatorReplacesHolder(
        label: String,
        name: String,
    ) {
        val role = Role.ofLabel(label)
        val old = ctx.game.playerOf(role)
        val incoming = ctx.game.participantNamed(name)
        ctx.last = ctx.api.assignRole(ctx.game.id, incoming.participantId, role, ctx.game.facilitator)
        if (ctx.response().status == HTTP_OK) {
            old.role = null
            incoming.role = role
            replaced = old
        }
    }

    @Then("{}が{word}の担当になる")
    fun becomesHolder(
        name: String,
        label: String,
    ) {
        okOrFail(ctx.response(), "入れ替えられていない")
        val state = ctx.api.gameState(ctx.game.id, ctx.game.participantNamed(name).cookie)
        expect(state.status == HTTP_OK && state.json.text("role") == Role.ofLabel(label).apiName) {
            "${name}の役割が $label ではない: ${state.status} ${state.text}"
        }
    }

    @Then("以前の{word}の参加者の資格は、自動で失効している")
    fun replacedCredentialsRevoked(label: String) {
        val old = checkNotNull(replaced) { "入れ替えられた参加者がいない（$label）" }
        cannotRecover(old)
        val session = ctx.api.gameState(ctx.game.id, old.cookie)
        expect(session.status == HTTP_FORBIDDEN) {
            "以前の担当者のブラウザセッションが使える: ${session.status} ${session.text}"
        }
    }

    @Then("{}は、第 {int} 週の数量として {int} を保存できる")
    fun namedParticipantCanSave(
        name: String,
        week: Int,
        quantity: Int,
    ) = okOrFail(save(ctx.game.participantNamed(name), week, quantity), "保存できない")
}
