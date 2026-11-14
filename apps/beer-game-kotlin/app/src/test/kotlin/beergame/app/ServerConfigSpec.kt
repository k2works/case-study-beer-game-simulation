package beergame.app

import arrow.core.Either
import io.kotest.assertions.fail
import io.kotest.core.spec.style.FunSpec
import io.kotest.matchers.collections.shouldContainAll
import io.kotest.matchers.shouldBe
import io.kotest.matchers.string.shouldNotContain
import java.util.Base64

private fun key(seed: Int): String = Base64.getEncoder().encodeToString(ByteArray(32) { (it + seed).toByte() })

private val SECRETS =
    mapOf("CREDENTIAL_KEY" to key(1), "IDEMPOTENCY_KEY" to key(2), "RESPONSE_KEY" to key(3))

private val POSTGRES =
    mapOf(
        "DB_URL" to "jdbc:postgresql://db.internal:5432/beergame",
        "DB_USER" to "app",
        "DB_PASSWORD" to "s3cr3t-password",
    )

private fun production(vararg overrides: Pair<String, String>): Map<String, String> =
    mapOf("APP_ENV" to "production", "DB_KIND" to "postgres", "ALLOWED_ORIGINS" to "https://beer.example.com") +
        SECRETS + POSTGRES + overrides

private fun errorsOf(variables: Map<String, String>): List<ConfigError> =
    when (val result = ServerConfig.load(variables)) {
        is Either.Left -> result.value.toList()
        is Either.Right -> fail("読み込めてはならない: ${result.value}")
    }

private fun configOf(variables: Map<String, String>): ServerConfig =
    when (val result = ServerConfig.load(variables)) {
        is Either.Right -> result.value
        is Either.Left -> fail("読み込めるはず: ${result.value}")
    }

class ServerConfigSpec :
    FunSpec({
        test("[NF-S3] Given 本番相当（production）で秘密情報が全く無い When 読み込む Then 起動に失敗し、足りない設定をすべて集める") {
            val errors = errorsOf(mapOf("APP_ENV" to "production", "DB_KIND" to "postgres"))

            errors shouldContainAll
                listOf(
                    ConfigError.MissingSetting("CREDENTIAL_KEY"),
                    ConfigError.MissingSetting("IDEMPOTENCY_KEY"),
                    ConfigError.MissingSetting("RESPONSE_KEY"),
                    ConfigError.MissingSetting("DB_URL"),
                    ConfigError.MissingSetting("DB_USER"),
                    ConfigError.MissingSetting("DB_PASSWORD"),
                    ConfigError.MissingSetting("ALLOWED_ORIGINS"),
                )
        }

        test("[NF-S3] Given staging・test でも鍵が無い When 読み込む Then 失敗する（鍵を省略できるのは local だけ）") {
            listOf("staging", "test").forEach { env ->
                val errors = errorsOf(production("APP_ENV" to env) - SECRETS.keys)

                errors shouldContainAll SECRETS.keys.map { ConfigError.MissingSetting(it) }
            }
        }

        test("[NF-S3] Given 鍵のうち 1 つだけが無い When 読み込む Then その 1 つだけを示す") {
            errorsOf(production() - "IDEMPOTENCY_KEY") shouldBe listOf(ConfigError.MissingSetting("IDEMPOTENCY_KEY"))
        }

        test("[NF-S3] Given 鍵が Base64 でない・32 バイトでない When 読み込む Then 失敗し、値そのものはエラーに含めない") {
            val bad = "not-base64-!!!-hunter2"
            val short = Base64.getEncoder().encodeToString(ByteArray(16))

            val errors = errorsOf(production("CREDENTIAL_KEY" to bad, "RESPONSE_KEY" to short))

            errors shouldBe
                listOf(ConfigError.InvalidSetting("CREDENTIAL_KEY"), ConfigError.InvalidSetting("RESPONSE_KEY"))
            errors.toString() shouldNotContain "hunter2"
            errors.toString() shouldNotContain short
        }

        test("[NF-S3] Given 3 つの鍵が同じ値 When 読み込む Then 失敗する（鍵は用途ごとに別にする）") {
            errorsOf(production("IDEMPOTENCY_KEY" to key(1))) shouldBe
                listOf(ConfigError.InvalidSetting("IDEMPOTENCY_KEY"))
        }

        test("[US6.1] Given 完全な本番の設定 When 読み込む Then 読み込める。鍵は使い捨てではなく、秘密は toString に出ない") {
            val config = configOf(production())

            config.app shouldBe AppConfig(AppEnv.Production, DbKind.Postgres)
            config.secrets.ephemeral shouldBe false
            config.secrets.credentialKey.size shouldBe 32
            config.toString() shouldNotContain "s3cr3t-password"
            config.toString() shouldNotContain key(1)
            config.secrets.toString() shouldNotContain key(2)
            config.migrateOnStart shouldBe false
        }

        test("[7.6] Given production で H2 を選ぶ When 読み込む Then 失敗する（H2NotAllowed）。他の誤りも一緒に集める") {
            val errors = errorsOf(mapOf("APP_ENV" to "production", "DB_KIND" to "h2"))

            errors shouldContainAll
                listOf(ConfigError.H2NotAllowed(AppEnv.Production), ConfigError.MissingSetting("CREDENTIAL_KEY"))
        }

        test("[7.6] Given production・staging で、postgres のまま JDBC の URL が H2 When 読み込む Then 失敗する（H2NotAllowed）") {
            listOf("production", "staging").forEach { env ->
                val errors = errorsOf(production("APP_ENV" to env, "DB_URL" to "jdbc:h2:mem:x"))

                errors shouldBe
                    listOf(ConfigError.H2NotAllowed(if (env == "production") AppEnv.Production else AppEnv.Staging))
            }
        }

        test("[7.6] Given local で H2・鍵なし When 読み込む Then 使い捨ての鍵で起動できる（ephemeral）。起動のたびに違う鍵") {
            val first = configOf(mapOf("APP_ENV" to "local", "DB_KIND" to "h2"))
            val second = configOf(mapOf("APP_ENV" to "local", "DB_KIND" to "h2"))

            first.secrets.ephemeral shouldBe true
            first.secrets.credentialKey.size shouldBe 32
            (first.secrets.credentialKey.toList() == second.secrets.credentialKey.toList()) shouldBe false
            first.database shouldBe DatabaseSettings.H2(DatabaseSettings.DEFAULT_H2_URL)
            first.migrateOnStart shouldBe true
            first.port shouldBe 8080
        }

        test("[7.6] Given local で鍵を指定した When 読み込む Then 指定した鍵を使う（ephemeral にならない）") {
            val config = configOf(mapOf("APP_ENV" to "local", "DB_KIND" to "h2") + SECRETS)

            config.secrets.ephemeral shouldBe false
            config.secrets.credentialKey.toList() shouldBe Base64.getDecoder().decode(key(1)).toList()
        }

        test("Given PORT・ALLOWED_ORIGINS・COMMAND_MAX_ATTEMPTS When 読み込む Then 反映する。不正な値は失敗する") {
            val config =
                configOf(
                    production(
                        "PORT" to "9090",
                        "ALLOWED_ORIGINS" to "https://beer.example.com, https://admin.example.com",
                        "COMMAND_MAX_ATTEMPTS" to "7",
                    ),
                )

            config.port shouldBe 9090
            config.allowedOrigins shouldBe setOf("https://beer.example.com", "https://admin.example.com")
            config.maxAttempts shouldBe 7
            errorsOf(production("PORT" to "abc", "COMMAND_MAX_ATTEMPTS" to "0")) shouldBe
                listOf(ConfigError.InvalidSetting("PORT"), ConfigError.InvalidSetting("COMMAND_MAX_ATTEMPTS"))
        }

        test("Given 本番相当で ALLOWED_ORIGINS が無い When 読み込む Then 失敗する（許可するオリジンを明示する）") {
            errorsOf(production() - "ALLOWED_ORIGINS") shouldBe listOf(ConfigError.MissingSetting("ALLOWED_ORIGINS"))
            configOf(mapOf("APP_ENV" to "local", "DB_KIND" to "h2")).allowedOrigins shouldBe
                setOf("http://localhost:5173", "http://127.0.0.1:5173")
        }
    })
