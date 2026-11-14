package beergame.app

import arrow.core.Either
import arrow.core.NonEmptyList
import arrow.core.raise.either
import arrow.core.raise.zipOrAccumulate

/** 実行の環境（`APP_ENV`）。 */
enum class AppEnv(
    val value: String,
) {
    Local("local"),
    Test("test"),
    Staging("staging"),
    Production("production"),
    ;

    companion object {
        fun parse(raw: String): AppEnv? = entries.firstOrNull { it.value == raw }
    }
}

/** データベースの種類（`DB_KIND`）。H2 はローカル開発専用（ADR-014）。 */
enum class DbKind(
    val value: String,
) {
    Postgres("postgres"),
    H2("h2"),
    ;

    companion object {
        fun parse(raw: String): DbKind? = entries.firstOrNull { it.value == raw.lowercase() }
    }
}

sealed interface ConfigError {
    data object MissingEnv : ConfigError

    data class UnknownEnv(
        val value: String,
    ) : ConfigError

    data class UnknownDbKind(
        val value: String,
    ) : ConfigError

    /** H2 を許すのは `APP_ENV=local` のときだけ。[env] が null のときは、環境が未設定または未知。 */
    data class H2NotAllowed(
        val env: AppEnv?,
    ) : ConfigError

    /** 必須の設定が無い。[name] は設定の名前だけで、値は持たない。 */
    data class MissingSetting(
        val name: String,
    ) : ConfigError

    /** 設定の値が不正（形式、範囲、重複）。[name] は設定の名前だけで、値は持たない（秘密を、ログや例外に出さない）。 */
    data class InvalidSetting(
        val name: String,
    ) : ConfigError
}

data class AppConfig(
    val env: AppEnv,
    val dbKind: DbKind,
) {
    companion object {
        const val ENV_KEY = "APP_ENV"
        const val DB_KIND_KEY = "DB_KIND"

        /**
         * 環境変数から読む。誤りは集めて返す（起動の失敗）。許可リスト方式で、`DB_KIND=h2` は `APP_ENV=local` のときだけ許す。
         * `DB_KIND` が未設定なら `postgres`。
         */
        fun load(variables: Map<String, String>): Either<NonEmptyList<ConfigError>, AppConfig> {
            val env = parseEnv(variables[ENV_KEY])
            val kind = parseKind(variables[DB_KIND_KEY])
            return either {
                zipOrAccumulate(
                    { env.bind() },
                    {
                        val k = kind.bind()
                        validateDbKind(env.getOrNull(), k).bind()
                    },
                ) { e, k -> AppConfig(e, k) }
            }
        }

        private fun parseEnv(raw: String?): Either<ConfigError, AppEnv> =
            when {
                raw == null -> Either.Left(ConfigError.MissingEnv)
                else -> AppEnv.parse(raw)?.let { Either.Right(it) } ?: Either.Left(ConfigError.UnknownEnv(raw))
            }

        private fun parseKind(raw: String?): Either<ConfigError, DbKind> =
            when {
                raw == null -> Either.Right(DbKind.Postgres)
                else -> DbKind.parse(raw)?.let { Either.Right(it) } ?: Either.Left(ConfigError.UnknownDbKind(raw))
            }

        /** 純粋な検証。H2 は `APP_ENV=local` のときだけ許す（test・staging・production と、未設定・未知の環境は拒否）。 */
        fun validateDbKind(
            env: AppEnv?,
            kind: DbKind,
        ): Either<ConfigError, DbKind> =
            when (kind) {
                DbKind.Postgres -> Either.Right(kind)
                DbKind.H2 -> if (env == AppEnv.Local) Either.Right(kind) else Either.Left(ConfigError.H2NotAllowed(env))
            }
    }
}
