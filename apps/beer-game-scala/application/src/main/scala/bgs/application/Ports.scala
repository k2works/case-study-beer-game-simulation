package bgs.application

import bgs.domain.{DomainError, GameId, Role, SessionError, StreamVersion, ValidationError}
import cats.effect.IO
import doobie.ConnectionIO

import java.time.Instant

/** アプリケーション層の失敗。業務の失敗（[[Domain]]）と、追記の競合・上限・認可・想定外を区別する。 */
enum AppFailure:
  /** `handle` が返した業務上の失敗。 */
  case Domain(error: DomainError)

  /** 追記の競合（同じ版への同時の追記）。`execute` が再読み込みして再試行する。 */
  case ConcurrencyConflict

  /** 再試行・ロックの待ちの上限。`app.retry_exhausted`（503、Retry-After）。 */
  case RetryExhausted

  /** 資格が無い・無効。`app.unauthorized`（403）。 */
  case Unauthorized

  /** 入力の形の誤り。境界で集めた、項目ごとの誤り（422）。 */
  case Invalid(errors: List[ValidationError])

  /** 入力の競合・確定の根拠の変化。応答に添える、現在の役割ごとの入力（保存者・時刻つき）を持つ。 */
  case Conflict(error: SessionError, entries: Map[Role, DecisionEntryView])

  /** 想定外の失敗（500 と相関 ID）。 */
  case Persistence(message: String)

/** [[occurredAt]] は、[[events]] と同じ順の、追記の時刻。 */
final case class StreamRead[E](events: List[E], version: StreamVersion, occurredAt: List[Instant])

/** 1 本のイベントのストリーム（`game` または `session`）。実装は adapter-persistence。 `append` は、期待する版（読んだ時点の版）が現在の版と違えば
  * `Left(ConcurrencyConflict)` を返す（楽観的並行制御）。
  */
final case class EventStore[E](
    read: GameId => ConnectionIO[StreamRead[E]],
    append: (GameId, StreamVersion, List[E], Instant) => ConnectionIO[
      Either[AppFailure, StreamVersion]
    ]
)

/** 書き込みの実行。`Transactor` を直接渡さない（公開する書き込みの実行は `run` だけ）。 `Left` なら ROLLBACK してから終える（K5: doobie は
  * `Left` でも COMMIT するため）。実装は `Transactions.scala`。
  */
trait Tx:
  def run[E, A](program: ConnectionIO[Either[E, A]]): IO[Either[E, A]]
