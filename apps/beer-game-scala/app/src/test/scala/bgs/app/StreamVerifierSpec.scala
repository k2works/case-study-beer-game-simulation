package bgs.app

import bgs.application.*
import bgs.domain.*
import bgs.domain.DomainFixtures.*
import cats.effect.IO
import doobie.implicits.*
import munit.CatsEffectSuite

/** ストリームの整合の検査（B12。NF-R15）。投影表を持たないので、イベントの列そのものを検査する。 */
class StreamVerifierSpec extends CatsEffectSuite:

  private def env: IO[Env] = Wiring.inMemoryH2

  private def createGame(e: Env): IO[GameId] =
    Api
      .createGame(e)(
        CreateGameInput(12, List.fill(12)(4), None, false, None, CommitMode.Manual, Nil)
      )
      .map(_.fold(f => fail(f.toString), _.gameId))

  private def run[A](e: Env)(program: doobie.ConnectionIO[A]): IO[A] =
    e.ports.tx.run(program.map(a => Right[Nothing, A](a))).map(_.merge)

  test("[NF-R15] 作成しただけのゲームは、不一致 0 件。検査は何も変えない") {
    for
      e <- env
      _ <- createGame(e)
      before <- run(e)(sql"select count(*) from events".query[Long].unique)
      found <- StreamVerifier.verify(e)
      after <- run(e)(sql"select count(*) from events".query[Long].unique)
    yield
      assertEquals(found, Nil)
      assertEquals(after, before)
  }

  test("[NF-R15] イベントの版が欠けると、版の食い違いを報告する") {
    for
      e <- env
      id <- createGame(e)
      _ <- Api.joinGame(e)("DUMMYCODE", "x") // 失敗する参加（イベントは増えない）
      // 2 つ目のイベントを足してから、1 つ目を消して欠落を作る
      _ <- e.ports.tx.run(
        e.ports.gameStore
          .append(
            id,
            StreamVersion.of(1),
            List(GameEvent.ParticipantJoined(participantId(1), expiresAt)),
            at
          )
      )
      _ <- run(e)(
        sql"delete from events where stream_type = 'game' and stream_version = 1".update.run
      )
      found <- StreamVerifier.verify(e)
    yield assert(
      found.exists(m => m.gameId == id && m.stream == "game" && m.detail.contains("版")),
      found.toString
    )
  }

  test("[NF-R15] 不正な遷移を含むストリームを報告する") {
    for
      e <- env
      id <- createGame(e)
      // 開始前の session に、終了のイベントを直接書く（decide を通さない）
      _ <- e.ports.tx.run(
        e.ports.sessionStore.append(id, StreamVersion.Zero, List(SessionEvent.SessionPaused), at)
      )
      found <- StreamVerifier.verify(e)
    yield assert(found.exists(m => m.gameId == id && m.stream == "session"), found.toString)
  }

  test("[NF-R15] session があるのに game が開始されていなければ、食い違いを報告する") {
    for
      e <- env
      id <- createGame(e)
      started = Start
        .decide(fullGame, SessionState.NotStarted, StartGame(facilitator, at))
        .fold(err => fail(err.toString), _.session)
      _ <- e.ports.tx.run(e.ports.sessionStore.append(id, StreamVersion.Zero, started, at))
      found <- StreamVerifier.verify(e)
    yield assert(found.exists(m => m.gameId == id && m.detail.contains("開始")), found.toString)
  }
