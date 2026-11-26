package bgs.domain

import cats.data.ValidatedNec
import cats.syntax.all.*

import java.time.Instant

/*
 * Game 集約（準備。ストリーム `game`）。B1 の範囲: 作成、参加、役割の割り当て、開始（GameStarted は startGame が作る）。
 * 資格の失効・再発行・復帰（B4）、観察者（B9）は後続の Bolt。
 */

/** 確定方式。手動（進行役が確定する）か、自動（4 役割の入力がそろったら、同じ追記で確定する。B7）。 */
enum CommitMode:
  case Manual, Auto

/** ゲーム設定。B1 はキット準拠（初期条件・遅延・費用方針は [[KitPreset]] の値）だけを作る。カスタム条件は B6。 */
final case class GameSettings(
    finalWeek: Week,
    demand: DemandSeries,
    costPolicy: CostPolicy,
    commitMode: CommitMode,
    initial: InitialConditions,
    delays: Delays
):
  /** 週次計算に渡す最小の設定。 */
  def simulation: SimulationSettings = SimulationSettings(finalWeek, demand, costPolicy)

object GameSettings:

  /** キット準拠の設定を、入力の形（最終週 1〜50、需要系列の各週 0〜1000 で長さは最終週以上）を検証して作る。
    * 誤りは項目ごとにすべて集める（最終週の誤りがあっても、需要系列の各週の誤りも返す）。AC1.1.2。
    */
  def kit(
      finalWeek: Int,
      demand: List[Int],
      commitMode: CommitMode
  ): ValidatedNec[ValidationError, GameSettings] =
    val week = Week.of(finalWeek).toValidatedNec
    val series = DemandSeries.of(demand, Week.of(finalWeek).getOrElse(Week.first))
    (week, series).mapN { (w, s) =>
      GameSettings(
        w,
        s,
        KitPreset.costPolicy,
        commitMode,
        KitPreset.initialConditions,
        KitPreset.delays
      )
    }

/** 資格の持ち主。進行役はゲームごとに 1 つ、参加者は参加ごとに 1 つ。 */
enum CredentialSubject:
  case Facilitator(gameId: GameId)
  case Participant(id: ParticipantId)

final case class GameData(
    gameId: GameId,
    settings: GameSettings,
    participants: Map[ParticipantId, Option[Role]],
    /** 資格の有効期限（進行役は作成時、参加者は参加時に発行する。失効・再発行・復帰は B4）。 */
    credentials: Map[CredentialSubject, Instant]
):
  /** 役割ごとの参加者（開始時に、Session へ写しとして渡す）。 */
  def roleAssignments: RoleMap[Set[ParticipantId]] =
    RoleMap.of(role => participants.collect { case (id, Some(`role`)) => id }.toSet)

  /** 参加者の役割を変える。未知の参加者なら None（decide が作らない列）。 */
  private[domain] def withRole(participantId: ParticipantId, role: Option[Role]): Option[GameData] =
    participants
      .get(participantId)
      .map(_ => copy(participants = participants.updated(participantId, role)))

enum GameState:
  /** ストリームが空。 */
  case NotCreated

  /** 参加・割り当てを受け付ける。 */
  case Preparing(data: GameData, version: StreamVersion)

  /** 設定と割り当てを固定。 */
  case Started(data: GameData, version: StreamVersion)

extension (state: GameState)
  def version: StreamVersion = state match
    case GameState.NotCreated      => StreamVersion.Zero
    case GameState.Preparing(_, v) => v
    case GameState.Started(_, v)   => v

  def name: String = state match
    case GameState.NotCreated      => "NotCreated"
    case GameState.Preparing(_, _) => "Preparing"
    case GameState.Started(_, _)   => "Started"

  def dataOrNone: Option[GameData] = state match
    case GameState.NotCreated      => None
    case GameState.Preparing(d, _) => Some(d)
    case GameState.Started(d, _)   => Some(d)

sealed trait GameCommand:
  def actor: Actor
  def at: Instant

object GameCommand:
  final case class CreateGame(
      actor: Actor,
      at: Instant,
      gameId: GameId,
      joinCode: JoinCode,
      settings: GameSettings,
      retentionDays: RetentionDays,
      facilitatorCredentialExpiresAt: Instant
  ) extends GameCommand

  /** 表示名は周辺ストアへ書くための値で、イベントには写さない（NF-S14）。 */
  final case class JoinGame(
      actor: Actor,
      at: Instant,
      participantId: ParticipantId,
      displayName: DisplayName,
      credentialExpiresAt: Instant
  ) extends GameCommand

  final case class AssignRole(actor: Actor, at: Instant, participantId: ParticipantId, role: Role)
      extends GameCommand

enum GameEvent:
  /** CreateGame。ストリームが空。 */
  case GameCreated(
      gameId: GameId,
      joinCode: JoinCode,
      settings: GameSettings,
      retentionDays: RetentionDays,
      facilitatorCredentialExpiresAt: Instant
  )

  /** JoinGame。準備中。 */
  case ParticipantJoined(participantId: ParticipantId, credentialExpiresAt: Instant)

  /** AssignRole。進行役、役割が変わる。 */
  case RoleAssigned(participantId: ParticipantId, role: Role)

  /** AssignRole による付け替え（解除の側）。 */
  case RoleUnassigned(participantId: ParticipantId, role: Role)

  /** StartGame。進行役、準備中、各役割に 1 人以上。 */
  case GameStarted(gameId: GameId)

  def name: String = this match
    case GameEvent.GameCreated(_, _, _, _, _) => "GameCreated"
    case GameEvent.ParticipantJoined(_, _)    => "ParticipantJoined"
    case GameEvent.RoleAssigned(_, _)         => "RoleAssigned"
    case GameEvent.RoleUnassigned(_, _)       => "RoleUnassigned"
    case GameEvent.GameStarted(_)             => "GameStarted"

enum GameError(val code: String, val category: ErrorCategory) extends DomainError:
  case AlreadyCreated extends GameError("game.already_created", ErrorCategory.InvalidState)

  /** 準備中でない（未作成、または開始済み）。 */
  case NotPreparing extends GameError("game.not_preparing", ErrorCategory.InvalidState)
  case Forbidden(reason: String) extends GameError("game.forbidden", ErrorCategory.Forbidden)
  case ParticipantNotFound(participantId: ParticipantId)
      extends GameError("game.participant_not_found", ErrorCategory.NotFound)

  /** 開始の条件（4 役割のそれぞれに 1 人以上）を満たさない。不足している役割を上流から下流の順に示す（AC1.2.3）。 */
  case StartConditionNotMet(missing: List[Role])
      extends GameError("game.start_condition_not_met", ErrorCategory.RuleViolation)

object Game:

  private def preparingData(state: GameState): Either[GameError, GameData] = state match
    case GameState.Preparing(data, _)                   => Right(data)
    case GameState.NotCreated | GameState.Started(_, _) => Left(GameError.NotPreparing)

  /** 準備中の割り当て。同じ役割への再割り当ては変化なし（履歴に足さない。D9）、別の役割へは付け替え（2 イベント）。 */
  private def decideAssign(
      state: GameState,
      command: GameCommand.AssignRole
  ): Either[GameError, List[GameEvent]] =
    for
      data <- preparingData(state)
      _ <- Either.cond(
        command.actor.isFacilitatorOf(data.gameId),
        (),
        GameError.Forbidden("割り当ては進行役だけができる")
      )
      previous <- data.participants
        .get(command.participantId)
        .toRight(GameError.ParticipantNotFound(command.participantId))
    yield previous match
      case Some(current) if current == command.role => Nil
      case None          => List(GameEvent.RoleAssigned(command.participantId, command.role))
      case Some(current) =>
        List(
          GameEvent.RoleUnassigned(command.participantId, current),
          GameEvent.RoleAssigned(command.participantId, command.role)
        )

  /** 作成・参加・役割の割り当ての規則は、すべてここに集まる（evolve は事実を採用するだけで、規則を持たない）。 */
  def handle(state: GameState, command: GameCommand): Either[GameError, List[GameEvent]] =
    command match
      case c: GameCommand.CreateGame =>
        for
          _ <- Either.cond(state == GameState.NotCreated, (), GameError.AlreadyCreated)
          _ <- Either.cond(
            c.actor == Actor.Anonymous,
            (),
            GameError.Forbidden("作成は匿名の操作者だけができる")
          )
        yield List(
          GameEvent.GameCreated(
            c.gameId,
            c.joinCode,
            c.settings,
            c.retentionDays,
            c.facilitatorCredentialExpiresAt
          )
        )
      case c: GameCommand.JoinGame =>
        preparingData(state).map(_ =>
          List(GameEvent.ParticipantJoined(c.participantId, c.credentialExpiresAt))
        )
      case c: GameCommand.AssignRole => decideAssign(state, c)

object GameEvents:

  /** 準備中のときだけデータを更新して版を進める。decide が作らない列（更新できない）は、状態を変えずに返す。 */
  private def updatePreparing(state: GameState)(update: GameData => Option[GameData]): GameState =
    state match
      case GameState.Preparing(data, version) =>
        update(data).fold(state)(GameState.Preparing(_, version.next))
      case GameState.NotCreated | GameState.Started(_, _) => state

  /** 準備中と開始後に、データを更新して版を進める。 */
  private def updateData(state: GameState)(update: GameData => Option[GameData]): GameState =
    state match
      case GameState.Preparing(data, version) =>
        update(data).fold(state)(GameState.Preparing(_, version.next))
      case GameState.Started(data, version) =>
        update(data).fold(state)(GameState.Started(_, version.next))
      case GameState.NotCreated => state

  /** イベントを状態へ畳み込む。全域（例外を投げない。強制キャストを使わない）。 decide が作らない列は、状態を変えずに返す（版も増えない。検知は [[Replay.game]]）。
    */
  def apply(state: GameState, event: GameEvent): GameState = event match
    case GameEvent.GameCreated(gameId, _, settings, _, facilitatorExpiresAt) =>
      state match
        case GameState.NotCreated =>
          val data = GameData(
            gameId,
            settings,
            Map.empty,
            Map(CredentialSubject.Facilitator(gameId) -> facilitatorExpiresAt)
          )
          GameState.Preparing(data, state.version.next)
        case GameState.Preparing(_, _) | GameState.Started(_, _) => state
    case GameEvent.ParticipantJoined(participantId, expiresAt) =>
      updatePreparing(state) { data =>
        if data.participants.contains(participantId) then None
        else
          Some(
            data.copy(
              participants = data.participants.updated(participantId, None),
              credentials =
                data.credentials.updated(CredentialSubject.Participant(participantId), expiresAt)
            )
          )
      }
    case GameEvent.RoleAssigned(participantId, role) =>
      updateData(state)(_.withRole(participantId, Some(role)))
    case GameEvent.RoleUnassigned(participantId, _) =>
      updatePreparing(state)(_.withRole(participantId, None))
    case GameEvent.GameStarted(_) =>
      state match
        case GameState.Preparing(data, version)             => GameState.Started(data, version.next)
        case GameState.NotCreated | GameState.Started(_, _) => state
