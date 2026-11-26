package bgs.domain

/*
 * 集約に共通の土台。操作者、エラーの基底、再生。時刻・ID・乱数はここでも作らない（コマンドの値で受け取る）。
 */

/** ストリームの種類。1 ゲームにつき `game` と `session` の 2 本。 */
enum StreamType:
  case Game, Session

/** エラーの分類。HTTP の状態への写像（アダプターの責務）の入力になる。 */
enum ErrorCategory:
  case Forbidden, NotFound, InvalidState, Conflict, RuleViolation

/** 業務ルール違反。安定した [[code]]（小文字のドット区切り `<領域>.<名前>`）と [[category]] を持つ。 `code` は problem+json の `type`
  * と画面の辞書の鍵になるので、一度決めたら変えない。
  */
trait DomainError:
  def code: String
  def category: ErrorCategory

/** コマンドを発行した主体。認証は境界が行い、結果の [[Actor]] をコマンドに載せる（観察者は B9）。 */
enum Actor:
  case Facilitator(gameId: GameId)
  case Participant(id: ParticipantId)
  case Anonymous

  def isFacilitatorOf(gameId: GameId): Boolean = this match
    case Actor.Facilitator(id) => id == gameId
    case Actor.Participant(_)  => false
    case Actor.Anonymous       => false

/** decide が作らない列（例: 二重の参加）を再生で見つけた記録。状態は変わらない。 */
final case class InvalidTransition(streamType: StreamType, stateName: String, eventType: String)

/** 再生の結果。再生した状態と、検知した不正な遷移。 */
final case class Replayed[S](state: S, invalid: List[InvalidTransition])

object Replay:

  def session(events: List[SessionEvent]): Replayed[SessionState] =
    events.foldLeft(Replayed[SessionState](SessionState.NotStarted, Nil)) { (acc, event) =>
      val next = SessionEvents.apply(acc.state, event)
      if next.version == acc.state.version then
        Replayed(
          next,
          acc.invalid :+ InvalidTransition(StreamType.Session, acc.state.name, event.name)
        )
      else Replayed(next, acc.invalid)
    }

  /** イベント列を状態へ畳み込む。有効なイベントは必ず版を 1 増やすので、 前後で版が増えなかったイベントを不正な遷移として記録する。
    */
  def game(events: List[GameEvent]): Replayed[GameState] =
    events.foldLeft(Replayed[GameState](GameState.NotCreated, Nil)) { (acc, event) =>
      val next = GameEvents.apply(acc.state, event)
      if next.version == acc.state.version then
        Replayed(
          next,
          acc.invalid :+ InvalidTransition(StreamType.Game, acc.state.name, event.name)
        )
      else Replayed(next, acc.invalid)
    }
