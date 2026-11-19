package beergame.domain

import arrow.core.Either
import arrow.core.raise.either
import arrow.core.raise.ensure
import arrow.core.raise.ensureNotNull

/** 開始後の入れ替えで、2 つのストリームへ同一トランザクションで追記するイベント（追記の原子性は境界の責務）。 */
data class ReplaceDecision(
    val game: List<GameEvent>,
    val session: List<SessionEvent>,
)

/**
 * 開始後の AssignRole（役割の入れ替え。B5 Step 3.5）。担当者のいる役割へ、参加済み・未割り当ての参加者を割り当てる。
 * 準備中の付け替え（D9）は [decideGame] の担当で、アプリケーション層がゲームの状態で呼び分ける。
 * `session` が持つ役割の写し（D4）も更新するため、[startGame] と同じく 2 ストリームにまたがる。
 *
 * 判定順: 権限 → 参加者の存在 → 変化なし → 別の役割にいる人（付け替えは開始後は拒否）→ 資格の失効 → 終了。
 * 旧担当者（現在の担当者全員）は、外れた事実と資格の失効を同じ追記で返す。履歴・入力者のラベル・当週の入力は変えない。
 */
fun assignRoleAfterStart(
    game: GameState,
    session: SessionState,
    command: GameCommand.AssignRole,
): Either<DomainError, ReplaceDecision> =
    either {
        val data = ensureNotNull((game as? GameState.Started)?.data) { GameError.NotPreparing }
        ensure(command.actor.isFacilitatorOf(data.gameId)) { GameError.Forbidden("割り当ては進行役だけができる") }
        val incoming =
            ensureNotNull(data.participants[command.participantId]) {
                GameError.ParticipantNotFound(command.participantId)
            }
        when {
            incoming.role == command.role -> {
                NO_CHANGE
            }

            incoming.role != null -> {
                raise(GameError.NotPreparing)
            }

            else -> {
                val subject = CredentialSubject.Participant(command.participantId)
                ensure(data.credentials[subject]?.revoked == false) { GameError.CredentialAlreadyRevoked }
                session.openData().bind()
                replacement(data, command)
            }
        }
    }

private val NO_CHANGE = ReplaceDecision(emptyList(), emptyList())

/** 現在の担当者全員を、新担当者へ入れ替える（参加者の識別子の順）。担当者は開始条件により、常に 1 人以上いる。 */
private fun replacement(
    data: GameData,
    command: GameCommand.AssignRole,
): ReplaceDecision {
    val outgoing =
        data.participants
            .filterValues { it.role == command.role }
            .keys
            .sortedBy { it.value }
    return ReplaceDecision(
        game =
            outgoing.flatMap {
                listOf(
                    GameEvent.ParticipantReplaced(it, command.role, command.participantId),
                    GameEvent.CredentialRevoked(CredentialSubject.Participant(it)),
                )
            } + GameEvent.RoleAssigned(command.participantId, command.role),
        session = listOf(SessionEvent.RoleHolderReplaced(command.role, outgoing.toSet(), command.participantId)),
    )
}
