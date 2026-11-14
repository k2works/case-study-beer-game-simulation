package beergame.app

import arrow.core.Either
import arrow.core.nonEmptyListOf
import io.kotest.core.spec.style.FunSpec
import io.kotest.matchers.shouldBe

private fun load(
    env: String?,
    db: String?,
): Either<*, AppConfig> =
    AppConfig.load(listOfNotNull(env?.let { "APP_ENV" to it }, db?.let { "DB_KIND" to it }).toMap())

class AppConfigSpec :
    FunSpec({
        test("[7.6] Given APP_ENV=local When DB_KIND=h2 Then H2 を許す（H2 を許すのは local のときだけ）") {
            AppConfig.load(mapOf("APP_ENV" to "local", "DB_KIND" to "h2")) shouldBe
                Either.Right(AppConfig(AppEnv.Local, DbKind.H2))
        }

        test("[7.6] Given DB_KIND が未設定 When 読み込む Then postgres（既定）") {
            AppConfig.load(mapOf("APP_ENV" to "production")) shouldBe
                Either.Right(AppConfig(AppEnv.Production, DbKind.Postgres))
        }

        test("[7.6] Given APP_ENV × DB_KIND の全組み合わせ When 読み込む Then H2 が通るのは local × h2 だけ") {
            val envs = listOf("local", "test", "staging", "production", null, "prod", "")
            val kinds = listOf("postgres", "h2", "H2", null, "mysql", "")
            val accepted =
                envs
                    .flatMap { env -> kinds.map { kind -> Triple(env, kind, load(env, kind)) } }
                    .filter { (_, _, r) -> r.isRight() }
                    .filter { (_, _, r) -> (r as Either.Right).value.dbKind == DbKind.H2 }
                    .map { (env, kind, _) -> env to kind }
            accepted shouldBe listOf("local" to "h2", "local" to "H2")
        }

        test("[7.6] Given staging または production When DB_KIND=h2 Then 起動に失敗する（H2NotAllowed）") {
            val cases = listOf("staging" to AppEnv.Staging, "production" to AppEnv.Production, "test" to AppEnv.Test)
            cases.forEach { (name, env) ->
                AppConfig.load(mapOf("APP_ENV" to name, "DB_KIND" to "h2")) shouldBe
                    Either.Left(nonEmptyListOf(ConfigError.H2NotAllowed(env)))
            }
        }

        test("[7.6] Given APP_ENV が未設定・未知 When 読み込む Then 失敗する。H2 を求めていればその誤りも集める") {
            AppConfig.load(emptyMap()) shouldBe Either.Left(nonEmptyListOf(ConfigError.MissingEnv))
            AppConfig.load(mapOf("APP_ENV" to "prod")) shouldBe
                Either.Left(nonEmptyListOf(ConfigError.UnknownEnv("prod")))
            AppConfig.load(mapOf("DB_KIND" to "h2")) shouldBe
                Either.Left(nonEmptyListOf(ConfigError.MissingEnv, ConfigError.H2NotAllowed(null)))
        }

        test("[7.6] Given DB_KIND が未知 When 読み込む Then UnknownDbKind") {
            AppConfig.load(mapOf("APP_ENV" to "local", "DB_KIND" to "mysql")) shouldBe
                Either.Left(nonEmptyListOf(ConfigError.UnknownDbKind("mysql")))
        }
    })
