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

  override val containerDef: PostgreSQLContainer.Def =
    PostgreSQLContainer.Def(DockerImageName.parse("postgres:18.6"))

  override def munitIOTimeout: Duration = 180.seconds

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
