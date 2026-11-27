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

/** プレイ中に観察者へ見せる範囲（B6 は設定として保存するだけ。実際の開示は B9）。 */
enum DisclosurePolicy:
  case TeamTotal, None

/** 設定の種別。キットの値と同じなら [[Kit]]、違えば [[Custom]]（確定方式・最終週・需要系列は、判定に含めない）。 */
enum SettingsKind:
  case Kit, Custom

/** キットの値から変えた項目（AC1.1.3）。宣言の順が、表示の順。 */
enum SettingsField:
  case InitialInventory, InitialFlow, OrderDelay, ShipmentDelay, ProductionDelay, HoldingCost,
    BacklogCost, Disclosure

/** カスタム条件の入力（省略した項目は、キットの値）。範囲の検証は [[GameSettings.custom]]。 */
final case class CustomConditions(
    initialInventory: Map[Role, Int],
    initialFlow: Option[Int],
    orderDelayWeeks: Option[Int],
    shipmentDelayWeeks: Option[Int],
    productionDelayWeeks: Option[Int],
    holdingCostMinor: Option[Int],
    backlogCostMinor: Option[Int],
    disclosurePolicy: Option[DisclosurePolicy]
)

/** ゲーム設定。キット準拠（[[KitPreset]]）か、カスタム条件（B6）。 */
final case class GameSettings(
    finalWeek: Week,
    demand: DemandSeries,
    costPolicy: CostPolicy,
    commitMode: CommitMode,
    initial: InitialConditions,
    delays: Delays,
    disclosure: DisclosurePolicy
):
  /** 週次計算に渡す最小の設定。 */
  def simulation: SimulationSettings = SimulationSettings(finalWeek, demand, costPolicy)

  /** キットの値から変えた項目（確定方式・最終週・需要系列は含めない）。 */
  def changedFields: List[SettingsField] =
    List(
      SettingsField.InitialInventory -> (initial.inventory != KitPreset.initialConditions.inventory),
      SettingsField.InitialFlow -> (initial.flow != KitPreset.initialConditions.flow),
      SettingsField.OrderDelay -> (delays.order != KitPreset.delays.order),
      SettingsField.ShipmentDelay -> (delays.shipment != KitPreset.delays.shipment),
      SettingsField.ProductionDelay -> (delays.production != KitPreset.delays.production),
      SettingsField.HoldingCost -> (costPolicy.holding != KitPreset.costPolicy.holding),
      SettingsField.BacklogCost -> (costPolicy.backlog != KitPreset.costPolicy.backlog),
      SettingsField.Disclosure -> (disclosure != DisclosurePolicy.TeamTotal)
    ).collect { case (field, true) => field }

  def kind: SettingsKind = if changedFields.isEmpty then SettingsKind.Kit else SettingsKind.Custom

object GameSettings:

  /** キット準拠の設定を、入力の形（最終週 1〜50、需要系列の各週 0〜1000 で長さは最終週以上）を検証して作る。
    * 誤りは項目ごとにすべて集める（最終週の誤りがあっても、需要系列の各週の誤りも返す）。AC1.1.2。
    */
  def kit(
      finalWeek: Int,
      demand: List[Int],
      commitMode: CommitMode
  ): ValidatedNec[ValidationError, GameSettings] =
    custom(
      finalWeek,
      demand,
      commitMode,
      CustomConditions(Map.empty, None, None, None, None, None, None, None)
    )

  private def bounded(
      field: String,
      value: Int,
      min: Int,
      max: Int
  ): ValidatedNec[ValidationError, Int] =
    if value >= min && value <= max then value.validNec
    else
      ValidationError
        .ConditionOutOfRange(field, s"$min 以上 $max 以下の整数にしてください")
        .invalidNec

  /** カスタム条件つきの設定。範囲外の値は、対象の項目ごとにすべて集める（AC1.1.4）。省略した項目は、キットの値。 */
  def custom(
      finalWeek: Int,
      demand: List[Int],
      commitMode: CommitMode,
      conditions: CustomConditions
  ): ValidatedNec[ValidationError, GameSettings] =
    val week = Week.of(finalWeek).toValidatedNec
    val series = DemandSeries.of(demand, Week.of(finalWeek).getOrElse(Week.first))
    val kitInitial = KitPreset.initialConditions
    val inventories = Role.values.toList.traverse(role =>
      conditions.initialInventory
        .get(role)
        .fold(kitInitial.inventory(role).validNec[ValidationError])(n =>
          bounded("initialInventory", n, 0, 1000).map(Units.trusted(_))
        )
    )
    val flow = conditions.initialFlow.fold(kitInitial.flow.validNec[ValidationError])(n =>
      bounded("initialFlow", n, 0, 1000).map(Units.trusted(_))
    )
    def delay(field: String, value: Option[Int], kit: Delay) =
      value.fold(kit.validNec[ValidationError])(n => bounded(field, n, 1, 8).map(Delay(_)))
    def cost(field: String, value: Option[Int], kit: Money) =
      value.fold(kit.validNec[ValidationError])(n =>
        bounded(field, n, 0, 100000).map(Money.trusted(_))
      )
    val delays = (
      delay("orderDelayWeeks", conditions.orderDelayWeeks, KitPreset.delays.order),
      delay("shipmentDelayWeeks", conditions.shipmentDelayWeeks, KitPreset.delays.shipment),
      delay("productionDelayWeeks", conditions.productionDelayWeeks, KitPreset.delays.production)
    ).mapN(Delays.apply)
    val costs = (
      cost("holdingCostMinor", conditions.holdingCostMinor, KitPreset.costPolicy.holding),
      cost("backlogCostMinor", conditions.backlogCostMinor, KitPreset.costPolicy.backlog)
    ).mapN(CostPolicy.apply)
    (week, series, inventories, flow, delays, costs).mapN { (w, s, inv, f, d, c) =>
      GameSettings(
        w,
        s,
        c,
        commitMode,
        InitialConditions(RoleMap.of(role => inv(role.ordinal)), f),
        d,
        conditions.disclosurePolicy.getOrElse(DisclosurePolicy.TeamTotal)
      )
    }

/** 資格の持ち主。進行役はゲームごとに 1 つ、参加者は参加ごとに 1 つ。 */
enum CredentialSubject:
  case Facilitator(gameId: GameId)
  case Participant(id: ParticipantId)

final case class GameData(
    gameId: GameId,
    joinCode: JoinCode,
    settings: GameSettings,
    participants: Map[ParticipantId, Option[Role]],
    /** 資格の有効期限（進行役は作成時、参加者は参加時に発行する。失効・再発行・復帰は B4）。 */
    credentials: Map[CredentialSubject, Instant],
    /** 進行役が失効させた参加者（再発行で外れる。AC3.2.5）。 */
    revoked: Set[ParticipantId]
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

  /** 進行役が、漏れた参加者の資格を失効させる（準備中・開始後の両方）。 */
  final case class RevokeCredential(actor: Actor, at: Instant, participantId: ParticipantId)
      extends GameCommand

  /** 失効した資格を再発行する（新しい有効期限）。失効していなければ拒否する。 */
  final case class ReissueCredential(
      actor: Actor,
      at: Instant,
      participantId: ParticipantId,
      credentialExpiresAt: Instant
  ) extends GameCommand

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

  /** RevokeCredential。参加者の資格を失効させた。 */
  case CredentialRevoked(participantId: ParticipantId)

  /** ReissueCredential。失効した資格を再発行した（新しい有効期限）。 */
  case CredentialReissued(participantId: ParticipantId, credentialExpiresAt: Instant)

  def name: String = this match
    case GameEvent.GameCreated(_, _, _, _, _) => "GameCreated"
    case GameEvent.ParticipantJoined(_, _)    => "ParticipantJoined"
    case GameEvent.RoleAssigned(_, _)         => "RoleAssigned"
    case GameEvent.RoleUnassigned(_, _)       => "RoleUnassigned"
    case GameEvent.GameStarted(_)             => "GameStarted"
    case GameEvent.CredentialRevoked(_)       => "CredentialRevoked"
    case GameEvent.CredentialReissued(_, _)   => "CredentialReissued"

enum GameError(val code: String, val category: ErrorCategory) extends DomainError:
  case AlreadyCreated extends GameError("game.already_created", ErrorCategory.InvalidState)

  /** 準備中でない（未作成、または開始済み）。 */
  case NotPreparing extends GameError("game.not_preparing", ErrorCategory.InvalidState)
  case Forbidden(reason: String) extends GameError("game.forbidden", ErrorCategory.Forbidden)

  /** 参加コードが無効（不明、または形式が不正）。区別せず、同じ応答にする（列挙の防止。AC1.2.2）。 */
  case InvitationInvalid extends GameError("game.invitation_invalid", ErrorCategory.Forbidden)
  case CredentialAlreadyRevoked
      extends GameError("game.credential_already_revoked", ErrorCategory.InvalidState)
  case CredentialNotRevoked
      extends GameError("game.credential_not_revoked", ErrorCategory.InvalidState)
  case ParticipantNotFound(participantId: ParticipantId)
      extends GameError("game.participant_not_found", ErrorCategory.NotFound)

  /** 開始の条件（4 役割のそれぞれに 1 人以上）を満たさない。不足している役割を上流から下流の順に示す（AC1.2.3）。 */
  case StartConditionNotMet(missing: List[Role])
      extends GameError("game.start_condition_not_met", ErrorCategory.RuleViolation)

object Game:

  private def preparingData(state: GameState): Either[GameError, GameData] = state match
    case GameState.Preparing(data, _)                   => Right(data)
    case GameState.NotCreated | GameState.Started(_, _) => Left(GameError.NotPreparing)

  private def anyData(state: GameState): Either[GameError, GameData] = state match
    case GameState.Preparing(data, _) => Right(data)
    case GameState.Started(data, _)   => Right(data)
    case GameState.NotCreated         => Left(GameError.NotPreparing)

  /** 失効・再発行の共通の確認: 進行役であること、対象の参加者がいること。準備中と開始後の両方で受け付ける。 */
  private def credentialTarget(
      state: GameState,
      actor: Actor,
      participantId: ParticipantId
  ): Either[GameError, GameData] =
    for
      data <- anyData(state)
      _ <- Either.cond(
        actor.isFacilitatorOf(data.gameId),
        (),
        GameError.Forbidden("資格の失効・再発行は進行役だけができる")
      )
      _ <- Either.cond(
        data.participants.contains(participantId),
        (),
        GameError.ParticipantNotFound(participantId)
      )
    yield data

  /** 割り当て。準備中は、同じ役割への再割り当ては変化なし（履歴に足さない。D9）、別の役割へは付け替え（2 イベント）。
    * 開始後は、役割を持たない参加者を、担当のいる役割へ入れ替える（担当者全員の資格を失効させ、新担当者が引き継ぐ。D3）。
    */
  private def decideAssign(
      state: GameState,
      command: GameCommand.AssignRole
  ): Either[GameError, List[GameEvent]] =
    for
      data <- anyData(state)
      _ <- Either.cond(
        command.actor.isFacilitatorOf(data.gameId),
        (),
        GameError.Forbidden("割り当ては進行役だけができる")
      )
      previous <- data.participants
        .get(command.participantId)
        .toRight(GameError.ParticipantNotFound(command.participantId))
      started = state match
        case GameState.Started(_, _)                          => true
        case GameState.Preparing(_, _) | GameState.NotCreated => false
      events <- previous match
        case Some(current) if current == command.role => Right(Nil)
        case Some(_) if started                       => Left(GameError.NotPreparing)
        case Some(current)                            =>
          Right(
            List(
              GameEvent.RoleUnassigned(command.participantId, current),
              GameEvent.RoleAssigned(command.participantId, command.role)
            )
          )
        case None if started =>
          Either.cond(
            !data.revoked.contains(command.participantId),
            data.roleAssignments(command.role).toList.sortBy(_.value.toString).flatMap { old =>
              (if data.revoked.contains(old) then Nil
               else List(GameEvent.CredentialRevoked(old))) :+
                GameEvent.RoleUnassigned(old, command.role)
            } :+ GameEvent.RoleAssigned(command.participantId, command.role),
            GameError.CredentialAlreadyRevoked
          )
        case None => Right(List(GameEvent.RoleAssigned(command.participantId, command.role)))
    yield events

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
      case c: GameCommand.AssignRole       => decideAssign(state, c)
      case c: GameCommand.RevokeCredential =>
        credentialTarget(state, c.actor, c.participantId).flatMap { data =>
          Either.cond(
            !data.revoked.contains(c.participantId),
            List(GameEvent.CredentialRevoked(c.participantId)),
            GameError.CredentialAlreadyRevoked
          )
        }
      case c: GameCommand.ReissueCredential =>
        credentialTarget(state, c.actor, c.participantId).flatMap { data =>
          Either.cond(
            data.revoked.contains(c.participantId),
            List(GameEvent.CredentialReissued(c.participantId, c.credentialExpiresAt)),
            GameError.CredentialNotRevoked
          )
        }

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
    case GameEvent.GameCreated(gameId, joinCode, settings, _, facilitatorExpiresAt) =>
      state match
        case GameState.NotCreated =>
          val data = GameData(
            gameId,
            joinCode,
            settings,
            Map.empty,
            Map(CredentialSubject.Facilitator(gameId) -> facilitatorExpiresAt),
            Set.empty
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
      updateData(state)(_.withRole(participantId, None))
    case GameEvent.CredentialRevoked(participantId) =>
      updateData(state)(data =>
        Some(data)
          .filter(_.participants.contains(participantId))
          .map(d => d.copy(revoked = d.revoked + participantId))
      )
    case GameEvent.CredentialReissued(participantId, expiresAt) =>
      updateData(state)(data =>
        Some(data)
          .filter(_.participants.contains(participantId))
          .map(d =>
            d.copy(
              revoked = d.revoked - participantId,
              credentials =
                d.credentials.updated(CredentialSubject.Participant(participantId), expiresAt)
            )
          )
      )
    case GameEvent.GameStarted(_) =>
      state match
        case GameState.Preparing(data, version)             => GameState.Started(data, version.next)
        case GameState.NotCreated | GameState.Started(_, _) => state
