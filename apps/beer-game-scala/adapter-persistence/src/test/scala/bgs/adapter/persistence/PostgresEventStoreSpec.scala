package bgs.adapter.persistence

import cats.effect.IO
import com.dimafeng.testcontainers.PostgreSQLContainer
import com.dimafeng.testcontainers.munit.TestContainerForAll
import doobie.Transactor
import org.testcontainers.utility.DockerImageName

import java.util.UUID
import scala.concurrent.duration.*

/** PostgreSQL 18（Testcontainers。タグを固定）での契約テスト。受け入れの正は PostgreSQL。 */
class PostgresEventStoreSpec extends EventStoreContract with TestContainerForAll:

  /** `check` ジョブは Docker を要する統合テストを除外し、`integration` ジョブが実行する（案 Y）。 */
  override def munitTests(): Seq[Test] =
    super.munitTests().map(_.tag(new munit.Tag("Integration")))

  override val containerDef: PostgreSQLContainer.Def =
    PostgreSQLContainer.Def(DockerImageName.parse("postgres:18.6"))

  override def munitIOTimeout: Duration = 180.seconds

  test("[追記専用] イベントの書き込みロールは、INSERT・SELECT はできるが、UPDATE・DELETE・TRUNCATE は拒否される（42501）") {
    import cats.syntax.all.*
    import doobie.implicits.*
    freshTransactor.flatMap { xa =>
      // トランザクションの入口は Tx.run だけ（Left なら ROLLBACK される。権限の拒否のあとの不整合を避ける）
      def attempt(sql: String): IO[Either[String, Int]] =
        Transactions
          .writeTx(xa)
          .run(
            (doobie.Fragment.const("set role bgs_event_writer").update.run *>
              doobie.Fragment.const(sql).update.run).attemptSql
              .map(_.left.map(_.getSQLState))
          )
      val gameId = java.util.UUID.randomUUID
      for
        insertRoot <- attempt(s"insert into game_roots (game_id) values ('$gameId')")
        update <- attempt("update events set event_type = 'x'")
        delete <- attempt("delete from events")
        truncate <- attempt("truncate table events")
      yield
        assert(insertRoot.isRight, s"INSERT できない: $insertRoot")
        assertEquals(update, Left("42501"))
        assertEquals(delete, Left("42501"))
        assertEquals(truncate, Left("42501"))
    }
  }

  /** テストごとに、新しいスキーマを作って Flyway を適用する（コンテナは 1 つを使い回す）。 */
  protected def freshTransactor: IO[Transactor[IO]] =
    withContainers { container =>
      val schema = s"t_${UUID.randomUUID.toString.replace("-", "")}"
      val separator = if container.jdbcUrl.contains("?") then "&" else "?"
      val url = s"${container.jdbcUrl}${separator}currentSchema=$schema"
      Migrations
        .migrateInSchema(url, container.username, container.password, schema)
        .as(
          Transactor.fromDriverManager[IO](
            "org.postgresql.Driver",
            url,
            container.username,
            container.password,
            None
          )
        )
    }
