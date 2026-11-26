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

  /** decide が作らない列（不正な遷移）を含むストリームは、止まったゲーム（N-H7）。**書き込みは拒否し**（`Persistence`。 HTTP は 500 と相関
    * ID）、状態の取得（読み取り）は、そのまま返す。ほかのゲームは影響を受けない。
    */
  private def stopped(invalid: List[InvalidTransition]): Either[AppFailure, Unit] =
    Either.cond(
      invalid.isEmpty,
      (),
      AppFailure.Persistence(
        s"不正な遷移を含むストリーム: ${invalid.map(i => s"${i.stateName}/${i.eventType}").mkString(",")}"
      )
    )

  private def runningGame(read: StreamRead[GameEvent]): Either[AppFailure, GameState] =
    val replayed = Replay.game(read.events)
    stopped(replayed.invalid).map(_ => replayed.state)

  private def runningSession(read: StreamRead[SessionEvent]): Either[AppFailure, SessionState] =
    val replayed = Replay.session(read.events)
    stopped(replayed.invalid).map(_ => replayed.state)

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
    handleGameWith(ports)(gameId, command)(().pure[ConnectionIO])

  /** `game` ストリームのコマンドに、周辺ストアへの書き込み（参加コードの索引・表示名・資格など）を同じトランザクションで足す。 追記が成功したときだけ [[extra]]
    * を実行し、競合で再試行するときは、その回の書き込みごと巻き戻る。
    */
  def handleGameWith(
      ports: Ports
  )(gameId: GameId, command: GameCommand)(
      extra: ConnectionIO[Unit]
  ): IO[Either[AppFailure, Unit]] =
    retrying(ports)(
      (for
        read <- EitherT.right[AppFailure](ports.gameStore.read(gameId))
        events <- EitherT.fromEither[ConnectionIO](
          runningGame(read).flatMap(Game.handle(_, command).leftMap(AppFailure.Domain(_)))
        )
        _ <- EitherT(ports.gameStore.append(gameId, read.version, events, command.at))
        _ <- EitherT.right[AppFailure](extra)
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
          runningSession(read).flatMap(Session.handle(_, command).leftMap(AppFailure.Domain(_)))
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
          for
            game <- runningGame(gameRead)
            session <- runningSession(sessionRead)
            decided <- Start.decide(game, session, command).leftMap(AppFailure.Domain(_))
          yield decided
        )
        _ <- EitherT(ports.gameStore.append(gameId, gameRead.version, decision.game, command.at))
        _ <- EitherT(
          ports.sessionStore.append(gameId, sessionRead.version, decision.session, command.at)
        )
      yield ()).value
    )

  /** 役割の割り当て。準備中は `game` だけ、開始後（入れ替え）は `game` と `session` へ同一トランザクションで追記する。 失効した資格（入れ替えられた担当者）ごとに、
    * [[onRevoked]] を同じトランザクションで実行する（ブラウザセッション・復帰資格の失効）。
    */
  def assignRole(
      ports: Ports
  )(gameId: GameId, command: GameCommand.AssignRole)(
      onRevoked: ParticipantId => ConnectionIO[Unit]
  ): IO[Either[AppFailure, Unit]] =
    retrying(ports)(
      (for
        gameRead <- EitherT.right[AppFailure](ports.gameStore.read(gameId))
        sessionRead <- EitherT.right[AppFailure](ports.sessionStore.read(gameId))
        decision <- EitherT.fromEither[ConnectionIO](
          for
            game <- runningGame(gameRead)
            session <- runningSession(sessionRead)
            decided <- Replace.decide(game, session, command).leftMap(AppFailure.Domain(_))
          yield decided
        )
        _ <- EitherT(ports.gameStore.append(gameId, gameRead.version, decision.game, command.at))
        _ <-
          if decision.session.isEmpty then EitherT.rightT[ConnectionIO, AppFailure](())
          else
            EitherT(
              ports.sessionStore
                .append(gameId, sessionRead.version, decision.session, command.at)
                .map(_.void)
            )
        _ <- EitherT.right[AppFailure](
          decision.game
            .collect { case GameEvent.CredentialRevoked(id) => id }
            .traverse_(onRevoked)
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
