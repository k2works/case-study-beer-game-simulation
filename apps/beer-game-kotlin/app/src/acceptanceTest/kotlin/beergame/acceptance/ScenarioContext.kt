package beergame.acceptance

import io.cucumber.java.After
import io.cucumber.java.Before

/**
 * キット準拠の設定（最終週 12）。需要系列は、JSD の値が未確認（ASM-01）のため、受け入れ用の系列を使う。
 * 第 1 週は 4。第 2 週以降は、応答への漏れを見分けられるよう、互いに違う大きな値にする（JSD 準拠の判定ではない）。
 */
const val FINAL_WEEK = 12
val DEMAND_SERIES: List<Int> = listOf(4, 901, 902, 903, 904, 905, 906, 907, 908, 909, 910, 911)

/** 第 2 週以降の需要（小売店にも、当週の確定前には開示されない値）。 */
val FUTURE_DEMANDS: Set<String> = DEMAND_SERIES.drop(1).map(Int::toString).toSet()

fun kitGameBody(
    finalWeek: Int = FINAL_WEEK,
    demand: List<Int> = DEMAND_SERIES,
): String = """{"kind":"KIT","finalWeek":$finalWeek,"demand":[${demand.joinToString(",")}]}"""

class Participant(
    val name: String,
    val cookie: String,
    val participantId: String,
    var role: Role?,
)

class GameContext(
    val id: String,
    val facilitator: String,
    val joinCode: String,
) {
    val participants = mutableListOf<Participant>()

    fun playerOf(role: Role): Participant = participants.first { it.role == role }

    fun participantNamed(name: String): Participant = participants.first { it.name == name }
}

/** 1 つのシナリオの状態。アプリケーション（実物のサーバー）、窓口、作ったゲーム、直前の応答を持つ。 */
class ScenarioContext : AutoCloseable {
    val app = RunningApp()
    val api = GamePlayApi(app.baseUrl)
    val games = mutableListOf<GameContext>()

    /** 直前の「もし」の応答。 */
    var last: ApiResponse? = null

    /** 直前の確定の要求（再送のために、経路・本文・冪等キーを持つ）。 */
    var lastCommit: CommitRequest? = null

    val game: GameContext get() = games.first()

    fun response(): ApiResponse = checkNotNull(last) { "直前の応答がない" }

    /** ゲームを作成する。成功したら、進行役の資格と参加コードを控えて [games] に足す。 */
    fun createGame(
        body: String = kitGameBody(),
        key: String = api.newKey(),
    ): ApiResponse {
        val response = api.createGame(body, key)
        if (response.status == HTTP_CREATED) {
            val id = checkNotNull(response.createdGameId()) { "Location がない" }
            val facilitator = checkNotNull(response.credential()) { "進行役の資格が発行されていない" }
            val state = api.gameState(id, facilitator)
            check(state.status == HTTP_OK) { "作成したゲームの状態を取得できない: ${state.status} ${state.text}" }
            games += GameContext(id, facilitator, state.json.text("joinCode"))
        }
        return response
    }

    /** 参加する。成功したら、参加者として控える（役割は未割当て）。 */
    fun join(
        game: GameContext,
        name: String,
    ): Participant {
        val response = api.join(game.joinCode, name)
        check(response.status in HTTP_OK..HTTP_CREATED) { "参加できない: ${response.status} ${response.text}" }
        val cookie = checkNotNull(response.credential()) { "復帰資格が発行されていない" }
        val participantId = api.gameState(game.id, cookie).json.text("participantId")
        return Participant(name, cookie, participantId, null).also { game.participants += it }
    }

    fun assign(
        game: GameContext,
        participant: Participant,
        role: Role,
    ): ApiResponse {
        val response = api.assignRole(game.id, participant.participantId, role, game.facilitator)
        if (response.status == HTTP_OK) participant.role = role
        return response
    }

    /** 指定の役割に、それぞれ 1 人を参加させ、割り当てる。 */
    fun joinAndAssign(
        game: GameContext,
        roles: List<Role>,
    ) {
        roles.forEach { role ->
            val participant = join(game, "参加者-${role.label}")
            val response = assign(game, participant, role)
            check(response.status == HTTP_OK) { "割り当てられない: ${response.status} ${response.text}" }
        }
    }

    fun start(game: GameContext): ApiResponse = api.start(game.id, game.facilitator)

    /** 4 役割に参加者がいて、開始されたゲームを作る（作成した順に [games] へ足す）。 */
    fun createStartedGame(): GameContext {
        val created = createGame()
        check(created.status == HTTP_CREATED) { "ゲームを作成できない: ${created.status} ${created.text}" }
        val game = games.last()
        joinAndAssign(game, Role.entries)
        val started = start(game)
        check(started.status == HTTP_OK) { "ゲームを開始できない: ${started.status} ${started.text}" }
        return game
    }

    /** 進行役が見る、役割ごとの意思決定の版（確定の根拠）。 */
    fun basisOf(game: GameContext): Map<Role, Int> {
        val roles = api.sessionState(game.id, game.facilitator).json.obj("roles")
        return Role.entries.associateWith { roles.obj(it.apiName).number("decisionVersion") }
    }

    fun sessionState(
        game: GameContext,
        cookie: String? = game.facilitator,
    ) = api.sessionState(game.id, cookie)

    override fun close() = app.close()

    companion object {
        const val HTTP_OK = 200
        const val HTTP_CREATED = 201
    }
}

/** 確定の要求。同じ要求の再送に使う。 */
class CommitRequest(
    val game: GameContext,
    val week: Int,
    val body: String,
    val key: String,
)

/** シナリオの状態の入れ物。ステップ定義のクラスは、Cucumber が引数なしで作るので、状態はここから取る。 */
object Scenario {
    private var context: ScenarioContext? = null

    val current: ScenarioContext get() = checkNotNull(context) { "シナリオの開始前" }

    fun begin() {
        context = ScenarioContext()
    }

    fun end() {
        context?.close()
        context = null
    }
}

class Hooks {
    @Before
    fun begin() = Scenario.begin()

    @After
    fun end() = Scenario.end()
}
