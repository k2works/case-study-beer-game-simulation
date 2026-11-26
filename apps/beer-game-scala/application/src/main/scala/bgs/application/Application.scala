package bgs.application

import bgs.domain.*
import cats.data.EitherT
import cats.effect.IO
import cats.syntax.all.*
import doobie.ConnectionIO

/** アプリケーション層が使うポート。実装は adapter-persistence（`app` が組み立てる）。 */
final case class Ports(
    gameStore: EventStore[GameEvent],
    sessionStore: EventStore[SessionEvent],
    tx: Tx,
    /** 追記の競合を再試行する回数の上限（初回を含む）。 */
    maxAttempts: Int
)

/** コマンド処理。読む → 決める（純粋）→ 追記する、を 1 つのトランザクションで行い、追記の競合は読み直して再試行する。 規則は持たない（規則はドメインの `handle`）。業務の失敗は
  * `AppFailure.Domain` で返し、何も追記しない。
  */
object Application:

  private def gameStateOf(read: StreamRead[GameEvent]): GameState =
    read.events.foldLeft[GameState](GameState.NotCreated)(GameEvents.apply)

  private def sessionStateOf(read: StreamRead[SessionEvent]): SessionState =
    read.events.foldLeft[SessionState](SessionState.NotStarted)(SessionEvents.apply)

  /** 追記の競合（`ConcurrencyConflict`）は、読み直して再実行する。上限に達したら `RetryExhausted`。 */
  private def retrying[A](ports: Ports)(
      program: ConnectionIO[Either[AppFailure, A]]
  ): IO[Either[AppFailure, A]] =
    def attempt(count: Int): IO[Either[AppFailure, A]] =
      ports.tx.run(program).flatMap {
        case Left(AppFailure.ConcurrencyConflict) if count < ports.maxAttempts => attempt(count + 1)
        case Left(AppFailure.ConcurrencyConflict) => IO.pure(Left(AppFailure.RetryExhausted))
        case other                                => IO.pure(other)
      }
    attempt(1)

  /** ゲームの作成（匿名の操作者）。 */
  def createGame(ports: Ports)(command: GameCommand.CreateGame): IO[Either[AppFailure, Unit]] =
    handleGame(ports)(command.gameId, command)

  /** `game` ストリームのコマンド（参加・割り当てなど）。 */
  def handleGame(
      ports: Ports
  )(gameId: GameId, command: GameCommand): IO[Either[AppFailure, Unit]] =
    retrying(ports)(
      (for
        read <- EitherT.right[AppFailure](ports.gameStore.read(gameId))
        events <- EitherT.fromEither[ConnectionIO](
          Game.handle(gameStateOf(read), command).leftMap(AppFailure.Domain(_))
        )
        _ <- EitherT(ports.gameStore.append(gameId, read.version, events, command.at))
      yield ()).value
    )

  /** `session` ストリームのコマンド（入力の保存・確定）。 */
  def handleSession(
      ports: Ports
  )(gameId: GameId, command: SessionCommand): IO[Either[AppFailure, Unit]] =
    retrying(ports)(
      (for
        read <- EitherT.right[AppFailure](ports.sessionStore.read(gameId))
        events <- EitherT.fromEither[ConnectionIO](
          Session.handle(sessionStateOf(read), command).leftMap(AppFailure.Domain(_))
        )
        _ <- EitherT(ports.sessionStore.append(gameId, read.version, events, command.at))
      yield ()).value
    )

  /** 開始。`game` と `session` の 2 ストリームへ、同一トランザクションで追記する（どちらかが競合なら両方残らない）。 */
  def startGame(
      ports: Ports
  )(gameId: GameId, command: StartGame): IO[Either[AppFailure, Unit]] =
    retrying(ports)(
      (for
        gameRead <- EitherT.right[AppFailure](ports.gameStore.read(gameId))
        sessionRead <- EitherT.right[AppFailure](ports.sessionStore.read(gameId))
        decision <- EitherT.fromEither[ConnectionIO](
          Start
            .decide(gameStateOf(gameRead), sessionStateOf(sessionRead), command)
            .leftMap(AppFailure.Domain(_))
        )
        _ <- EitherT(ports.gameStore.append(gameId, gameRead.version, decision.game, command.at))
        _ <- EitherT(
          ports.sessionStore.append(gameId, sessionRead.version, decision.session, command.at)
        )
      yield ()).value
    )

  /** 現在の `game` の状態（イベントの再生で復元する）。 */
  def gameState(ports: Ports)(gameId: GameId): IO[GameState] =
    ports.tx
      .run(ports.gameStore.read(gameId).map(read => Right[Nothing, GameState](gameStateOf(read))))
      .map(_.merge)

  /** 現在の `session` の状態（イベントの再生で復元する）。 */
  def sessionState(ports: Ports)(gameId: GameId): IO[SessionState] =
    ports.tx
      .run(
        ports.sessionStore
          .read(gameId)
          .map(read => Right[Nothing, SessionState](sessionStateOf(read)))
      )
      .map(_.merge)
