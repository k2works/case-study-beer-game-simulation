package beergame.application

import arrow.core.Either
import arrow.core.left
import arrow.core.right
import beergame.domain.Editor
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
                    lobby =
                        game.participants.map {
                            LobbyEntry(
                                it.participantId,
                                it.displayName,
                                it.role,
                                it.replaced,
                            )
                        },
                    roles =
                        Role.entries
                            .mapNotNull { role ->
                                game.statusOf(role) { it is Editor.ByFacilitator }?.let { role to it }
                            }.toMap(),
                    results = game.results.sortedWith(compareBy({ it.week }, { it.role.ordinal })).map { it.view() },
                ),
        )

    /**
     * 参加者。[requestedRole] が自分の役割と違えば、値を返さず `game.forbidden`（AC2.1.2）。
     * 小売店だけが当週の顧客需要を持つ（AC2.1.3）。
     * 保存者の表示名と共同担当は、自分の役割のものだけ（同じ役割の共同担当にだけ見せる。B6）。
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
                view =
                    SnapshotView.Participant(
                        participantId,
                        role,
                        role?.let { game.statusOf(it) { editor -> editor.isParticipant(participantId) } },
                        game.coHoldersOf(role, participantId),
                    ),
            ).right()
        }
    }

    private fun Editor.isParticipant(participantId: ParticipantId): Boolean =
        this is Editor.ByParticipant && id == participantId

    /** 自分の役割の共同担当（自分を含む）。役割が無ければ空。入れ替えで外れた旧担当者は、役割が無いので含まれない。 */
    private fun ProjectedGame.coHoldersOf(
        role: Role?,
        participantId: ParticipantId,
    ): List<CoHolderView> =
        if (role == null) {
            emptyList()
        } else {
            participants
                .filter { it.role == role && !it.replaced }
                .map { CoHolderView(it.displayName, it.participantId == participantId) }
        }

    /** 保存者。表示名は参加者の行から結合する（進行役の代理入力は持たない）。 */
    internal fun editorView(
        game: ProjectedGame,
        editor: Editor,
        isSelf: (Editor) -> Boolean,
    ): DecisionEditorView =
        when (editor) {
            is Editor.ByParticipant -> {
                DecisionEditorView(
                    EditorKind.PARTICIPANT,
                    isSelf(editor),
                    game.participants.firstOrNull { it.participantId == editor.id }?.displayName,
                )
            }

            is Editor.ByFacilitator -> {
                DecisionEditorView(EditorKind.FACILITATOR_PROXY, isSelf(editor), null)
            }
        }

    private fun ProjectedSession?.summary(): SessionSummary? =
        this?.let {
            SessionSummary(it.status, it.week, it.submittedRoleCount)
        }

    private fun ProjectedGame.statusOf(
        role: Role,
        isSelf: (Editor) -> Boolean,
    ): RoleStatus? =
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
                decisionEditor = decision?.let { editorView(this, it.editor, isSelf) },
                decisionSavedAt = decision?.savedAt,
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
