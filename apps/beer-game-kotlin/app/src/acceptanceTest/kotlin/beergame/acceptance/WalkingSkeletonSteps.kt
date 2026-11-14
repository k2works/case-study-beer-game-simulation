package beergame.acceptance

import io.cucumber.java.en.Given
import io.cucumber.java.en.Then
import io.cucumber.java.en.When

/**
 * ウォーキングスケルトンの最初のシナリオ（week-commit.feature の AC2.3.1）のステップ定義。
 * 業務ロジックを持たず、GamePlayApi を呼んで、期待値（受入条件）を確かめるだけにする。
 */
class WalkingSkeletonSteps {
    private val api: GamePlayApi = UnwiredGamePlayApi
    private lateinit var game: GameRef

    @Given("進行役が、キット準拠のゲームを作成している")
    fun createKitGame() {
        game = api.createKitGame()
    }

    @Given("{int} 人の参加者が、小売店、二次卸、一次卸、工場にそれぞれ割り当てられている")
    fun assignFourParticipants(count: Int) {
        check(count == Role.entries.size) { "役割の数と参加者の数が違う: $count" }
        Role.entries.forEach { api.assignRole(game, it) }
    }

    @Given("進行役がゲームを開始している")
    fun startGame() {
        api.start(game)
    }

    @Given("第 {int} 週の入力が、小売店 {int}、二次卸 {int}、一次卸 {int}、工場 {int} でそろっている")
    fun decisionsAreComplete(
        week: Int,
        retailer: Int,
        wholesaler: Int,
        distributor: Int,
        factory: Int,
    ) {
        api.saveDecision(game, Role.RETAILER, week, retailer)
        api.saveDecision(game, Role.WHOLESALER, week, wholesaler)
        api.saveDecision(game, Role.DISTRIBUTOR, week, distributor)
        api.saveDecision(game, Role.FACTORY, week, factory)
    }

    @When("進行役が第 {int} 週を確定する")
    fun commitWeek(week: Int) {
        api.commitWeek(game, week)
    }

    @Then("現在の週は第 {int} 週になる")
    fun currentWeekIs(week: Int) {
        val actual = api.currentWeek(game)
        if (actual != week) throw AssertionError("現在の週は第 $week 週のはずが、第 $actual 週")
    }

    @Then("第 {int} 週の結果が、{int} 役割のそれぞれについて記録される")
    fun weekResultsAreRecorded(
        week: Int,
        roles: Int,
    ) {
        val recorded = api.weekResults(game, week).map { it.role }.toSet()
        if (recorded.size != roles || recorded != Role.entries.toSet()) {
            throw AssertionError("第 $week 週の結果が記録された役割: ${recorded.map { it.label }}（期待: $roles 役割すべて）")
        }
    }

    @Then("各役割の参加者が見る状況は、第 {int} 週のものになる")
    fun everyRoleSeesWeek(week: Int) {
        Role.entries.forEach { role ->
            val view = api.viewAs(game, role)
            if (view.week != week) throw AssertionError("${role.label}の状況は第 $week 週のはずが、第 ${view.week} 週")
        }
    }
}
