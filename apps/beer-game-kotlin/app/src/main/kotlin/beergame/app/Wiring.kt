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
 * 値の根拠のうち、設計書にあるのは、冪等記録の 24 時間（NF-R6）と、復帰資格の 30 日（NF-S4 の例）だけ。
 */

private const val IDEMPOTENCY_TTL_HOURS = 24L
private const val PARTICIPANT_CREDENTIAL_TTL_DAYS = 30L

/** 資格の鍵の版。B1 は 1 つだけ（複数の版を同時に持つ KeyRing は B2）。 */
private const val CREDENTIAL_KEY_VERSION = 1

fun appPorts(
    persistence: Persistence,
    secrets: Secrets,
    maxAttempts: Int,
    now: () -> Instant = Instant::now,
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
                participantCredentialTtl = Duration.ofDays(PARTICIPANT_CREDENTIAL_TTL_DAYS),
                credentialKeyVersion = CREDENTIAL_KEY_VERSION,
                idempotencySecret = secrets.idempotencyKey,
                credentialSecret = secrets.credentialKey,
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
