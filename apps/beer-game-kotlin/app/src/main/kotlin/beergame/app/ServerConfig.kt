package beergame.app

import arrow.core.Either
import arrow.core.NonEmptyList
import arrow.core.left
import arrow.core.right
import java.security.SecureRandom
import java.util.Base64

/*
 * 起動の設定。環境変数から読み、**誤りはすべて集めて**返す（`Left` なら起動に失敗する。ガイド §3.4）。
 * 設定の名前は提案（環境変数の正本は architecture-infrastructure.md。B1 で確定する）。
 *
 * - 秘密情報（資格・冪等・応答の暗号化の 3 つの鍵）は、`local` 以外では必須（未設定なら起動に失敗する。NF-S3）。
 *   `local` では、未設定なら起動のたびに作る使い捨ての鍵（ephemeral）で動く（H2 のメモリ上の DB と同じ寿命）。
 * - エラーには、設定の名前だけを載せ、値は載せない（秘密を、ログや例外に出さない）。
 */

/** 3 つの鍵（それぞれ 32 バイト）。値は、`toString` に出さない。 */
class Secrets(
    val credentialKey: ByteArray,
    val idempotencyKey: ByteArray,
    val responseKey: ByteArray,
    /** 設定に無く、起動のために作った使い捨ての鍵か。 */
    val ephemeral: Boolean,
) {
    override fun toString(): String = "Secrets(***, ephemeral=$ephemeral)"
}

/** データベースへの接続の設定。パスワードは、`toString` に出さない。 */
sealed interface DatabaseSettings {
    val url: String

    data class H2(
        override val url: String,
    ) : DatabaseSettings

    class Postgres(
        override val url: String,
        val user: String,
        val password: String,
    ) : DatabaseSettings {
        override fun toString(): String = "Postgres(url=$url, user=$user, password=***)"
    }

    companion object {
        const val DEFAULT_H2_URL = "jdbc:h2:mem:beergame;MODE=PostgreSQL;DATABASE_TO_LOWER=TRUE;DB_CLOSE_DELAY=-1"
        const val H2_URL_PREFIX = "jdbc:h2:"
    }
}

data class ServerConfig(
    val app: AppConfig,
    val host: String,
    val port: Int,
    val database: DatabaseSettings,
    val secrets: Secrets,
    val allowedOrigins: Set<String>,
    val maxAttempts: Int,
    val migrateOnStart: Boolean,
) {
    companion object {
        const val DEFAULT_PORT = 8080
        const val DEFAULT_MAX_ATTEMPTS = 5
        const val MAX_PORT = 65_535
        const val KEY_BYTES = 32
        const val CREDENTIAL_KEY = "CREDENTIAL_KEY"
        const val IDEMPOTENCY_KEY = "IDEMPOTENCY_KEY"
        const val RESPONSE_KEY = "RESPONSE_KEY"
        val LOCAL_ORIGINS = setOf("http://localhost:5173", "http://127.0.0.1:5173")

        /** [generateKey] は、`local` で鍵が未設定のときだけ使う（使い捨ての鍵）。 */
        fun load(
            variables: Map<String, String>,
            generateKey: () -> ByteArray = ::randomKey,
        ): Either<NonEmptyList<ConfigError>, ServerConfig> {
            val base = AppConfig.load(variables)
            val env = variables[AppConfig.ENV_KEY]?.let(AppEnv::parse)
            val kind = variables[AppConfig.DB_KIND_KEY]?.let(DbKind::parse) ?: DbKind.Postgres
            val local = env == AppEnv.Local
            val secrets = SecretsReader(variables, local, generateKey).read()
            val database = readDatabase(variables, kind, env)
            val port = readInt(variables, "PORT", DEFAULT_PORT, 0..MAX_PORT)
            val origins = readOrigins(variables, local)
            val attempts = readInt(variables, "COMMAND_MAX_ATTEMPTS", DEFAULT_MAX_ATTEMPTS, 1..Int.MAX_VALUE)
            val migrate = readBoolean(variables, "MIGRATE_ON_START", kind == DbKind.H2)
            val errors =
                base.leftOrNull().orEmpty().toList() +
                    secrets.errors + database.leftOrEmpty() + port.leftOrEmpty() + origins.leftOrEmpty() +
                    attempts.leftOrEmpty() + migrate.leftOrEmpty()
            return if (errors.isNotEmpty()) {
                NonEmptyList(errors.first(), errors.drop(1)).left()
            } else {
                val app = AppConfig(checkNotNull(env), kind)
                ServerConfig(
                    app = app,
                    host = variables["HOST"] ?: if (local) "127.0.0.1" else "0.0.0.0",
                    port = port.orFail(),
                    database = database.orFail(),
                    secrets = checkNotNull(secrets.value),
                    allowedOrigins = origins.orFail(),
                    maxAttempts = attempts.orFail(),
                    migrateOnStart = migrate.orFail(),
                ).right()
            }
        }

        private fun randomKey(): ByteArray = ByteArray(KEY_BYTES).also(SecureRandom()::nextBytes)
    }
}

private fun <A> Either<List<ConfigError>, A>.leftOrEmpty(): List<ConfigError> = leftOrNull().orEmpty()

/** 検査を通った後にだけ呼ぶ。 */
private fun <A> Either<List<ConfigError>, A>.orFail(): A = getOrNull() ?: error("検査を通った設定が読めない")

private class SecretsResult(
    val value: Secrets?,
    val errors: List<ConfigError>,
)

/** 3 つの鍵を読む。`local` 以外は必須。Base64 で 32 バイト。3 つは別の値にする（用途ごとに鍵を分ける）。 */
private class SecretsReader(
    private val variables: Map<String, String>,
    private val local: Boolean,
    private val generateKey: () -> ByteArray,
) {
    fun read(): SecretsResult {
        val names = listOf(ServerConfig.CREDENTIAL_KEY, ServerConfig.IDEMPOTENCY_KEY, ServerConfig.RESPONSE_KEY)
        val results = names.map { it to readOne(it) }
        val keys = results.map { (_, result) -> result.getOrNull() }
        val duplicates = duplicateErrors(names, keys)
        val errors = results.mapNotNull { (_, result) -> result.leftOrNull() } + duplicates
        return if (errors.isEmpty()) {
            val ephemeral = names.any { variables[it] == null }
            SecretsResult(
                Secrets(checkNotNull(keys[0]), checkNotNull(keys[1]), checkNotNull(keys[2]), ephemeral),
                emptyList(),
            )
        } else {
            SecretsResult(null, errors)
        }
    }

    private fun readOne(name: String): Either<ConfigError, ByteArray> {
        val raw = variables[name]
        return when {
            raw == null && local -> generateKey().right()
            raw == null -> ConfigError.MissingSetting(name).left()
            else -> decode(raw)?.right() ?: ConfigError.InvalidSetting(name).left()
        }
    }

    private fun decode(raw: String): ByteArray? =
        runCatching { Base64.getDecoder().decode(raw.trim()) }.getOrNull()?.takeIf { it.size == ServerConfig.KEY_BYTES }

    /** 同じ値の鍵が 2 つあれば、後ろの鍵を不正とする。 */
    private fun duplicateErrors(
        names: List<String>,
        keys: List<ByteArray?>,
    ): List<ConfigError> =
        keys.indices
            .filter { i ->
                keys[i] != null && (0 until i).any { j -> keys[j]?.contentEquals(keys[i]) == true }
            }.map { ConfigError.InvalidSetting(names[it]) }
}

private fun readDatabase(
    variables: Map<String, String>,
    kind: DbKind,
    env: AppEnv?,
): Either<List<ConfigError>, DatabaseSettings> =
    when (kind) {
        DbKind.H2 -> readH2(variables)
        DbKind.Postgres -> readPostgres(variables, env)
    }

private fun readH2(variables: Map<String, String>): Either<List<ConfigError>, DatabaseSettings> {
    val url = variables["DB_URL"] ?: DatabaseSettings.DEFAULT_H2_URL
    return if (url.startsWith(DatabaseSettings.H2_URL_PREFIX)) {
        DatabaseSettings.H2(url).right()
    } else {
        listOf<ConfigError>(ConfigError.InvalidSetting("DB_URL")).left()
    }
}

/** PostgreSQL。JDBC の URL が H2 なら（`DB_KIND` が postgres でも）、`local` 以外では拒否する（H2 のすり抜けを防ぐ）。 */
private fun readPostgres(
    variables: Map<String, String>,
    env: AppEnv?,
): Either<List<ConfigError>, DatabaseSettings> {
    val url = variables["DB_URL"]
    val user = variables["DB_USER"]
    val password = variables["DB_PASSWORD"]
    val missing =
        listOf("DB_URL" to url, "DB_USER" to user, "DB_PASSWORD" to password)
            .filter { (_, value) -> value == null }
            .map { (name, _) -> ConfigError.MissingSetting(name) }
    val h2Url = url?.startsWith(DatabaseSettings.H2_URL_PREFIX) == true
    return when {
        missing.isNotEmpty() -> missing.left()
        h2Url && env != AppEnv.Local -> listOf<ConfigError>(ConfigError.H2NotAllowed(env)).left()
        h2Url -> listOf<ConfigError>(ConfigError.InvalidSetting("DB_URL")).left()
        else -> DatabaseSettings.Postgres(checkNotNull(url), checkNotNull(user), checkNotNull(password)).right()
    }
}

private fun readInt(
    variables: Map<String, String>,
    name: String,
    default: Int,
    range: IntRange,
): Either<List<ConfigError>, Int> {
    val raw = variables[name]
    val parsed = raw?.trim()?.toIntOrNull()
    return when {
        raw == null -> default.right()
        parsed != null && parsed in range -> parsed.right()
        else -> listOf<ConfigError>(ConfigError.InvalidSetting(name)).left()
    }
}

private fun readBoolean(
    variables: Map<String, String>,
    name: String,
    default: Boolean,
): Either<List<ConfigError>, Boolean> =
    when (variables[name]?.trim()?.lowercase()) {
        null -> default.right()
        "true" -> true.right()
        "false" -> false.right()
        else -> listOf<ConfigError>(ConfigError.InvalidSetting(name)).left()
    }

/** 許可するオリジン（カンマ区切り）。`local` の既定は開発サーバー。それ以外は明示が必須。 */
private fun readOrigins(
    variables: Map<String, String>,
    local: Boolean,
): Either<List<ConfigError>, Set<String>> {
    val raw = variables["ALLOWED_ORIGINS"]
    val origins =
        raw
            ?.split(',')
            ?.map { it.trim() }
            ?.filter { it.isNotEmpty() }
            ?.toSet()
            .orEmpty()
    return when {
        origins.isNotEmpty() -> origins.right()
        raw == null && local -> ServerConfig.LOCAL_ORIGINS.right()
        raw == null -> listOf<ConfigError>(ConfigError.MissingSetting("ALLOWED_ORIGINS")).left()
        else -> listOf<ConfigError>(ConfigError.InvalidSetting("ALLOWED_ORIGINS")).left()
    }
}
