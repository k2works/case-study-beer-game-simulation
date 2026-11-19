package beergame.application

import beergame.domain.DisclosurePolicy
import beergame.domain.GameId

/*
 * 観察（US4.1。B9）。観察者と進行役が、プレイ中に見られる範囲。役割別の値・将来の需要・参加コード・入力者は、型に持たせない。
 * 開示の規則は純粋関数 [forObservation]。公開範囲が「なし」なら合計を出さず、寄与者が 2 未満の週は、逆算を防ぐため値を出さずに理由を示す。
 */

/** 合計を出さない理由。画面が、利用者向けの文言を選ぶ。 */
enum class HiddenReason {
    /** 公開範囲が「なし」（進行役が、プレイ中の合計を見せない設定にした）。 */
    DISCLOSURE_NONE,

    /** 寄与者が 2 未満で、合計から個別の値を逆算できてしまう（BR-17）。 */
    CONTRIBUTORS_BELOW_MINIMUM,
}

/** 確定済みの 1 週のチーム合計。値を出さない週は [Hidden]（値を持たない）。 */
sealed interface ObservationWeek {
    val week: Int

    data class Visible(
        override val week: Int,
        val ordered: Int,
        val inventory: Int,
        val backlog: Int,
    ) : ObservationWeek

    data class Hidden(
        override val week: Int,
        val reason: HiddenReason,
    ) : ObservationWeek
}

/** 合計の開示。[policy] が「なし」なら [weeks] は空で、[hiddenReason] に理由が入る。 */
data class ObservationTotals(
    val policy: DisclosurePolicy,
    val hiddenReason: HiddenReason?,
    val weeks: List<ObservationWeek>,
)

/** 観察画面の内容。現在週と完了状況（入力済みの役割数）と、チーム合計だけ。 */
data class Observation(
    val gameId: GameId,
    val status: GameStatus,
    val finalWeek: Int,
    val session: SessionSummary?,
    val totals: ObservationTotals,
    val versions: Versions,
)

/** 寄与者がこの数に満たない週は、合計を出さない（1 役割だけの合計は、その役割の値そのもの）。 */
const val MIN_CONTRIBUTORS = 2

/** 主の読み取りから、観察者が読める項目だけを取り出す（観察者専用の読み取りポートが無い構成）。 */
internal fun ProjectedGame.toObservation(): ProjectedObservation =
    ProjectedObservation(status, finalWeek, session, teamTotals)

/**
 * 観察の開示。[policy] は公開範囲、[rows] は観察者が読める投影、[versions] は画面の再取得の合図（行より新しくならない）。
 * 確定した週だけ（投影が持つ週）を、週の順に返す。
 */
fun Disclosure.forObservation(
    gameId: GameId,
    policy: DisclosurePolicy,
    rows: ProjectedObservation,
    versions: Versions,
): Observation =
    Observation(
        gameId = gameId,
        status = rows.status,
        finalWeek = rows.finalWeek,
        session = rows.session?.let { SessionSummary(it.status, it.week, it.submittedRoleCount) },
        totals =
            when (policy) {
                DisclosurePolicy.NONE -> {
                    ObservationTotals(policy, HiddenReason.DISCLOSURE_NONE, emptyList())
                }

                DisclosurePolicy.TEAM_TOTAL -> {
                    ObservationTotals(
                        policy,
                        null,
                        rows.teamTotals.sortedBy { it.week }.map(::weekOf),
                    )
                }
            },
        versions = versions,
    )

private fun weekOf(total: ProjectedTeamTotal): ObservationWeek =
    if (total.contributors < MIN_CONTRIBUTORS) {
        ObservationWeek.Hidden(total.week, HiddenReason.CONTRIBUTORS_BELOW_MINIMUM)
    } else {
        ObservationWeek.Visible(total.week, total.ordered, total.inventory, total.backlog)
    }
