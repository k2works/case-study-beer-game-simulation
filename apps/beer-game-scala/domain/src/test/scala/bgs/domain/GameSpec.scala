package bgs.domain

import bgs.domain.DomainFixtures.*
import munit.FunSuite

/** Game 集約（準備）。Given は過去のイベントの列、When はコマンド、Then は新しいイベントの列かエラー。 */
class GameSpec extends FunSuite:

  private def fold(events: List[GameEvent]): GameState =
    events.foldLeft[GameState](GameState.NotCreated)(GameEvents.apply)

  private def handle(state: GameState, command: GameCommand) = Game.handle(state, command)

  test("[AC1.1.1] 匿名の操作者が作成すると、GameCreated が 1 つ作られ、準備中になる") {
    val events = handle(GameState.NotCreated, create).fold(e => fail(e.toString), identity)
    assertEquals(events.size, 1)
    assert(events.headOption.exists(_.isInstanceOf[GameEvent.GameCreated]))
    assert(fold(events).isInstanceOf[GameState.Preparing])
  }

  test("[AC1.1.1] すでに作成されたゲームは、もう一度作成できない") {
    assertEquals(handle(preparing, create), Left(GameError.AlreadyCreated))
  }

  test("[権限] 作成は匿名の操作者だけができる") {
    val byFacilitator = create.copy(actor = Actor.Facilitator(gameId))
    assertEquals(
      handle(GameState.NotCreated, byFacilitator),
      Left(GameError.Forbidden("作成は匿名の操作者だけができる"))
    )
  }

  test("[AC1.2.1] 準備中のゲームに、参加者が参加できる") {
    val events = handle(preparing, join(1)).fold(e => fail(e.toString), identity)
    assertEquals(events, List(GameEvent.ParticipantJoined(participantId(1), expiresAt)))
  }

  test("[AC1.2.1] 未作成のゲームには参加できない（準備中でない）") {
    assertEquals(handle(GameState.NotCreated, join(1)), Left(GameError.NotPreparing))
  }

  test("[AC1.2.1] 開始後のゲームには参加できない（受付終了。AC1.2.2）") {
    val started = fold(
      List(
        GameEvent.GameCreated(gameId, joinCode, settings(), retention, expiresAt),
        GameEvent.GameStarted(gameId)
      )
    )
    assertEquals(handle(started, join(1)), Left(GameError.NotPreparing))
  }

  test("[AC1.2.5 D9] 割り当てた役割は参加者に付き、同じ役割への再割り当ては変化なし（履歴に足さない）") {
    val joined = fold(List(created, GameEvent.ParticipantJoined(participantId(1), expiresAt)))
    val events = handle(joined, assign(1, Role.Retailer)).fold(e => fail(e.toString), identity)
    assertEquals(events, List(GameEvent.RoleAssigned(participantId(1), Role.Retailer)))
    val assigned = joined.pipe(s => events.foldLeft(s)(GameEvents.apply))
    assertEquals(handle(assigned, assign(1, Role.Retailer)), Right(Nil))
  }

  test("[AC1.2.5 D9] 別の役割へは付け替えで、解除と割り当ての 2 イベントになる") {
    val state = fold(
      List(
        created,
        GameEvent.ParticipantJoined(participantId(1), expiresAt),
        GameEvent.RoleAssigned(participantId(1), Role.Retailer)
      )
    )
    assertEquals(
      handle(state, assign(1, Role.Wholesaler)),
      Right(
        List(
          GameEvent.RoleUnassigned(participantId(1), Role.Retailer),
          GameEvent.RoleAssigned(participantId(1), Role.Wholesaler)
        )
      )
    )
  }

  test("[権限] 割り当ては進行役だけができる。別のゲームの進行役でも拒否する") {
    val joined = fold(List(created, GameEvent.ParticipantJoined(participantId(1), expiresAt)))
    val byParticipant = assign(1, Role.Retailer).copy(actor = Actor.Participant(participantId(1)))
    assertEquals(handle(joined, byParticipant), Left(GameError.Forbidden("割り当ては進行役だけができる")))
    val otherGame = GameId(java.util.UUID.fromString("00000000-0000-0000-0000-0000000000ff"))
    val byOther = assign(1, Role.Retailer).copy(actor = Actor.Facilitator(otherGame))
    assertEquals(handle(joined, byOther), Left(GameError.Forbidden("割り当ては進行役だけができる")))
  }

  test("[AC1.2.5] 未知の参加者には割り当てられない") {
    assertEquals(
      handle(preparing, assign(9, Role.Retailer)),
      Left(GameError.ParticipantNotFound(participantId(9)))
    )
  }

  test("[再生] decide が作らない列（同じ参加者の二重の参加）は、不正な遷移として記録され、状態は変わらない") {
    val joined = GameEvent.ParticipantJoined(participantId(1), expiresAt)
    val replayed = Replay.game(List(created, joined, joined))
    assertEquals(replayed.invalid.size, 1)
    assertEquals(replayed.invalid.headOption.map(_.eventType), Some("ParticipantJoined"))
    assertEquals(replayed.state.version.value, 2L)
  }

  test("[再生] 有効なイベントは、版を 1 ずつ増やす") {
    val replayed =
      Replay.game(List(created, GameEvent.ParticipantJoined(participantId(1), expiresAt)))
    assertEquals(replayed.state.version.value, 2L)
    assertEquals(replayed.invalid, Nil)
  }

  private def created: GameEvent =
    GameEvent.GameCreated(gameId, joinCode, settings(), retention, expiresAt)

  extension [A](a: A) private def pipe[B](f: A => B): B = f(a)
