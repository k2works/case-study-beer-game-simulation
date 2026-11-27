package bgs.app

import bgs.adapter.persistence.{DoobieEventStore, DoobiePeripheralStore, Migrations, Transactions}
import bgs.adapter.http.Emf
import bgs.application.{Env, KeyRing, LogRecord, LogSink, Ports, SystemGenerators, Tx}
import cats.effect.{IO, Ref, Resource}
import doobie.hikari.HikariTransactor
import doobie.Transactor
import io.circe.Json

import java.time.Duration
import java.util.UUID

/** 実際のアダプターを組み立てる（アプリケーションの層は、ここで初めて具体の実装を知る）。 */
object Wiring:

  private val MaxAttempts = 20
  private val SessionTtl = Duration.ofHours(24)

  /** 資格の署名鍵（版 1）。環境変数（秘密情報の管理から渡す）。無ければ（ローカルだけ）、起動ごとの乱数。 */
  private def randomSecret: String = UUID.randomUUID.toString + UUID.randomUUID.toString

  /** 構造化ログを、1 行の JSON として標準出力へ出す。 */
  val stdoutLog: LogSink =
    LogSink { (record: LogRecord) =>
      // 1 件の要求につき、構造化ログ 1 行と、EMF のメトリクス 1 行（CloudWatch がメトリクスにする。B13）
      IO.realTimeInstant.flatMap(at =>
        IO.println(Emf.line(record, at, sys.env.getOrElse("APP_ENV", "local")).noSpaces)
      ) *>
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
    env(xa, log, wrapTx, randomSecret)

  def env(xa: Transactor[IO], log: LogSink, wrapTx: Tx => Tx, secret: String): Env =
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
      log,
      Ref.unsafe[IO, KeyRing](KeyRing.initial(secret))
    )

  def env(xa: Transactor[IO]): Env = env(xa, stdoutLog, identity)

  /** PostgreSQL（Hikari の接続プール）の環境。マイグレーションは適用しない（`migrate` モードの 1 回限りのタスクが適用する）。 */
  def postgres(config: DatabaseConfig.Postgres, secret: String): Resource[IO, Env] =
    HikariTransactor
      .newHikariTransactor[IO](
        "org.postgresql.Driver",
        config.url,
        config.user,
        config.password,
        scala.concurrent.ExecutionContext.global
      )
      .map(xa => env(xa, stdoutLog, identity, secret))

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
