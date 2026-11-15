package beergame.app

import beergame.application.AppSettings
import beergame.application.Generators
import beergame.application.Ports
import beergame.application.SecureTokens
import beergame.http.DatabaseProbe
import beergame.persistence.Persistence
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.time.Duration
import java.time.Instant
import java.util.UUID
import javax.sql.DataSource

/*
 * 関数の束（Ports）の組み立て。ここが、時計・乱数・永続化・設定を 1 か所で結ぶ（ガイド §7.2）。
 * 値の根拠のうち、設計書にあるのは、冪等記録の 24 時間（NF-R6）と、ブラウザセッションの 24 時間・復帰資格の 30 日
 * （NF-S4 の例）だけ。セッションと復帰資格の期限は設定値（既定は設計書の例。運営者との合意 R11 は未取得）。
 */

private const val IDEMPOTENCY_TTL_HOURS = 24L

/** ブラウザセッションと、参加者の復帰資格の期限。既定は設計書の例（24 時間、30 日）。設定（[ServerConfig]）から渡す。 */
class CredentialTtls(
    val session: Duration = Duration.ofHours(ServerConfig.DEFAULT_SESSION_TTL_HOURS.toLong()),
    val participantCredential: Duration =
        Duration.ofDays(ServerConfig.DEFAULT_PARTICIPANT_CREDENTIAL_TTL_DAYS.toLong()),
) {
    companion object {
        fun of(config: ServerConfig): CredentialTtls =
            CredentialTtls(
                Duration.ofHours(config.sessionTtlHours.toLong()),
                Duration.ofDays(config.participantCredentialTtlDays.toLong()),
            )
    }
}

fun appPorts(
    persistence: Persistence,
    secrets: Secrets,
    maxAttempts: Int,
    now: () -> Instant = Instant::now,
    ttls: CredentialTtls = CredentialTtls(),
): Ports =
    Ports(
        generators =
            Generators(
                now = { now() },
                newId = { UUID.randomUUID() },
                newCredential = { SecureTokens.newCredential() },
                newJoinCode = { SecureTokens.newJoinCode() },
            ),
        stores = persistence.stores,
        lock = persistence.lock,
        notifier = persistence.notifier,
        settings =
            AppSettings(
                maxAttempts = maxAttempts,
                idempotencyTtl = Duration.ofHours(IDEMPOTENCY_TTL_HOURS),
                sessionTtl = ttls.session,
                participantCredentialTtl = ttls.participantCredential,
                idempotencySecret = secrets.idempotencyKey,
                credentialKeys = secrets.credentialKeyRing(),
            ),
    )

/** `/ready` の確認: 接続プールから接続を取り、`SELECT 1` を実行できること。接続できなければ例外（呼ぶ側が false として扱う）。 */
fun databaseProbe(
    dataSource: DataSource,
    dispatcher: CoroutineDispatcher = Dispatchers.IO,
): DatabaseProbe =
    DatabaseProbe {
        withContext(dispatcher) {
            dataSource.connection.use { connection -> connection.createStatement().use { it.execute("SELECT 1") } }
            true
        }
    }
