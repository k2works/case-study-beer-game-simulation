package bgs.application

import bgs.domain.*
import cats.effect.IO
import cats.syntax.all.*

/** ストリームの整合の検査（B12。NF-R15）。投影表を持たない設計なので、イベントの列そのものを、読み取りだけで検査する。
  *
  *   - 版の連続: 版が 1 から欠けずに並ぶ
  *   - 再生の妥当性: 状態を変えない（不正な遷移の）イベントを含まない
  *   - game と session の整合: session があるのに game が開始されていない、は食い違い
  */
object StreamVerifier:

  /** 不一致 1 件。[[detail]] は人が読む説明（値は含めない）。 */
  final case class Mismatch(gameId: GameId, stream: String, detail: String)

  private def contiguous(versions: List[Long]): Boolean =
    versions == (1L to versions.size.toLong).toList

  private def verifyOne(env: Env)(gameId: GameId): IO[List[Mismatch]] =
    env.ports.tx
      .run(
        (env.ports.gameStore.read(gameId), env.ports.sessionStore.read(gameId))
          .mapN((g, s) => Right[Nothing, (StreamRead[GameEvent], StreamRead[SessionEvent])]((g, s)))
      )
      .map(_.merge)
      .map { (gameRead, sessionRead) =>
        val gameReplay = Replay.game(gameRead.events)
        val sessionReplay = Replay.session(sessionRead.events)
        val gameStarted = gameReplay.state match
          case GameState.Started(_, _)                          => true
          case GameState.NotCreated | GameState.Preparing(_, _) => false
        List(
          Option.when(!contiguous(gameRead.streamVersions))(
            Mismatch(gameId, "game", "イベントの版が 1 から連続していない")
          ),
          Option.when(!contiguous(sessionRead.streamVersions))(
            Mismatch(gameId, "session", "イベントの版が 1 から連続していない")
          ),
          Option.when(gameReplay.invalid.nonEmpty)(
            Mismatch(gameId, "game", s"不正な遷移を含む: ${gameReplay.invalid.size} 件")
          ),
          Option.when(sessionReplay.invalid.nonEmpty)(
            Mismatch(gameId, "session", s"不正な遷移を含む: ${sessionReplay.invalid.size} 件")
          ),
          Option.when(sessionRead.events.nonEmpty && !gameStarted)(
            Mismatch(gameId, "session", "session があるのに、game が開始されていない")
          )
        ).flatten
      }

  /** すべてのゲームを検査し、不一致の一覧を返す（無ければ空）。 */
  def verify(env: Env): IO[List[Mismatch]] =
    for
      games <- env.ports.tx
        .run(env.peripheral.allGames.map(ids => Right[Nothing, List[GameId]](ids)))
        .map(_.merge)
      found <- games.flatTraverse(verifyOne(env))
    yield found
