package bgs.domain

import java.time.Instant

/** ゲームの開始。2 つのストリームにまたがるため、GameCommand ではなく [[Start.decide]] の入力にする。 */
final case class StartGame(actor: Actor, at: Instant)

/** 開始で、2 つのストリームへ同一トランザクションで追記するイベント（追記の原子性は境界の責務）。 */
final case class StartDecision(game: List[GameEvent], session: List[SessionEvent])

object Start:

  /** 開始。進行役だけが、準備中のゲームを、各役割に 1 人以上が割り当て済みのときに開始できる（AC1.2.3）。 判定順: 権限 → 開始済み → 開始条件。`SessionStarted`
    * は、設定と役割の割り当ての写しと、キット準拠の初期状態を持つ（D4）。
    */
  def decide(
      game: GameState,
      session: SessionState,
      command: StartGame
  ): Either[DomainError, StartDecision] =
    for
      data <- game.dataOrNone.toRight[DomainError](GameError.NotPreparing)
      _ <- Either.cond[DomainError, Unit](
        command.actor.isFacilitatorOf(data.gameId),
        (),
        GameError.Forbidden("開始は進行役だけができる")
      )
      isPreparing = game match
        case GameState.Preparing(_, _)                      => true
        case GameState.NotCreated | GameState.Started(_, _) => false
      _ <- Either.cond[DomainError, Unit](
        isPreparing && session == SessionState.NotStarted,
        (),
        SessionError.AlreadyStarted
      )
      assignments = data.roleAssignments
      missing = Role.values.toList.filter(role => assignments(role).isEmpty)
      _ <- Either.cond[DomainError, Unit](
        missing.isEmpty,
        (),
        GameError.StartConditionNotMet(missing)
      )
    yield StartDecision(
      game = List(GameEvent.GameStarted(data.gameId)),
      session = List(
        SessionEvent.SessionStarted(
          data.gameId,
          data.settings,
          assignments,
          KitPreset
            .initialStates(data.settings.demand, data.settings.initial, data.settings.delays),
          data.settings.commitMode
        )
      )
    )
