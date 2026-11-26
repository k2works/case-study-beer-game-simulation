package bgs.app

import bgs.adapter.persistence.{DoobieEventStore, DoobiePeripheralStore, Migrations, Transactions}
import bgs.application.{Env, LogRecord, LogSink, Ports, SystemGenerators, Tx}
import cats.effect.IO
import doobie.Transactor
import io.circe.Json

import java.time.Duration
import java.util.UUID

/** 実際のアダプターを組み立てる（アプリケーションの層は、ここで初めて具体の実装を知る）。 */
object Wiring:

  private val MaxAttempts = 20
  private val SessionTtl = Duration.ofHours(24)

  /** 構造化ログを、1 行の JSON として標準出力へ出す。 */
  val stdoutLog: LogSink =
    LogSink { (record: LogRecord) =>
      IO.println(
        Json
          .obj(
            "correlationId" -> Json.fromString(record.correlationId),
            "operation" -> Json.fromString(record.operation),
            "status" -> Json.fromInt(record.status),
            "durationMs" -> Json.fromLong(record.durationMs)
          )
          .noSpaces
      )
    }

  /** ポートと周辺ストア、時計・乱数をつないだ環境。書き込みの実行は、[[wrapTx]] で包める（障害の模擬など）。 */
  def env(xa: Transactor[IO], log: LogSink, wrapTx: Tx => Tx): Env =
    Env(
      Ports(
        DoobieEventStore.game,
        DoobieEventStore.session,
        wrapTx(Transactions.writeTx(xa)),
        MaxAttempts
      ),
      DoobiePeripheralStore(),
      SystemGenerators.system,
      SessionTtl,
      log
    )

  def env(xa: Transactor[IO]): Env = env(xa, stdoutLog, identity)

  /** ローカル開発・受け入れ用の H2（PostgreSQL モード。メモリ）。マイグレーションを適用して返す。 */
  def inMemoryH2: IO[Env] = inMemoryH2(stdoutLog, identity)

  def inMemoryH2(log: LogSink, wrapTx: Tx => Tx): IO[Env] =
    val url =
      s"jdbc:h2:mem:${UUID.randomUUID.toString};MODE=PostgreSQL;DATABASE_TO_LOWER=TRUE;DB_CLOSE_DELAY=-1"
    Migrations
      .migrate(url, "sa", "")
      .map(_ =>
        env(Transactor.fromDriverManager[IO]("org.h2.Driver", url, "sa", "", None), log, wrapTx)
      )
