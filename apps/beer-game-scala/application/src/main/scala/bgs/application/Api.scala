package bgs.application

import bgs.domain.*
import cats.effect.IO
import cats.syntax.all.*
import doobie.ConnectionIO

import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.time.{Duration, Instant}
import java.util.UUID

/** 呼び出した人。資格（ブラウザセッション）から決める。 */
enum Caller:
  case Anonymous
  case Facilitator(gameId: GameId)
  case Participant(gameId: GameId, participantId: ParticipantId)

/** 冪等記録。同じキーと同じ要求の再送には、最初の応答を返す。 */
final case class IdempotentRecord(
    scope: String,
    key: String,
    requestDigest: String,
    status: Int,
    body: String
)

/** 周辺ストア（イベントに入れない値）。実装は adapter-persistence。 */
final case class PeripheralStore(
    registerJoinCode: (JoinCode, GameId) => ConnectionIO[Unit],
    findGame: JoinCode => ConnectionIO[Option[GameId]],
    saveDisplayName: (GameId, ParticipantId, DisplayName) => ConnectionIO[Unit],
    displayNames: GameId => ConnectionIO[Map[ParticipantId, String]],
    issueSession: (String, GameId, CredentialSubject, Instant) => ConnectionIO[Unit],
    resolveSession: (String, Instant) => ConnectionIO[Option[(GameId, CredentialSubject)]],
    findIdempotent: (String, String) => ConnectionIO[Option[IdempotentRecord]],
    storeIdempotent: IdempotentRecord => ConnectionIO[Unit]
)

/** 時刻・識別子・乱数の出所（ドメインは時計と乱数を持たない）。 */
final case class Generators(
    now: IO[Instant],
    uuid: IO[UUID],
    token: IO[String],
    joinCode: IO[String]
)

final case class Env(
    ports: Ports,
    peripheral: PeripheralStore,
    gen: Generators,
    sessionTtl: Duration
)

final case class Versions(game: Option[Long], session: Option[Long])

final case class CreateGameInput(finalWeek: Int, demand: List[Int], retentionDays: Option[Int])
final case class Created(gameId: GameId, facilitatorToken: String, versions: Versions)
final case class Joined(
    gameId: GameId,
    participantId: ParticipantId,
    participantToken: String,
    versions: Versions
)

enum GameStatus:
  case Preparing, Started, Ended

final case class GameStateView(
    gameId: GameId,
    sessionId: Option[GameId],
    status: GameStatus,
    commitMode: CommitMode,
    joinCode: Option[String],
    finalWeek: Option[Int],
    participantId: Option[ParticipantId],
    role: Option[Role],
    versions: Versions
)

final case class LobbyParticipantView(
    participantId: ParticipantId,
    displayName: Option[String],
    role: Option[Role]
)

final case class LobbyView(
    gameId: GameId,
    status: GameStatus,
    joinCode: String,
    commitMode: CommitMode,
    participants: List[LobbyParticipantView],
    versions: Versions
)

final case class EditorView(kind: String, displayName: Option[String], isSelf: Boolean)

final case class RoleStatusView(
    inventory: Long,
    backlog: Long,
    arrivals: Long,
    orders: Long,
    customerDemand: Option[Long],
    decision: Option[Int],
    decisionVersion: Long,
    decisionEditor: Option[EditorView]
)

final case class RoleResultView(
    role: Role,
    week: Int,
    orders: Long,
    order: Int,
    inventory: Long,
    backlog: Long,
    shipment: Long,
    cost: Long,
    cumulativeCost: Long
)

final case class SessionStateView(
    gameId: GameId,
    status: GameStatus,
    week: Int,
    submittedRoleCount: Int,
    participantId: Option[ParticipantId],
    role: Option[Role],
    finalWeek: Option[Int],
    roleStatus: Option[RoleStatusView],
    roles: Option[Map[Role, RoleStatusView]],
    results: Option[List[RoleResultView]],
    versions: Versions
)

/** ユースケース。認可（呼び出した人の確認）と、読み書きの組み立てを持ち、規則はドメインに任せる。 */
object Api:

  private val DefaultRetentionDays = 90

  def digest(value: String): String =
    MessageDigest
      .getInstance("SHA-256")
      .digest(value.getBytes(StandardCharsets.UTF_8))
      .map(b => f"${b & 0xff}%02x")
      .mkString

  private def readOnly[A](env: Env)(program: ConnectionIO[A]): IO[A] =
    env.ports.tx.run(program.map(a => Right[Nothing, A](a))).map(_.merge)

  /** 資格（トークン）から呼び出した人を決める。無い・不明・期限切れは匿名。 */
  def authenticate(env: Env)(token: Option[String]): IO[Caller] =
    token match
      case None        => IO.pure(Caller.Anonymous)
      case Some(value) =>
        env.gen.now.flatMap { now =>
          readOnly(env)(env.peripheral.resolveSession(digest(value), now)).map {
            case Some((gameId, CredentialSubject.Facilitator(_)))  => Caller.Facilitator(gameId)
            case Some((gameId, CredentialSubject.Participant(id))) => Caller.Participant(gameId, id)
            case None                                              => Caller.Anonymous
          }
        }

  private def actorFor(caller: Caller, gameId: GameId): Either[AppFailure, Actor] = caller match
    case Caller.Facilitator(g) if g == gameId    => Right(Actor.Facilitator(gameId))
    case Caller.Participant(g, p) if g == gameId => Right(Actor.Participant(p))
    case _                                       => Left(AppFailure.Unauthorized)

  def versions(env: Env)(gameId: GameId): IO[Versions] =
    for
      game <- Application.gameState(env.ports)(gameId)
      session <- Application.sessionState(env.ports)(gameId)
    yield Versions(
      Some(game.version.value).filter(_ > 0L),
      Some(session.version.value).filter(_ > 0L)
    )

  /** ゲームの作成（匿名）。設定の誤りは、項目ごとにすべて集めて返す（AC1.1.2）。 */
  def createGame(env: Env)(input: CreateGameInput): IO[Either[AppFailure, Created]] =
    for
      now <- env.gen.now
      gameUuid <- env.gen.uuid
      codeRaw <- env.gen.joinCode
      token <- env.gen.token
      result <- validateCreate(input, codeRaw) match
        case Left(failure)                          => IO.pure(Left(failure))
        case Right((settings, joinCode, retention)) =>
          val gameId = GameId(gameUuid)
          val expires = now.plus(env.sessionTtl)
          val command = GameCommand.CreateGame(
            Actor.Anonymous,
            now,
            gameId,
            joinCode,
            settings,
            retention,
            expires
          )
          Application
            .handleGameWith(env.ports)(gameId, command)(
              env.peripheral.registerJoinCode(joinCode, gameId) *>
                env.peripheral.issueSession(
                  digest(token),
                  gameId,
                  CredentialSubject.Facilitator(gameId),
                  expires
                )
            )
            .flatMap {
              case Left(failure) => IO.pure(Left(failure))
              case Right(_)      => versions(env)(gameId).map(v => Right(Created(gameId, token, v)))
            }
    yield result

  private def validateCreate(
      input: CreateGameInput,
      codeRaw: String
  ): Either[AppFailure, (GameSettings, JoinCode, RetentionDays)] =
    val settings = GameSettings.kit(input.finalWeek, input.demand, CommitMode.Manual)
    val retention = RetentionDays
      .of(input.retentionDays.getOrElse(DefaultRetentionDays))
      .toValidatedNec
    (settings, retention).tupled.toEither
      .leftMap(errors => AppFailure.Invalid(errors.toNonEmptyList.toList))
      .flatMap { (s, r) =>
        JoinCode
          .of(codeRaw)
          .leftMap(e => AppFailure.Persistence(e.toString))
          .map(code => (s, code, r))
      }

  /** 参加コードで参加する。コードが無効（不明・形式不正）なら、区別せず `game.invitation_invalid`（AC1.2.2）。 */
  def joinGame(
      env: Env
  )(joinCodeRaw: String, displayNameRaw: String): IO[Either[AppFailure, Joined]] =
    DisplayName.of(displayNameRaw) match
      case Left(error)        => IO.pure(Left(AppFailure.Invalid(List(error))))
      case Right(displayName) =>
        JoinCode.of(joinCodeRaw) match
          case Left(_)         => IO.pure(Left(AppFailure.Domain(GameError.InvitationInvalid)))
          case Right(joinCode) =>
            readOnly(env)(env.peripheral.findGame(joinCode)).flatMap {
              case None         => IO.pure(Left(AppFailure.Domain(GameError.InvitationInvalid)))
              case Some(gameId) => doJoin(env)(gameId, displayName)
            }

  private def doJoin(
      env: Env
  )(gameId: GameId, displayName: DisplayName): IO[Either[AppFailure, Joined]] =
    for
      now <- env.gen.now
      participantUuid <- env.gen.uuid
      token <- env.gen.token
      participantId = ParticipantId(participantUuid)
      expires = now.plus(env.sessionTtl)
      command = GameCommand.JoinGame(Actor.Anonymous, now, participantId, displayName, expires)
      result <- Application
        .handleGameWith(env.ports)(gameId, command)(
          env.peripheral.saveDisplayName(gameId, participantId, displayName) *>
            env.peripheral.issueSession(
              digest(token),
              gameId,
              CredentialSubject.Participant(participantId),
              expires
            )
        )
        .flatMap {
          case Left(failure) => IO.pure(Left(failure))
          case Right(_)      =>
            versions(env)(gameId).map(v => Right(Joined(gameId, participantId, token, v)))
        }
    yield result

  def assignRole(env: Env)(
      caller: Caller,
      gameId: GameId,
      participantId: ParticipantId,
      role: Role
  ): IO[Either[AppFailure, Versions]] =
    withActor(env)(caller, gameId) { (actor, now) =>
      Application.handleGame(env.ports)(
        gameId,
        GameCommand.AssignRole(actor, now, participantId, role)
      )
    }

  def startGame(env: Env)(caller: Caller, gameId: GameId): IO[Either[AppFailure, Versions]] =
    withActor(env)(caller, gameId) { (actor, now) =>
      Application.startGame(env.ports)(gameId, StartGame(actor, now))
    }

  /** 当週の数量を保存する。入力する役割は資格から決まる（本文に役割を持たない）。 */
  def saveDecision(env: Env)(
      caller: Caller,
      gameId: GameId,
      week: Int,
      quantity: Int,
      expectedVersion: Long
  ): IO[Either[AppFailure, Versions]] =
    val parsed =
      (Week.of(week).toValidatedNec, Quantity.of(quantity).toValidatedNec).tupled.toEither
        .leftMap(errors => AppFailure.Invalid(errors.toNonEmptyList.toList))
    parsed match
      case Left(failure) => IO.pure(Left(failure))
      case Right((w, q)) =>
        caller match
          case Caller.Participant(g, participantId) if g == gameId =>
            Application.gameState(env.ports)(gameId).flatMap { state =>
              val role = state.dataOrNone.flatMap(_.participants.get(participantId)).flatten
              role match
                case None    => IO.pure(Left(AppFailure.Unauthorized))
                case Some(r) =>
                  withActor(env)(caller, gameId) { (actor, now) =>
                    Application.handleSession(env.ports)(
                      gameId,
                      SessionCommand
                        .SaveDecision(actor, now, r, w, q, DecisionVersion.of(expectedVersion))
                    )
                  }
            }
          case _ => IO.pure(Left(AppFailure.Unauthorized))

  def commitWeek(env: Env)(
      caller: Caller,
      gameId: GameId,
      requestedWeek: Int,
      basis: RoleMap[Long]
  ): IO[Either[AppFailure, Versions]] =
    Week.of(requestedWeek) match
      case Left(error) => IO.pure(Left(AppFailure.Invalid(List(error))))
      case Right(week) =>
        withActor(env)(caller, gameId) { (actor, now) =>
          Application.handleSession(env.ports)(
            gameId,
            SessionCommand.CommitWeek(actor, now, week, basis.map((_, v) => DecisionVersion.of(v)))
          )
        }

  /** 呼び出した人を確認し、現在の時刻でコマンドを実行して、追記後の版を返す。 */
  private def withActor(env: Env)(caller: Caller, gameId: GameId)(
      run: (Actor, Instant) => IO[Either[AppFailure, Unit]]
  ): IO[Either[AppFailure, Versions]] =
    actorFor(caller, gameId) match
      case Left(failure) => IO.pure(Left(failure))
      case Right(actor)  =>
        env.gen.now.flatMap { now =>
          run(actor, now).flatMap {
            case Left(failure) => IO.pure(Left(failure))
            case Right(_)      => versions(env)(gameId).map(Right(_))
          }
        }

  private def statusOf(game: GameState, session: SessionState): GameStatus = (game, session) match
    case (_, SessionState.Ended(_, _))  => GameStatus.Ended
    case (GameState.Started(_, _), _)   => GameStatus.Started
    case (GameState.Preparing(_, _), _) => GameStatus.Preparing
    case (GameState.NotCreated, _)      => GameStatus.Preparing

  /** ゲームの状態。呼び出した人ごとの投影（進行役は参加コードと最終週、参加者は自分の ID と役割）。 */
  def gameStateView(
      env: Env
  )(caller: Caller, gameId: GameId): IO[Either[AppFailure, GameStateView]] =
    actorFor(caller, gameId) match
      case Left(failure) => IO.pure(Left(failure))
      case Right(_)      =>
        for
          game <- Application.gameState(env.ports)(gameId)
          session <- Application.sessionState(env.ports)(gameId)
          v <- versions(env)(gameId)
        yield game.dataOrNone match
          case None       => Left(AppFailure.Unauthorized)
          case Some(data) =>
            val own = caller match
              case Caller.Participant(_, p) => Some(p)
              case _                        => None
            Right(
              GameStateView(
                gameId = gameId,
                sessionId = Some(gameId).filter(_ => session != SessionState.NotStarted),
                status = statusOf(game, session),
                commitMode = data.settings.commitMode,
                joinCode = Some(data.joinCode.value).filter(_ => own.isEmpty),
                finalWeek = Some(data.settings.finalWeek.value).filter(_ => own.isEmpty),
                participantId = own,
                role = own.flatMap(p => data.participants.get(p).flatten),
                versions = v
              )
            )

  /** ロビー（進行役だけ）。 */
  def lobbyView(env: Env)(caller: Caller, gameId: GameId): IO[Either[AppFailure, LobbyView]] =
    caller match
      case Caller.Facilitator(g) if g == gameId =>
        for
          game <- Application.gameState(env.ports)(gameId)
          session <- Application.sessionState(env.ports)(gameId)
          names <- readOnly(env)(env.peripheral.displayNames(gameId))
          v <- versions(env)(gameId)
        yield game.dataOrNone match
          case None       => Left(AppFailure.Unauthorized)
          case Some(data) =>
            Right(
              LobbyView(
                gameId,
                statusOf(game, session),
                data.joinCode.value,
                data.settings.commitMode,
                data.participants.toList.map((id, role) =>
                  LobbyParticipantView(id, names.get(id), role)
                ),
                v
              )
            )
      case _ => IO.pure(Left(AppFailure.Unauthorized))

  private def roleStatus(
      data: SessionData,
      role: Role,
      names: Map[ParticipantId, String],
      showNames: Boolean,
      self: Option[ParticipantId]
  ): RoleStatusView =
    val state = data.roleStates(role)
    val entry = data.decisions.get(role)
    RoleStatusView(
      inventory = state.inventory.value,
      backlog = state.backlog.value,
      arrivals = state.arrivals.value,
      orders = state.orders.value,
      customerDemand = Some(state.orders.value).filter(_ => role.downstream.isEmpty),
      decision = entry.map(_.quantity.value),
      decisionVersion = data.decisionVersions(role).value,
      decisionEditor = entry.map { e =>
        e.editor match
          case Editor.ByParticipant(id) =>
            EditorView(
              "PARTICIPANT",
              if showNames || self.contains(id) then names.get(id) else None,
              self.contains(id)
            )
          case Editor.ByFacilitator(_) => EditorView("FACILITATOR_PROXY", None, false)
      }
    )

  /** セッションの状態。参加者は自分の役割だけ、進行役は全役割と確定した週の結果。 */
  def sessionStateView(
      env: Env
  )(
      caller: Caller,
      gameId: GameId,
      requestedRole: Option[Role]
  ): IO[Either[AppFailure, SessionStateView]] =
    actorFor(caller, gameId) match
      case Left(failure) => IO.pure(Left(failure))
      case Right(_)      =>
        for
          game <- Application.gameState(env.ports)(gameId)
          sessionRead <- readOnly(env)(env.ports.sessionStore.read(gameId))
          names <- readOnly(env)(env.peripheral.displayNames(gameId))
          v <- versions(env)(gameId)
        yield
          val session =
            sessionRead.events.foldLeft[SessionState](SessionState.NotStarted)(SessionEvents.apply)
          val data = session match
            case SessionState.Active(d, _) => Some(d)
            case SessionState.Ended(d, _)  => Some(d)
            case SessionState.NotStarted   => None
          data match
            case None    => Left(AppFailure.Domain(SessionError.NotActive))
            case Some(d) =>
              val results =
                sessionRead.events.collect { case e: SessionEvent.WeekCommitted => e }.flatMap {
                  e =>
                    Role.values.toList.map { role =>
                      val r = e.results(role)
                      RoleResultView(
                        role,
                        e.week.value,
                        r.orders.value,
                        r.ordered.value,
                        r.endingInventory.value,
                        r.endingBacklog.value,
                        r.shipped.value,
                        r.weeklyCost.minor,
                        r.cumulativeCost.minor
                      )
                    }
                }
              val submitted = d.decisions.size
              val status = statusOf(game, session)
              caller match
                case Caller.Facilitator(_) =>
                  Right(
                    SessionStateView(
                      gameId,
                      status,
                      d.week.value,
                      submitted,
                      None,
                      None,
                      Some(d.settings.finalWeek.value),
                      None,
                      Some(
                        Role.values.toList.map(r => r -> roleStatus(d, r, names, true, None)).toMap
                      ),
                      Some(results),
                      v
                    )
                  )
                case Caller.Participant(_, p) =>
                  val own = game.dataOrNone.flatMap(_.participants.get(p)).flatten
                  own match
                    case None => Left(AppFailure.Unauthorized)
                    case Some(role) if requestedRole.exists(_ != role) =>
                      Left(AppFailure.Unauthorized)
                    case Some(role) =>
                      Right(
                        SessionStateView(
                          gameId,
                          status,
                          d.week.value,
                          submitted,
                          Some(p),
                          Some(role),
                          None,
                          Some(roleStatus(d, role, names, false, Some(p))),
                          None,
                          None,
                          v
                        )
                      )
                case Caller.Anonymous => Left(AppFailure.Unauthorized)
