package beergame.domain

import arrow.core.Either
import arrow.core.raise.either
import arrow.core.raise.ensure
import java.time.Instant

/** ゲームの開始。2 つのストリームにまたがるため、GameCommand ではなく [startGame] の入力にする。 */
data class StartGame(
    override val actor: Actor,
    override val at: Instant,
) : Command

/** 開始で、2 つのストリームへ同一トランザクションで追記するイベント（追記の原子性は境界の責務）。 */
data class StartDecision(
    val game: List<GameEvent>,
    val session: List<SessionEvent>,
)

/**
 * 開始。進行役だけが、準備中のゲームを、各役割に 1 人以上が割り当て済みのときに開始できる（AC1.2.3）。
 * 判定順: 権限 → 開始済み（二重の開始は版 1 への追記が重複して片方が失敗し、再読み込みで AlreadyStarted になる）→ 開始条件。
 * `SessionStarted` は、設定と役割の割り当ての写しと、キット準拠の初期状態を持つ（D4）。
 */
fun startGame(
    game: GameState,
    session: SessionState,
    command: StartGame,
): Either<DomainError, StartDecision> =
    either {
        val data = game.dataOrNull() ?: raise(GameError.NotPreparing)
        ensure(command.actor.isFacilitatorOf(data.gameId)) { GameError.Forbidden("開始は進行役だけができる") }
        ensure(game is GameState.Preparing && session is SessionState.NotStarted) { SessionError.AlreadyStarted }
        val assignments = data.roleAssignments()
        val missing = Role.entries.filter { assignments[it].isEmpty() }
        ensure(missing.isEmpty()) { GameError.StartConditionNotMet(missing) }
        StartDecision(
            game = listOf(GameEvent.GameStarted(data.gameId)),
            session =
                listOf(
                    SessionEvent.SessionStarted(
                        data.gameId,
                        data.settings,
                        assignments,
                        KitPreset.initialStates(data.settings.demand),
                        data.settings.commitMode,
                    ),
                ),
        )
    }
