package bgs.application

import bgs.domain.GameId
import cats.effect.IO
import cats.syntax.all.*

import java.time.Duration

/** 保持期限後の削除（B11。AC5.1.2〜5.1.3）。期限に達したゲームを、1 件ずつ、1 つのトランザクションで削除する。
  * 失敗したら何も消さず、指数バックオフで再試行する。[[MaxAttempts]] 回失敗したら、再試行をやめて通知する。
  */
object RetentionJob:

  /** 再試行の上限（契約）。 */
  val MaxAttempts: Int = 5

  /** 再試行の間隔: 1 時間 × 2^(試行 − 1)（仮置き。未計測）。 */
  def backoff(attempt: Int): Duration = Duration.ofHours(1L << (attempt - 1).max(0).min(10))

  /** 1 回の処理。削除が完了したゲームの数を返す。時計は [[Env.gen]] から取る（試験では差し替える）。 */
  def runOnce(env: Env)(abandoned: GameId => IO[Unit]): IO[Int] =
    for
      now <- env.gen.now
      due <- env.ports.tx
        .run(env.peripheral.dueRetention(now).map(ids => Right[Nothing, List[GameId]](ids)))
        .map(_.merge)
      done <- due.traverse(deleteOne(env, now, abandoned))
    yield done.sum

  private def deleteOne(env: Env, now: java.time.Instant, abandoned: GameId => IO[Unit])(
      gameId: GameId
  ): IO[Int] =
    env.ports.tx
      .run(env.peripheral.deleteGame(gameId, now).map(_ => Right[Nothing, Unit](())))
      .attempt
      .flatMap {
        case Right(_) => IO.pure(1)
        case Left(_)  => recordFailure(env, now, abandoned)(gameId).as(0)
      }

  private def recordFailure(env: Env, now: java.time.Instant, abandoned: GameId => IO[Unit])(
      gameId: GameId
  ): IO[Unit] =
    for
      row <- env.ports.tx
        .run(env.peripheral.retentionOf(gameId).map(r => Right[Nothing, Option[RetentionRow]](r)))
        .map(_.merge)
      attempt = row.fold(1)(_.attempt + 1)
      giveUp = attempt >= MaxAttempts
      next = if giveUp then None else Some(now.plus(backoff(attempt)))
      _ <- env.ports.tx.run(
        env.peripheral
          .recordRetentionFailure(gameId, attempt, next, "deletion_failed", giveUp)
          .map(_ => Right[Nothing, Unit](()))
      )
      _ <- if giveUp then abandoned(gameId) else IO.unit
    yield ()
