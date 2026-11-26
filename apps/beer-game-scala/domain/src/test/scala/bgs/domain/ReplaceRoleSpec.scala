package bgs.domain

import bgs.domain.DomainFixtures.*
import munit.FunSuite

/** 開始後の役割の入れ替え（AC3.2.5。D3: 未失効の旧担当者にだけ CredentialRevoked）。game と session の 2 ストリームにまたがる。 */
class ReplaceRoleSpec extends FunSuite:

  private val newcomer = participantId(9)

  /** 参加者 9（役割なし）が参加している、開始済みのゲームとセッション。 */
  private def started: (GameState, SessionState) =
    val joined = GameEvents.apply(fullGame, GameEvent.ParticipantJoined(newcomer, expiresAt))
    val game = GameEvents.apply(joined, GameEvent.GameStarted(gameId))
    (game, startedSession)

  private def assign(who: ParticipantId, role: Role, actor: Actor = facilitator) =
    GameCommand.AssignRole(actor, at, who, role)

  private def decide(state: (GameState, SessionState), command: GameCommand.AssignRole) =
    Replace.decide(state._1, state._2, command)

  test("[AC3.2.5] 役割なしの参加者を、担当のいる役割へ入れ替えると、旧担当者の資格が失効し、新担当者が引き継ぐ") {
    val old = holder(Role.Retailer)
    val result =
      decide(started, assign(newcomer, Role.Retailer)).fold(e => fail(e.toString), identity)
    assertEquals(
      result.game,
      List(
        GameEvent.CredentialRevoked(old),
        GameEvent.RoleUnassigned(old, Role.Retailer),
        GameEvent.RoleAssigned(newcomer, Role.Retailer)
      )
    )
    val game = result.game.foldLeft(started._1)(GameEvents.apply)
    assertEquals(game.dataOrNone.map(_.roleAssignments(Role.Retailer)), Some(Set(newcomer)))
    val session = result.session.foldLeft(started._2)(SessionEvents.apply)
    session match
      case SessionState.Active(data, _) =>
        assertEquals(data.assignments(Role.Retailer), Set(newcomer))
      case other => fail(s"進行中のはず: $other")
  }

  test("[AC3.2.5] 共同担当のいる役割は、担当者全員の資格が失効する") {
    val co = participantId(8)
    val joined = List[GameEvent](
      GameEvent.ParticipantJoined(co, expiresAt),
      GameEvent.RoleAssigned(co, Role.Retailer)
    ).foldLeft(fullGame)(GameEvents.apply)
    val withNewcomer = GameEvents.apply(joined, GameEvent.ParticipantJoined(newcomer, expiresAt))
    val game = GameEvents.apply(withNewcomer, GameEvent.GameStarted(gameId))
    val result = decide((game, startedSession), assign(newcomer, Role.Retailer))
      .fold(e => fail(e.toString), identity)
    val revoked = result.game.collect { case GameEvent.CredentialRevoked(id) => id }.toSet
    assertEquals(revoked, Set(holder(Role.Retailer), co))
  }

  test("[AC3.2.5] 同じ役割への割り当て直しは、何も変わらず、履歴に足さない") {
    val result =
      decide(started, assign(holder(Role.Retailer), Role.Retailer))
        .fold(e => fail(e.toString), identity)
    assertEquals(result, StartDecision(Nil, Nil))
  }

  test("[AC3.2.5] 進行役以外は入れ替えられない。別の役割にいる人の付け替えは、準備中でないので拒否") {
    assert(
      decide(
        started,
        assign(newcomer, Role.Retailer, Actor.Participant(holder(Role.Retailer)))
      ).isLeft
    )
    assertEquals(
      decide(started, assign(holder(Role.Wholesaler), Role.Retailer)),
      Left(GameError.NotPreparing)
    )
  }

  test("[AC3.2.5] 資格が失効している参加者は、新担当者になれない") {
    val revokedGame = GameEvents.apply(started._1, GameEvent.CredentialRevoked(newcomer))
    assertEquals(
      decide((revokedGame, started._2), assign(newcomer, Role.Retailer)),
      Left(GameError.CredentialAlreadyRevoked)
    )
  }

  test("[準備中] 準備中の割り当ては、従来どおり game だけに追記する") {
    val joined = GameEvents.apply(fullGame, GameEvent.ParticipantJoined(newcomer, expiresAt))
    val result =
      Replace
        .decide(joined, SessionState.NotStarted, assign(newcomer, Role.Retailer))
        .fold(e => fail(e.toString), identity)
    assertEquals(result.session, Nil)
    assert(result.game.nonEmpty)
  }
