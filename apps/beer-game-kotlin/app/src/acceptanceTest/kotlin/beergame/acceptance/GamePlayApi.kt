package beergame.acceptance

/** 受け入れから見た 4 つの役割（業務の言葉）。 */
enum class Role(
    val label: String,
) {
    RETAILER("小売店"),
    WHOLESALER("二次卸"),
    DISTRIBUTOR("一次卸"),
    FACTORY("工場"),
}

/** 作成したゲームの参照。 */
data class GameRef(
    val id: String,
)

/** 確定した週の、役割別の結果（AC2.3.5 の項目）。 */
data class RoleWeekResult(
    val role: Role,
    val week: Int,
    val order: Int,
    val inventory: Int,
    val backlog: Int,
    val shipment: Int,
    val cost: Double,
)

/** 参加者が自分の役割で見る状況。 */
data class RoleView(
    val role: Role,
    val week: Int,
)

/**
 * 受け入れが、アプリケーションに対して行う操作と問い合わせ。
 * ステップ定義はこの窓口だけを呼ぶ（薄く保つ）。Step 9〜11 で、Ktor のテスト用アプリケーション（実 DB）を通す実装に差し替える。
 */
interface GamePlayApi {
    fun createKitGame(): GameRef

    fun assignRole(
        game: GameRef,
        role: Role,
    )

    fun start(game: GameRef)

    fun saveDecision(
        game: GameRef,
        role: Role,
        week: Int,
        quantity: Int,
    )

    fun commitWeek(
        game: GameRef,
        week: Int,
    )

    fun currentWeek(game: GameRef): Int

    fun weekResults(
        game: GameRef,
        week: Int,
    ): List<RoleWeekResult>

    fun viewAs(
        game: GameRef,
        role: Role,
    ): RoleView
}

/**
 * 内側（ドメイン・アプリケーション・HTTP）がまだ無い間の窓口。何もしないで、開始直後の状態を返す。
 * これにより、シナリオは Given・When を通り、Then のアサーションで失敗する（Red）。Step 4〜9 の後に実物へ差し替える。
 */
object UnwiredGamePlayApi : GamePlayApi {
    override fun createKitGame() = GameRef("unwired")

    override fun assignRole(
        game: GameRef,
        role: Role,
    ) = Unit

    override fun start(game: GameRef) = Unit

    override fun saveDecision(
        game: GameRef,
        role: Role,
        week: Int,
        quantity: Int,
    ) = Unit

    override fun commitWeek(
        game: GameRef,
        week: Int,
    ) = Unit

    override fun currentWeek(game: GameRef) = 1

    override fun weekResults(
        game: GameRef,
        week: Int,
    ) = emptyList<RoleWeekResult>()

    override fun viewAs(
        game: GameRef,
        role: Role,
    ) = RoleView(role, week = 1)
}
