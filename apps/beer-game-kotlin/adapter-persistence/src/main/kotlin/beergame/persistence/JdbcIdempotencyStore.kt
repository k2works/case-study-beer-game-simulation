package beergame.persistence

import arrow.core.Either
import arrow.core.flatMap
import arrow.core.left
import arrow.core.right
import beergame.application.AppFailure
import beergame.application.IdempotencyKey
import beergame.application.IdempotencyStore
import beergame.application.PersistenceFailure
import beergame.application.StoredResponse
import beergame.application.Tx
import beergame.domain.GameId
import java.sql.ResultSet
import java.time.Instant

/**
 * 冪等記録（成功した応答だけを、暗号化して保存する）。
 * - ゲーム作成（scope = 'create'）の重複は、PostgreSQL では部分一意索引 `uq_idempotency_create` の違反で検出する。
 *   H2 は部分一意索引が使えないので、挿入の前に `(scope, key_digest)` を検索する（ローカルでは守られない。単一プロセス前提）。
 * - 重複は ConcurrencyConflict で返し、呼び出し側が再試行して記録を見つける（PostgreSQL では、一意違反の後のトランザクションは使えないため）。
 */
internal class JdbcIdempotencyStore(
    private val dialect: Dialect,
    private val cipher: ResponseCipher,
) {
    fun port(): IdempotencyStore = IdempotencyStore(::find, ::save)

    private fun find(
        tx: Tx,
        key: IdempotencyKey,
        now: Instant,
    ): Either<AppFailure, StoredResponse?> =
        tx.jdbc(OP_FIND).flatMap { jdbcTx ->
            jdbcCall(OP_FIND) {
                val sql = FIND_SQL + if (key.isCreate) "" else " AND game_id = ?"
                jdbcTx.connection.prepareStatement(sql).use { ps ->
                    ps.params().string(key.scope).string(key.keyDigest).instant(now).also { p ->
                        if (!key.isCreate) p.uuid(key.gameId.value)
                    }
                    ps.executeQuery().use { rs -> if (rs.next()) rs.toStored(key) else null.right() }
                }
            }
        }

    private fun ResultSet.toStored(key: IdempotencyKey): Either<AppFailure, StoredResponse?> {
        val stored = GameId(checkNotNull(getUuid("game_id")))
        val body = cipher.decrypt(getBytes("response"), aad(stored, key))
        return if (body == null) {
            failure(OP_FIND, "応答を復号できない").left()
        } else {
            StoredResponse(
                stored,
                getString("request_digest"),
                getInt("status_code"),
                body,
                getInstant("expires_at"),
            ).right()
        }
    }

    private fun save(
        tx: Tx,
        key: IdempotencyKey,
        response: StoredResponse,
        now: Instant,
    ): Either<AppFailure, Unit> =
        tx.jdbc(OP_SAVE).flatMap { jdbcTx ->
            jdbcCall(OP_SAVE) {
                deleteExpired(jdbcTx, key, now)
                if (dialect == Dialect.H2 && key.isCreate && existsCreate(jdbcTx, key)) {
                    AppFailure.ConcurrencyConflict.left()
                } else {
                    insert(jdbcTx, key, response)
                    Unit.right()
                }
            }
        }

    private fun deleteExpired(
        tx: JdbcTx,
        key: IdempotencyKey,
        now: Instant,
    ) {
        val sql = DELETE_EXPIRED_SQL + if (key.isCreate) "" else " AND game_id = ?"
        tx.connection.prepareStatement(sql).use { ps ->
            ps.params().string(key.scope).string(key.keyDigest).instant(now).also { p ->
                if (!key.isCreate) p.uuid(key.gameId.value)
            }
            ps.executeUpdate()
        }
    }

    private fun existsCreate(
        tx: JdbcTx,
        key: IdempotencyKey,
    ): Boolean =
        tx.connection.prepareStatement(EXISTS_CREATE_SQL).use { ps ->
            ps.params().string(key.scope).string(key.keyDigest)
            ps.executeQuery().use { it.next() }
        }

    private fun insert(
        tx: JdbcTx,
        key: IdempotencyKey,
        response: StoredResponse,
    ) {
        tx.connection.prepareStatement(INSERT_SQL).use { ps ->
            ps
                .params()
                .uuid(key.gameId.value)
                .string(key.scope)
                .string(key.keyDigest)
                .string(response.requestDigest)
                .int(response.statusCode)
                .bytes(cipher.encrypt(response.body, aad(key.gameId, key)))
                .instant(response.expiresAt)
            ps.executeUpdate()
        }
    }

    private fun aad(
        game: GameId,
        key: IdempotencyKey,
    ): String = "${game.value}|${key.scope}|${key.keyDigest}"

    private fun failure(
        operation: String,
        message: String,
    ): AppFailure = AppFailure.Persistence(PersistenceFailure(operation, message))

    private companion object {
        const val OP_FIND = "idempotency.find"
        const val OP_SAVE = "idempotency.save"
        const val FIND_SQL =
            "SELECT game_id, request_digest, status_code, response, expires_at FROM idempotency_records " +
                "WHERE scope = ? AND key_digest = ? AND expires_at > ?"
        const val DELETE_EXPIRED_SQL =
            "DELETE FROM idempotency_records WHERE scope = ? AND key_digest = ? AND expires_at <= ?"
        const val EXISTS_CREATE_SQL = "SELECT 1 FROM idempotency_records WHERE scope = ? AND key_digest = ?"
        const val INSERT_SQL =
            "INSERT INTO idempotency_records " +
                "(game_id, scope, key_digest, request_digest, status_code, response, expires_at) " +
                "VALUES (?, ?, ?, ?, ?, ?, ?)"
    }
}
