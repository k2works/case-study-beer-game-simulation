package bgs.app

import bgs.adapter.persistence.{DoobieEventStore, Migrations, Transactions}
import bgs.application.*
import bgs.domain.*
import bgs.domain.DomainFixtures.*
import cats.effect.IO
import cats.syntax.all.*
import doobie.*
import munit.CatsEffectSuite

import java.util.UUID

/** アプリケーション層（実 H2 に、実際のアダプターをつないで確かめる）。再試行、2 ストリームの開始、一連の進行。 */
class ApplicationSpec extends CatsEffectSuite:

  private def freshPorts(maxAttempts: Int): IO[Ports] =
    val url =
      s"jdbc:h2:mem:${UUID.randomUUID.toString};MODE=PostgreSQL;DATABASE_TO_LOWER=TRUE;DB_CLOSE_DELAY=-1"
    Migrations
      .migrate(url, "sa", "")
      .as(
        Ports(
          DoobieEventStore.game,
          DoobieEventStore.session,
          Transactions
            .writeTx(Transactor.fromDriverManager[IO]("org.h2.Driver", url, "sa", "", None)),
          maxAttempts
        )
      )

  private def ok[A](result: IO[Either[AppFailure, A]]): IO[A] =
    result.flatMap(_.fold(f => IO.raiseError(new AssertionError(s"失敗: $f")), IO.pure))

  /** 作成 → 4 人が参加して割り当て → 開始まで済ませる。 */
  private def started(ports: Ports): IO[Unit] =
    for
      _ <- ok(Application.createGame(ports)(create))
      _ <- Role.values.toList.traverse_ { role =>
        ok(Application.handleGame(ports)(gameId, join(role.ordinal + 1))) *>
          ok(Application.handleGame(ports)(gameId, assign(role.ordinal + 1, role)))
      }
      _ <- ok(Application.startGame(ports)(gameId, StartGame(facilitator, at)))
    yield ()

  private def save(role: Role, n: Int) =
    SessionCommand.SaveDecision(
      Actor.Participant(holder(role)),
      at,
      role,
      week(1),
      quantity(n),
      DecisionVersion.of(0L)
    )

  test("[AC1.2.3] 開始は、game と session の 2 ストリームへ追記され、セッションが第 1 週で始まる") {
    for
      ports <- freshPorts(10)
      _ <- started(ports)
      game <- Application.gameState(ports)(gameId)
      session <- Application.sessionState(ports)(gameId)
    yield
      assert(game.isInstanceOf[GameState.Started])
      session match
        case SessionState.Active(data, _) => assertEquals(data.week.value, 1)
        case other                        => fail(s"進行中のはず: $other")
  }

  test("[AC2.3.1] 4 役割が保存して、進行役が確定すると、第 2 週になる") {
    for
      ports <- freshPorts(10)
      _ <- started(ports)
      _ <- Role.values.toList.traverse_(role =>
        ok(Application.handleSession(ports)(gameId, save(role, 4)))
      )
      session <- Application.sessionState(ports)(gameId)
      basis = session match
        case SessionState.Active(data, _) => data.decisionVersions
        case other                        => fail(s"進行中のはず: $other")
      _ <- ok(
        Application.handleSession(ports)(
          gameId,
          SessionCommand.CommitWeek(facilitator, at, week(1), basis)
        )
      )
      after <- Application.sessionState(ports)(gameId)
    yield after match
      case SessionState.Active(data, _) => assertEquals(data.week.value, 2)
      case other                        => fail(s"進行中のはず: $other")
  }

  test("[競合の再試行] 4 役割の保存が同時に来ても、追記の競合を再試行して、すべて保存される") {
    for
      ports <- freshPorts(20)
      _ <- started(ports)
      results <- Role.values.toList.parTraverse(role =>
        Application.handleSession(ports)(gameId, save(role, 4))
      )
      session <- Application.sessionState(ports)(gameId)
    yield
      assertEquals(results.count(_.isRight), 4)
      session match
        case SessionState.Active(data, _) => assertEquals(data.decisions.size, 4)
        case other                        => fail(s"進行中のはず: $other")
  }

  test("[業務の失敗] 業務ルール違反は AppFailure.Domain で返り、何も追記されない") {
    for
      ports <- freshPorts(10)
      _ <- ok(Application.createGame(ports)(create))
      result <- Application.createGame(ports)(create) // 二重の作成
      game <- Application.gameState(ports)(gameId)
    yield
      assertEquals(result, Left(AppFailure.Domain(GameError.AlreadyCreated)))
      assertEquals(game.version.value, 1L)
  }

  test("[RetryExhausted] 追記の競合が上限まで続くと RetryExhausted になる") {
    for
      base <- freshPorts(3)
      alwaysConflict = base.copy(
        gameStore = base.gameStore.copy(append =
          (_, _, _, _) =>
            (Left(AppFailure.ConcurrencyConflict): Either[AppFailure, StreamVersion])
              .pure[ConnectionIO]
        )
      )
      result <- Application.createGame(alwaysConflict)(create)
    yield assertEquals(result, Left(AppFailure.RetryExhausted))
  }

  test("[AC1.2.3] 参加者のいない役割があると、開始は業務の失敗で、どのストリームにも追記しない") {
    for
      ports <- freshPorts(10)
      _ <- ok(Application.createGame(ports)(create))
      result <- Application.startGame(ports)(gameId, StartGame(facilitator, at))
      session <- Application.sessionState(ports)(gameId)
    yield
      assert(result.left.exists {
        case AppFailure.Domain(_: GameError.StartConditionNotMet) => true
        case _                                                    => false
      })
      assertEquals(session, SessionState.NotStarted)
  }
