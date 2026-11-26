package bgs.adapter.persistence

import bgs.application.{AppFailure, EventStore, StreamRead, Tx}
import bgs.domain.*
import bgs.domain.DomainFixtures.*
import cats.data.EitherT
import cats.effect.IO
import cats.syntax.all.*
import doobie.*
import doobie.implicits.*
import munit.CatsEffectSuite

/** イベントストアのポートの契約テスト。H2（ローカル開発）と PostgreSQL（Testcontainers）の両実装で、同じテストを実行する。
  * 版の一意制約による楽観的並行制御、`Left` での ROLLBACK（K5）、2 ストリームの原子的な追記、JSON の往復を確かめる。
  */
abstract class EventStoreContract extends CatsEffectSuite:

  /** テストごとに、マイグレーション済みの新しいデータベースの Transactor を返す。 */
  protected def freshTransactor: IO[Transactor[IO]]

  private val games: EventStore[GameEvent] = DoobieEventStore.game
  private val sessions: EventStore[SessionEvent] = DoobieEventStore.session

  private val created: GameEvent =
    GameEvent.GameCreated(gameId, joinCode, settings(), retention, expiresAt)
  private val joined: GameEvent = GameEvent.ParticipantJoined(participantId(1), expiresAt)

  private def tx(xa: Transactor[IO]): Tx = Transactions.writeTx(xa)

  private def appendGame(expected: Long, events: List[GameEvent]) =
    games.append(gameId, StreamVersion.of(expected), events, at)

  test("[版] 空のストリームへ期待する版 0 で追記すると、版が追記した件数になり、読み戻せる") {
    freshTransactor.flatMap { xa =>
      val program = for
        appended <- appendGame(0L, List(created, joined))
        read <- games.read(gameId)
      yield appended.map(version => (version.value, read))
      tx(xa).run(program).map {
        case Right((version, read)) =>
          assertEquals(version, 2L)
          assertEquals(read.version.value, 2L)
          assertEquals(read.events, List(created, joined))
        case Left(failure) => fail(s"追記できるはず: $failure")
      }
    }
  }

  test("[楽観的並行制御] 期待する版が古いと ConcurrencyConflict になり、ストリームは変わらない") {
    freshTransactor.flatMap { xa =>
      for
        _ <- tx(xa).run(appendGame(0L, List(created)))
        stale <- tx(xa).run(appendGame(0L, List(joined)))
        read <- tx(xa).run(games.read(gameId).map(r => Right[Nothing, StreamRead[GameEvent]](r)))
      yield
        assertEquals(stale, Left(AppFailure.ConcurrencyConflict))
        assertEquals(read.map(_.version.value), Right(1L))
    }
  }

  test("[AC2.3.3 並行] 同じ版への 8 本の同時の追記は、1 本だけが成功し、残りは ConcurrencyConflict") {
    freshTransactor.flatMap { xa =>
      val attempt = tx(xa).run(appendGame(0L, List(created)))
      List.fill(8)(attempt).parSequence.map { results =>
        assertEquals(results.count(_.isRight), 1)
        assertEquals(results.count(_ == Left(AppFailure.ConcurrencyConflict)), 7)
      }
    }
  }

  test("[K5] 業務の失敗（Left）を返すと ROLLBACK され、追記は残らない") {
    freshTransactor.flatMap { xa =>
      val failing: ConnectionIO[Either[String, Unit]] =
        appendGame(0L, List(created)).map(_ => Left("業務の失敗"))
      for
        result <- tx(xa).run(failing)
        read <- tx(xa).run(games.read(gameId).map(r => Right[Nothing, StreamRead[GameEvent]](r)))
      yield
        assertEquals(result, Left("業務の失敗"))
        assertEquals(read.map(_.version.value), Right(0L))
    }
  }

  test("[AC2.3.3 原子性] 開始は 2 つのストリームへ同一トランザクションで追記され、片方が競合なら両方残らない") {
    freshTransactor.flatMap { xa =>
      val started = startedSession
      val sessionEvents = started match
        case SessionState.Active(data, _) =>
          List[SessionEvent](
            SessionEvent.SessionStarted(
              data.gameId,
              data.settings,
              data.assignments,
              data.roleStates,
              data.commitMode
            )
          )
        case other => fail(s"進行中のはず: $other")
      val both: ConnectionIO[Either[AppFailure, Unit]] = (for
        _ <- EitherT(games.append(gameId, StreamVersion.of(0L), List(created), at))
        _ <- EitherT(sessions.append(gameId, StreamVersion.of(5L), sessionEvents, at)) // 版が合わない
      yield ()).value
      for
        result <- tx(xa).run(both)
        game <- tx(xa).run(games.read(gameId).map(r => Right[Nothing, StreamRead[GameEvent]](r)))
      yield
        assertEquals(result, Left(AppFailure.ConcurrencyConflict))
        assertEquals(game.map(_.version.value), Right(0L))
    }
  }

  test("[往復] セッションのイベント（設定・待ち行列・結果を含む）が JSON の保存と読み戻しで同じ値になる") {
    freshTransactor.flatMap { xa =>
      val started = startedSession
      val decided = Role.values.toList.foldLeft(started) { (state, role) =>
        val save = SessionCommand.SaveDecision(
          Actor.Participant(holder(role)),
          at,
          role,
          week(1),
          quantity(4),
          DecisionVersion.of(0L)
        )
        Session
          .handle(state, save)
          .fold(e => fail(e.toString), _.foldLeft(state)(SessionEvents.apply))
      }
      val committed = decided match
        case SessionState.Active(data, _) =>
          Session
            .handle(
              decided,
              SessionCommand.CommitWeek(facilitator, at, week(1), data.decisionVersions)
            )
            .fold(e => fail(e.toString), identity)
        case other => fail(s"進行中のはず: $other")
      val startEvent = Start
        .decide(fullGame, SessionState.NotStarted, StartGame(facilitator, at))
        .fold(e => fail(e.toString), _.session)
      val all = startEvent ++ committed
      val program: ConnectionIO[Either[AppFailure, StreamRead[SessionEvent]]] = (for
        _ <- EitherT(games.append(gameId, StreamVersion.of(0L), List(created), at))
        _ <- EitherT(sessions.append(gameId, StreamVersion.of(0L), all, at))
        read <- EitherT.right[AppFailure](sessions.read(gameId))
      yield read).value
      tx(xa).run(program).map(read => assertEquals(read.map(_.events), Right(all)))
    }
  }
