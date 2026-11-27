package bgs.adapter.persistence

import cats.effect.IO
import org.flywaydb.core.Flyway

/** Flyway によるマイグレーションの適用。H2 と PostgreSQL に同じ共通の DDL を適用する。 */
object Migrations:

  def migrate(url: String, user: String, password: String): IO[Unit] =
    IO.blocking {
      Flyway
        .configure()
        .dataSource(url, user, password)
        .locations("classpath:db/migration")
        .load()
        .migrate()
    }.void

  /** 本番の PostgreSQL へ、共通の DDL と PostgreSQL 専用（ロールと権限）の両方を適用する（`migrate` モード。B14）。 */
  def migratePostgres(url: String, user: String, password: String): IO[Unit] =
    IO.blocking {
      Flyway
        .configure()
        .dataSource(url, user, password)
        .locations("classpath:db/migration", "classpath:db/migration-postgres")
        .load()
        .migrate()
    }.void

  /** PostgreSQL へ、指定のスキーマ（なければ作る）に適用する。共通の DDL に、PostgreSQL 専用（ロールと権限）を足す。
    * 統合テストで、テストごとに空の状態を作るために使う。
    */
  def migrateInSchema(url: String, user: String, password: String, schema: String): IO[Unit] =
    IO.blocking {
      Flyway
        .configure()
        .dataSource(url, user, password)
        .schemas(schema)
        .defaultSchema(schema)
        .createSchemas(true)
        .locations("classpath:db/migration", "classpath:db/migration-postgres")
        .load()
        .migrate()
    }.void
