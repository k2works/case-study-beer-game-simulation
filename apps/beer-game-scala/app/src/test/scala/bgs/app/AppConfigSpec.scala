package bgs.app

import munit.FunSuite

/** 本番相当の設定（B14）。環境変数から作り、H2・秘密情報なし・不正な値は、値を出さずに誤りとして返す。 */
class AppConfigSpec extends FunSuite:

  private val key = "k" * 44

  private val production = Map(
    "APP_ENV" -> "production",
    "DB_URL" -> "jdbc:postgresql://db:5432/beergame",
    "DB_USER" -> "owner",
    "DB_PASSWORD" -> "s3cret-password",
    "BGS_CREDENTIAL_KEY" -> key
  )

  test("[B14] 環境変数が無ければ、ローカル（H2・メモリ）で、ポートは 8080") {
    val config = AppConfig.load(Map.empty).fold(e => fail(e.toString), identity)
    assertEquals(config.appEnv, AppEnv.Local)
    assertEquals(config.database, DatabaseConfig.H2Memory)
    assertEquals(config.port, 8080)
  }

  test("[B14] 本番は、PostgreSQL の接続と資格の署名鍵がそろえば読める。ポートは PORT") {
    val config =
      AppConfig.load(production + ("PORT" -> "9090")).fold(e => fail(e.toString), identity)
    assertEquals(config.appEnv, AppEnv.Production)
    assertEquals(config.port, 9090)
    assertEquals(
      config.database,
      DatabaseConfig.Postgres("jdbc:postgresql://db:5432/beergame", "owner", "s3cret-password")
    )
    assertEquals(config.credentialKey, Some(key))
  }

  test("[B14] 本番で H2 は拒否する（誤った本番を防ぐ）") {
    val errors = AppConfig.load(production + ("DB_KIND" -> "h2")).left.getOrElse(Nil)
    assert(errors.exists(_.contains("H2")), errors.toString)
  }

  test("[B14] 本番で秘密情報・DB の接続が足りないと、足りない項目をすべて示す。値は示さない") {
    val errors = AppConfig.load(Map("APP_ENV" -> "production")).left.getOrElse(Nil)
    List("DB_URL", "DB_USER", "DB_PASSWORD", "BGS_CREDENTIAL_KEY").foreach(name =>
      assert(errors.exists(_.contains(name)), s"$name が示されない: $errors")
    )
    val withValues = AppConfig
      .load(production - "BGS_CREDENTIAL_KEY" + ("DB_PASSWORD" -> "s3cret-password"))
      .left
      .getOrElse(Nil)
    assert(!withValues.exists(_.contains("s3cret-password")), "秘密の値が誤りに含まれる")
  }

  test("[B14] 署名鍵が短い・APP_ENV や PORT が不正なときは、誤りにする") {
    assert(AppConfig.load(production + ("BGS_CREDENTIAL_KEY" -> "short")).isLeft)
    assert(AppConfig.load(production + ("APP_ENV" -> "prod")).isLeft)
    assert(AppConfig.load(production + ("PORT" -> "abc")).isLeft)
    assert(AppConfig.load(production + ("PORT" -> "70000")).isLeft)
  }

  test("[B14] ステージングも、本番と同じ必須項目。ローカルは署名鍵が無くてもよい") {
    assert(AppConfig.load(production + ("APP_ENV" -> "staging")).isRight)
    assert(AppConfig.load(production + ("APP_ENV" -> "staging") - "BGS_CREDENTIAL_KEY").isLeft)
    assert(AppConfig.load(Map("APP_ENV" -> "local")).isRight)
  }

  test("[B14] ローカルでも PostgreSQL を使える（DB_KIND=postgres）") {
    val local = Map(
      "APP_ENV" -> "local",
      "DB_KIND" -> "postgres",
      "DB_URL" -> "jdbc:postgresql://localhost/x",
      "DB_USER" -> "u",
      "DB_PASSWORD" -> "p"
    )
    assert(AppConfig.load(local).exists(_.database.isInstanceOf[DatabaseConfig.Postgres]))
  }

  test("[NF-S8・NF-S2] ALLOWED_ORIGINS はカンマ区切りで読む。Secure は staging・production だけ") {
    val prod = Map(
      "APP_ENV" -> "production",
      "DB_URL" -> "jdbc:postgresql://localhost/x",
      "DB_USER" -> "u",
      "DB_PASSWORD" -> "p",
      "BGS_CREDENTIAL_KEY" -> ("k" * 40),
      "ALLOWED_ORIGINS" -> "https://a.example, https://b.example"
    )
    val policy = AppConfig.load(prod).map(_.httpPolicy)
    assertEquals(
      policy.map(_.allowedOrigins),
      Right(Set("https://a.example", "https://b.example"))
    )
    assertEquals(policy.map(_.secureCookies), Right(true))
    assertEquals(AppConfig.load(Map.empty).map(_.httpPolicy.secureCookies), Right(false))
  }
