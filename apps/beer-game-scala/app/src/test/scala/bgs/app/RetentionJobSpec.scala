package bgs.app

import bgs.application.*
import bgs.domain.*
import cats.effect.{IO, Ref}
import munit.CatsEffectSuite

import java.time.{Duration, Instant}

/** 保持期限後の削除（AC5.1.2〜5.1.3）。時計と削除の失敗を注入して、再試行の動作を決定論的に確かめる。 */
class RetentionJobSpec extends CatsEffectSuite:

  private final case class Fixture(env: Env, offset: Ref[IO, Duration], abandoned: Ref[IO, Int])

  private def fixture: IO[Fixture] =
    for
      base <- Wiring.inMemoryH2
      offset <- Ref.of[IO, Duration](Duration.ZERO)
      abandoned <- Ref.of[IO, Int](0)
    yield Fixture(
      base.copy(gen = base.gen.copy(now = offset.get.map(Instant.now.plus(_)))),
      offset,
      abandoned
    )

  private def create(env: Env, days: Int): IO[GameId] =
    Api
      .createGame(env)(
        CreateGameInput(12, List.fill(12)(4), Some(days), false, None, CommitMode.Manual, Nil)
      )
      .map(_.fold(f => fail(f.toString), _.gameId))

  private def retention(env: Env, id: GameId): IO[Option[RetentionRow]] =
    env.ports.tx
      .run(env.peripheral.retentionOf(id).map(r => Right[Nothing, Option[RetentionRow]](r)))
      .map(_.toOption.flatten)

  private def advance(f: Fixture, d: Duration): IO[Unit] = f.offset.update(_.plus(d))

  /** 1 回の削除処理。[[fail]] が真なら、この回の削除の処理を失敗させる。 */
  private def run(f: Fixture, failThisRun: Boolean = false): IO[Int] =
    val env =
      if failThisRun then
        f.env.copy(peripheral =
          f.env.peripheral.copy(deleteGame =
            (_, _) => doobie.free.connection.raiseError(new java.sql.SQLException("失敗"))
          )
        )
      else f.env
    RetentionJob.runOnce(env)(_ => f.abandoned.update(_ + 1))

  test("[AC5.1.2] 期限前は削除せず、期限後に削除する。別のゲームは巻き込まない") {
    for
      f <- fixture
      early <- create(f.env, 1)
      late <- create(f.env, 30)
      none <- run(f)
      _ <- advance(f, Duration.ofDays(2))
      one <- run(f)
      earlyRow <- retention(f.env, early)
      lateRow <- retention(f.env, late)
    yield
      assertEquals(none, 0)
      assertEquals(one, 1)
      assertEquals(earlyRow, None)
      assert(lateRow.isDefined)
  }

  test("[AC5.1.3] 失敗したら何も消さず、バックオフ後に再試行して一度だけ削除する") {
    for
      f <- fixture
      id <- create(f.env, 1)
      _ <- advance(f, Duration.ofDays(2))
      failed <- run(f, failThisRun = true)
      afterFail <- retention(f.env, id)
      _ <- advance(f, Duration.ofMinutes(1))
      tooEarly <- run(f)
      _ <- advance(f, Duration.ofDays(1))
      done <- run(f)
      again <- run(f)
    yield
      assertEquals(failed, 0)
      assertEquals(afterFail.map(r => (r.status, r.attempt)), Some(("RETRY_PENDING", 1)))
      assertEquals(tooEarly, 0)
      assertEquals(done, 1)
      assertEquals(again, 0)
  }

  test("[AC5.1.3] 5 回失敗したら再試行をやめ、通知する（1 回だけ）") {
    for
      f <- fixture
      id <- create(f.env, 1)
      _ <- advance(f, Duration.ofDays(2))
      _ <- (1 to 7).toList.foldLeft(IO.unit) { (acc, _) =>
        acc *> run(f, failThisRun = true).void *> advance(f, Duration.ofDays(1))
      }
      row <- retention(f.env, id)
      notified <- f.abandoned.get
    yield
      assertEquals(notified, 1)
      assertEquals(row.map(r => (r.status, r.attempt)), Some(("ABANDONED", 5)))
  }

  test("[バックオフ] 1 時間 × 2^(試行 − 1)") {
    assertEquals(RetentionJob.backoff(1), Duration.ofHours(1))
    assertEquals(RetentionJob.backoff(3), Duration.ofHours(4))
  }
