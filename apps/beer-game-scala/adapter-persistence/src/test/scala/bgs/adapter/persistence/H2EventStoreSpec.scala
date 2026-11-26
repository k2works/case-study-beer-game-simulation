package bgs.adapter.persistence

import cats.effect.IO
import doobie.Transactor

import java.util.UUID

/** ローカル開発用の H2（PostgreSQL モード。メモリ）での契約テスト。 */
class H2EventStoreSpec extends EventStoreContract:

  protected def freshTransactor: IO[Transactor[IO]] =
    val url =
      s"jdbc:h2:mem:${UUID.randomUUID.toString};MODE=PostgreSQL;DATABASE_TO_LOWER=TRUE;DB_CLOSE_DELAY=-1"
    Migrations
      .migrate(url, "sa", "")
      .as(Transactor.fromDriverManager[IO]("org.h2.Driver", url, "sa", "", None))
