package bgs.app

/** 実行環境。`local` 以外では、秘密情報と PostgreSQL の接続を必須とし、H2 を拒否する。 */
enum AppEnv:
  case Local, Test, Staging, Production

enum DatabaseConfig:
  /** ローカル開発・受け入れ用のメモリ上の H2。 */
  case H2Memory

  case Postgres(url: String, user: String, password: String)

/** 起動の設定。環境変数から作る（[[AppConfig.load]]）。
  *
  * @param credentialKey
  *   資格の署名鍵（版 1）。`local` 以外では必須。無ければ（ローカル）、起動ごとの乱数。
  */
final case class AppConfig(
    appEnv: AppEnv,
    port: Int,
    database: DatabaseConfig,
    credentialKey: Option[String]
)

object AppConfig:

  /** 署名鍵の最小の長さ（32 バイトの乱数の Base64 は 44 文字）。 */
  private val MinKeyLength = 32

  private def appEnvOf(raw: String): Either[String, AppEnv] = raw match
    case "local"      => Right(AppEnv.Local)
    case "test"       => Right(AppEnv.Test)
    case "staging"    => Right(AppEnv.Staging)
    case "production" => Right(AppEnv.Production)
    case _            => Left("APP_ENV は local・test・staging・production のいずれか")

  private def present(env: Map[String, String], name: String): Option[String] =
    env.get(name).map(_.trim).filter(_.nonEmpty)

  /** 環境変数から設定を作る。誤りは、項目名だけで示す（値は含めない。秘密を漏らさない）。 */
  def load(env: Map[String, String]): Either[List[String], AppConfig] =
    val appEnv = appEnvOf(env.getOrElse("APP_ENV", "local")).left.map(List(_))
    appEnv.flatMap { e =>
      val strict = e != AppEnv.Local && e != AppEnv.Test
      val dbKind = env.getOrElse("DB_KIND", if strict then "postgres" else "h2")
      val port: Either[List[String], Int] = env.get("PORT") match
        case None      => Right(8080)
        case Some(raw) =>
          raw.toIntOption
            .filter(p => p >= 1 && p <= 65535)
            .toRight(List("PORT は 1〜65535 の整数"))
      val database: Either[List[String], DatabaseConfig] = dbKind match
        case "h2" =>
          if strict then Left(List("本番相当の環境（staging・production）では、H2 は使えない（DB_KIND=h2）"))
          else Right(DatabaseConfig.H2Memory)
        case "postgres" =>
          val parts = List("DB_URL", "DB_USER", "DB_PASSWORD").map(n => n -> present(env, n))
          val missing = parts.collect { case (n, None) => s"$n が必要（PostgreSQL）" }
          if missing.nonEmpty then Left(missing)
          else
            parts.flatMap(_._2) match
              case List(url, user, password) => Right(DatabaseConfig.Postgres(url, user, password))
              case _                         => Left(List("DB の接続の設定が読めない"))
        case _ => Left(List("DB_KIND は h2 か postgres"))
      val key: Either[List[String], Option[String]] = present(env, "BGS_CREDENTIAL_KEY") match
        case Some(k) if k.length >= MinKeyLength => Right(Some(k))
        case Some(_)        => Left(List(s"BGS_CREDENTIAL_KEY は $MinKeyLength 文字以上"))
        case None if strict => Left(List("BGS_CREDENTIAL_KEY が必要（資格の署名鍵）"))
        case None           => Right(None)
      val errors =
        List(port.left.toOption, database.left.toOption, key.left.toOption).flatten.flatten
      if errors.nonEmpty then Left(errors)
      else
        (port, database, key) match
          case (Right(p), Right(d), Right(k)) => Right(AppConfig(e, p, d, k))
          case _                              => Left(List("設定が読めない"))
    }
