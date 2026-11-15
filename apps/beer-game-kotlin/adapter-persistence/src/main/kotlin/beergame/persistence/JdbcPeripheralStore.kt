package beergame.persistence

import arrow.core.Either
import arrow.core.flatMap
import arrow.core.right
import beergame.application.AppFailure
import beergame.application.CredentialKind
import beergame.application.PeripheralStore
import beergame.application.PeripheralWrite
import beergame.application.Tx
import beergame.application.VerifiedCredential
import beergame.application.VerifiedRecovery
import beergame.domain.Actor
import beergame.domain.GameId
import beergame.domain.JoinCode
import beergame.domain.ParticipantId
import java.sql.ResultSet
import java.time.Instant
import java.util.UUID

/**
 * 周辺ストア: 表示名（`display_profiles`）、復帰資格のダイジェスト（`credentials`）、ブラウザセッション（`browser_sessions`）。
 * 書き込みの SQL は [JdbcPeripheralRows]。生の資格は受け取らず、ダイジェストだけを扱う。
 *
 * B5 Step 4: ブラウザセッションと復帰資格は、別の値・別のダイジェスト（B1 は同じダイジェストで両表を結んでいた）。
 * - 認証（[authenticate]）は `browser_sessions` だけを見る。有効（未期限切れ）なときだけ成功する。
 *   失効はブラウザセッションの行の削除（[PeripheralWrite.RevokeSubject]）で表すので、削除された行は見つからない。
 * - 復帰の認証（[authenticateRecovery]）は `credentials` だけを見る。未失効・未期限切れのときだけ成功する。
 * 不明・失効・期限切れは区別せず、どれも null を返す。
 */
internal class JdbcPeripheralStore {
    fun port(): PeripheralStore = PeripheralStore(::write, ::authenticate, ::authenticateRecovery, ::findGameByJoinCode)

    private fun write(
        tx: Tx,
        writes: List<PeripheralWrite>,
    ): Either<AppFailure, Unit> =
        tx.jdbc(OP_WRITE).flatMap { jdbcTx ->
            jdbcCall(OP_WRITE) {
                writes.forEach { JdbcPeripheralRows.write(jdbcTx, it) }
                Unit.right()
            }
        }

    private fun authenticate(
        tx: Tx,
        digest: String,
        now: Instant,
    ): Either<AppFailure, VerifiedCredential?> =
        tx.jdbc(OP_AUTHENTICATE).flatMap { jdbcTx ->
            jdbcCall(OP_AUTHENTICATE) {
                jdbcTx.connection.prepareStatement(AUTHENTICATE_SQL).use { ps ->
                    ps.params().string(digest).instant(now)
                    ps.executeQuery().use { rs -> (if (rs.next()) rs.toVerified() else null).right() }
                }
            }
        }

    private fun authenticateRecovery(
        tx: Tx,
        digest: String,
        now: Instant,
    ): Either<AppFailure, VerifiedRecovery?> =
        tx.jdbc(OP_AUTHENTICATE_RECOVERY).flatMap { jdbcTx ->
            jdbcCall(OP_AUTHENTICATE_RECOVERY) {
                jdbcTx.connection.prepareStatement(AUTHENTICATE_RECOVERY_SQL).use { ps ->
                    ps.params().string(digest).instant(now)
                    ps.executeQuery().use { rs -> (if (rs.next()) rs.toRecovery() else null).right() }
                }
            }
        }

    private fun ResultSet.toVerified(): VerifiedCredential? {
        val gameId = getUuid("game_id")?.let(::GameId)
        val actor = gameId?.let { actorOf(it, getString("actor_kind"), getUuid("actor_id")) }
        return if (gameId != null && actor != null) VerifiedCredential(gameId, actor) else null
    }

    private fun ResultSet.toRecovery(): VerifiedRecovery? {
        val gameId = getUuid("game_id")?.let(::GameId)
        val actorKind =
            when (getString("kind")) {
                CredentialKind.FACILITATOR.name -> JdbcPeripheralRows.ACTOR_FACILITATOR
                CredentialKind.PARTICIPANT_RECOVERY.name -> JdbcPeripheralRows.ACTOR_PARTICIPANT
                else -> null
            }
        val actor = gameId?.let { actorOf(it, actorKind, getUuid("subject_id")) }
        return if (gameId != null && actor != null) VerifiedRecovery(gameId, actor, getInstant("expires_at")) else null
    }

    private fun actorOf(
        gameId: GameId,
        actorKind: String?,
        actorId: UUID?,
    ): Actor? =
        when {
            actorKind == JdbcPeripheralRows.ACTOR_FACILITATOR -> {
                Actor.Facilitator(gameId)
            }

            actorKind == JdbcPeripheralRows.ACTOR_PARTICIPANT && actorId != null -> {
                Actor.Participant(ParticipantId(actorId))
            }

            else -> {
                null
            }
        }

    private fun findGameByJoinCode(
        tx: Tx,
        code: JoinCode,
    ): Either<AppFailure, GameId?> =
        tx.jdbc(OP_JOIN_CODE).flatMap { jdbcTx ->
            jdbcCall(OP_JOIN_CODE) {
                jdbcTx.connection.prepareStatement(JOIN_CODE_SQL).use { ps ->
                    ps.params().string(code.value)
                    ps.executeQuery().use { rs ->
                        (if (rs.next()) rs.getUuid("game_id")?.let(::GameId) else null).right()
                    }
                }
            }
        }

    private companion object {
        const val OP_WRITE = "peripheral.write"
        const val OP_AUTHENTICATE = "peripheral.authenticate"
        const val OP_AUTHENTICATE_RECOVERY = "peripheral.authenticateRecovery"
        const val OP_JOIN_CODE = "peripheral.findGameByJoinCode"
        const val AUTHENTICATE_SQL =
            "SELECT game_id, actor_kind, actor_id FROM browser_sessions WHERE credential_digest = ? AND expires_at > ?"
        const val AUTHENTICATE_RECOVERY_SQL =
            "SELECT game_id, kind, subject_id, expires_at FROM credentials " +
                "WHERE credential_digest = ? AND expires_at > ? AND revoked_at IS NULL"
        const val JOIN_CODE_SQL = "SELECT game_id FROM game_join_codes WHERE join_code = ?"
    }
}
