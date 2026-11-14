package beergame.application

import arrow.core.Either
import arrow.core.left
import arrow.core.right
import beergame.domain.GameError
import beergame.domain.ParticipantId
import beergame.domain.Role

/**
 * 開示の規則（B1 の範囲）。投影から読んだ行に、呼び出した人ごとの規則を掛ける純粋関数。
 * 設計書は `domain` に置くが、読み取りの型（[ProjectedGame]）が `application` にあるので、B1 では同じ層に置いた
 * （読み取りの型にだけ依存し、`Ports` には依存しない。`domain` へ移すのは機械的にできる）。
 * 観察者の規則（公開範囲、寄与者数での抑止）は B9。
 */
object Disclosure {
    fun forFacilitator(game: ProjectedGame): Snapshot =
        Snapshot(
            gameId = game.gameId,
            status = game.status,
            session = game.session.summary(),
            versions = game.versions,
            view =
                SnapshotView.Facilitator(
                    joinCode = game.joinCode,
                    finalWeek = game.finalWeek,
                    lobby = game.participants.map { LobbyEntry(it.participantId, it.displayName, it.role) },
                    roles = Role.entries.mapNotNull { role -> game.statusOf(role)?.let { role to it } }.toMap(),
                    results = game.results.sortedWith(compareBy({ it.week }, { it.role.ordinal })).map { it.view() },
                ),
        )

    /**
     * 参加者。[requestedRole] が自分の役割と違えば、値を返さず `game.forbidden`（AC2.1.2）。
     * 小売店だけが当週の顧客需要を持つ（AC2.1.3）。
     */
    fun forParticipant(
        game: ProjectedGame,
        participantId: ParticipantId,
        requestedRole: Role?,
    ): Either<GameError, Snapshot> {
        val role = game.participants.firstOrNull { it.participantId == participantId }?.role
        return if (requestedRole != null && requestedRole != role) {
            GameError.Forbidden("他の役割の状況は取得できない").left()
        } else {
            Snapshot(
                gameId = game.gameId,
                status = game.status,
                session = game.session.summary(),
                versions = game.versions,
                view = SnapshotView.Participant(participantId, role, role?.let { game.statusOf(it) }),
            ).right()
        }
    }

    private fun ProjectedSession?.summary(): SessionSummary? =
        this?.let {
            SessionSummary(it.status, it.week, it.submittedRoleCount)
        }

    private fun ProjectedGame.statusOf(role: Role): RoleStatus? =
        roleStates[role]?.let { state ->
            val decision = decisions[role]
            RoleStatus(
                inventory = state.inventory,
                backlog = state.backlog,
                arrivals = state.arrivals,
                orders = state.orders,
                customerDemand = if (role.downstream == null) state.orders else null,
                decision = decision?.quantity,
                decisionVersion = decision?.version ?: 0L,
            )
        }

    private fun ProjectedWeekResult.view(): WeekResultView =
        WeekResultView(
            week,
            role,
            orders,
            shipped,
            ordered,
            endingInventory,
            endingBacklog,
            weeklyCostMinor,
            cumulativeCostMinor,
        )
}
