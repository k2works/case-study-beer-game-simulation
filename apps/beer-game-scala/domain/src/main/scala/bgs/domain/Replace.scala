package bgs.domain

/** 役割の割り当て。準備中は game だけ、開始後（入れ替え）は game と session の 2 ストリームにまたがる（[[Start]] と同じ形）。 */
object Replace:

  def decide(
      game: GameState,
      session: SessionState,
      command: GameCommand.AssignRole
  ): Either[DomainError, StartDecision] =
    Game.handle(game, command).map { events =>
      val after = events.foldLeft(game)(GameEvents.apply)
      val sessionEvents = (game, session) match
        case (GameState.Started(_, _), SessionState.Active(_, _)) if events.nonEmpty =>
          after.dataOrNone.map(d => SessionEvent.AssignmentsReplaced(d.roleAssignments)).toList
        case _ => Nil
      StartDecision(events, sessionEvents)
    }
