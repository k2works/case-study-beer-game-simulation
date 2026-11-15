package beergame.persistence

import arrow.core.getOrElse
import beergame.application.NewEvent
import beergame.domain.Actor
import beergame.domain.CredentialSubject
import beergame.domain.DisplayName
import beergame.domain.DomainEvent
import beergame.domain.GameCommand
import beergame.domain.GameId
import beergame.domain.GameSettings
import beergame.domain.GameState
import beergame.domain.JoinCode
import beergame.domain.ParticipantId
import beergame.domain.Quantity
import beergame.domain.RetentionDays
import beergame.domain.Role
import beergame.domain.SessionCommand
import beergame.domain.SessionState
import beergame.domain.StartGame
import beergame.domain.StreamType
import beergame.domain.decideGame
import beergame.domain.decideSession
import beergame.domain.evolveGame
import beergame.domain.evolveSession
import beergame.domain.startGame
import java.time.Instant
import java.util.UUID

/**
 * 試験用の台本。実物のドメイン（decide / evolve）を通して、イベントを作る（永続化を通した往復の入力に使う）。
 * 試験の補助なので可変の状態を持つ。イベントの封筒の値（ID・時刻）は決まった順に作る。
 */
class GameScript(
    val gameId: GameId = GameId(UUID.randomUUID()),
    private val start: Instant = Instant.parse("2026-11-14T09:00:00Z"),
) {
    private var game: GameState = GameState.NotCreated
    private var session: SessionState = SessionState.NotStarted
    private var tick = 0L
    private val emitted = mutableListOf<NewEvent>()

    val events: List<NewEvent> get() = emitted.toList()
    val gameEvents: List<NewEvent> get() = emitted.filter { it.streamType == StreamType.GAME }
    val sessionEvents: List<NewEvent> get() = emitted.filter { it.streamType == StreamType.SESSION }
    val facilitator: Actor = Actor.Facilitator(gameId)

    private fun now(): Instant = start.plusSeconds(tick++)

    private fun record(
        stream: StreamType,
        actor: Actor,
        at: Instant,
        payloads: List<DomainEvent>,
    ) {
        val command = UUID.randomUUID()
        payloads.forEach {
            emitted +=
                NewEvent(UUID.randomUUID(), gameId, stream, it, actor.toRef(), UUID.randomUUID(), command, at)
        }
    }

    private fun applyGame(
        actor: Actor,
        at: Instant,
        command: GameCommand,
    ) {
        val decided = decideGame(game, command).getOrElse { error("台本の GameCommand が失敗した: $it") }
        record(StreamType.GAME, actor, at, decided)
        game = decided.fold(game, ::evolveGame)
    }

    fun create(
        joinCode: String = "JOIN-" + UUID.randomUUID().toString().take(8),
        finalWeek: Int = 3,
    ): GameScript {
        val settings = GameSettings.kit(finalWeek, List(finalWeek) { 4 + it }).getOrElse { error("設定が不正: $it") }
        val at = now()
        applyGame(
            Actor.Anonymous,
            at,
            GameCommand.CreateGame(
                Actor.Anonymous,
                at,
                gameId,
                JoinCode.of(joinCode).getOrElse { error("$it") },
                settings,
                RetentionDays.of(90).getOrElse { error("$it") },
                at.plusSeconds(86_400),
            ),
        )
        return this
    }

    fun join(): ParticipantId {
        val id = ParticipantId(UUID.randomUUID())
        val at = now()
        applyGame(
            Actor.Anonymous,
            at,
            GameCommand.JoinGame(
                Actor.Anonymous,
                at,
                id,
                DisplayName.of("参加者").getOrElse { error("$it") },
                at.plusSeconds(86_400),
            ),
        )
        return id
    }

    fun assign(
        participant: ParticipantId,
        role: Role,
    ): GameScript {
        val at = now()
        applyGame(facilitator, at, GameCommand.AssignRole(facilitator, at, participant, role))
        return this
    }

    /** 4 役割に 1 人ずつ参加させ、割り当てる。役割ごとの参加者を返す。 */
    fun joinAllRoles(): Map<Role, ParticipantId> =
        Role.entries.associateWith { role -> join().also { assign(it, role) } }

    fun startGame(): GameScript {
        val at = now()
        val decision = startGame(game, session, StartGame(facilitator, at)).getOrElse { error("開始に失敗: $it") }
        record(StreamType.GAME, facilitator, at, decision.game)
        record(StreamType.SESSION, facilitator, at, decision.session)
        game = decision.game.fold(game, ::evolveGame)
        session = decision.session.fold(session, ::evolveSession)
        return this
    }

    fun save(
        participant: ParticipantId,
        role: Role,
        quantity: Int,
    ): GameScript {
        val active = session as? SessionState.Active ?: error("進行中でない")
        val at = now()
        val command =
            SessionCommand.SaveDecision(
                Actor.Participant(participant),
                at,
                role,
                active.data.week,
                Quantity.of(quantity).getOrElse { error("$it") },
                active.data.decisionVersions[role],
            )
        val decided = decideSession(session, command).getOrElse { error("入力に失敗: $it") }
        record(StreamType.SESSION, command.actor, at, decided)
        session = decided.fold(session, ::evolveSession)
        return this
    }

    private fun applySession(command: SessionCommand): GameScript {
        val decided = decideSession(session, command).getOrElse { error("台本の SessionCommand が失敗した: $it") }
        record(StreamType.SESSION, command.actor, command.at, decided)
        session = decided.fold(session, ::evolveSession)
        return this
    }

    fun pause(): GameScript = now().let { applySession(SessionCommand.PauseSession(facilitator, it)) }

    fun resume(): GameScript = now().let { applySession(SessionCommand.ResumeSession(facilitator, it)) }

    /** 進行役の代理入力。当週・今の版で入力する。 */
    fun proxy(
        role: Role,
        quantity: Int,
    ): GameScript {
        val data =
            when (val state = session) {
                is SessionState.Active -> state.data
                is SessionState.Paused -> state.data
                else -> error("進行中でも一時停止中でもない")
            }
        val at = now()
        return applySession(
            SessionCommand.SubmitProxyDecision(
                facilitator,
                at,
                role,
                data.week,
                Quantity.of(quantity).getOrElse { error("$it") },
            ),
        )
    }

    fun revoke(participant: ParticipantId): GameScript {
        val at = now()
        applyGame(
            facilitator,
            at,
            GameCommand.RevokeCredential(facilitator, at, CredentialSubject.Participant(participant)),
        )
        return this
    }

    fun commit(): GameScript {
        val active = session as? SessionState.Active ?: error("進行中でない")
        val at = now()
        val command = SessionCommand.CommitWeek(facilitator, at, active.data.week, active.data.decisionVersions)
        val decided = decideSession(session, command).getOrElse { error("確定に失敗: $it") }
        record(StreamType.SESSION, facilitator, at, decided)
        session = decided.fold(session, ::evolveSession)
        return this
    }

    /** 4 役割が揃って入力し、確定する 1 週。 */
    fun playWeek(participants: Map<Role, ParticipantId>): GameScript {
        Role.entries.forEach { save(participants.getValue(it), it, 4) }
        return commit()
    }
}
