package bgs.app

import bgs.adapter.persistence.{DoobieEventStore, DoobiePeripheralStore, Migrations, Transactions}
import bgs.application.{Env, Ports, SystemGenerators}
import cats.effect.IO
import doobie.Transactor

import java.time.Duration
import java.util.UUID

/** 実際のアダプターを組み立てる（アプリケーションの層は、ここで初めて具体の実装を知る）。 */
object Wiring:

  private val MaxAttempts = 20
  private val SessionTtl = Duration.ofHours(24)

  /** ポートと周辺ストア、時計・乱数をつないだ環境。 */
  def env(xa: Transactor[IO]): Env =
    Env(
      Ports(DoobieEventStore.game, DoobieEventStore.session, Transactions.writeTx(xa), MaxAttempts),
      DoobiePeripheralStore(),
      SystemGenerators.system,
      SessionTtl
    )

  /** ローカル開発・受け入れ用の H2（PostgreSQL モード。メモリ）。マイグレーションを適用して返す。 */
  def inMemoryH2: IO[Env] =
    val url =
      s"jdbc:h2:mem:${UUID.randomUUID.toString};MODE=PostgreSQL;DATABASE_TO_LOWER=TRUE;DB_CLOSE_DELAY=-1"
    Migrations
      .migrate(url, "sa", "")
      .map(_ => env(Transactor.fromDriverManager[IO]("org.h2.Driver", url, "sa", "", None)))
