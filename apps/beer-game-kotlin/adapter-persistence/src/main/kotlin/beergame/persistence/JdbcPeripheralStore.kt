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
import beergame.domain.Actor
import beergame.domain.GameId
import beergame.domain.JoinCode
import beergame.domain.ParticipantId
import java.sql.ResultSet
import java.time.Instant

/**
 * 周辺ストア: 表示名（`display_profiles`）、資格のダイジェスト（`credentials`）、ブラウザセッション（`browser_sessions`）。
 * 生の資格は受け取らず、ダイジェストだけを書く。判断項目 #14: 資格を発行する行は、同じダイジェストの
 * `browser_sessions` の行と一緒に、追記と同じトランザクションで書く（B1 の仮置き。両方の期限は同じ）。
 * 認証は、ブラウザセッションが有効で、かつ資格が未失効・未期限切れのときだけ成功する（不明・失効・期限切れを区別しない）。
 */
internal class JdbcPeripheralStore {
    fun port(): PeripheralStore = PeripheralStore(::write, ::authenticate, ::findGameByJoinCode)

    private fun write(
        tx: Tx,
        writes: List<PeripheralWrite>,
    ): Either<AppFailure, Unit> =
        tx.jdbc(OP_WRITE).flatMap { jdbcTx ->
            jdbcCall(OP_WRITE) {
                writes.forEach { insert(jdbcTx, it) }
                Unit.right()
            }
        }

    private fun insert(
        tx: JdbcTx,
        write: PeripheralWrite,
    ) {
        when (write) {
            is PeripheralWrite.SaveDisplayName -> insertDisplayName(tx, write)
            is PeripheralWrite.IssueCredentialRow -> insertCredential(tx, write)
        }
    }

    private fun insertDisplayName(
        tx: JdbcTx,
        write: PeripheralWrite.SaveDisplayName,
    ) {
        tx.connection.prepareStatement(INSERT_DISPLAY_NAME_SQL).use { ps ->
            ps
                .params()
                .uuid(write.gameId.value)
                .string(ACTOR_PARTICIPANT)
                .uuid(write.participantId.value)
                .string(write.name.value)
                .instant(write.at)
            ps.executeUpdate()
        }
    }

    private fun insertCredential(
        tx: JdbcTx,
        write: PeripheralWrite.IssueCredentialRow,
    ) {
        tx.connection.prepareStatement(INSERT_CREDENTIAL_SQL).use { ps ->
            ps
                .params()
                .string(write.digest)
                .uuid(write.gameId.value)
                .string(write.kind.name)
                .uuid(write.subjectId)
                .int(write.keyVersion)
                .instant(write.issuedAt)
                .instant(write.expiresAt)
            ps.executeUpdate()
        }
        tx.connection.prepareStatement(INSERT_SESSION_SQL).use { ps ->
            ps
                .params()
                .string(write.digest)
                .uuid(write.gameId.value)
                .string(actorKindOf(write.kind))
                .uuid(write.subjectId)
                .int(write.keyVersion)
                .instant(write.expiresAt)
            ps.executeUpdate()
        }
    }

    private fun actorKindOf(kind: CredentialKind): String =
        when (kind) {
            CredentialKind.FACILITATOR -> ACTOR_FACILITATOR
            CredentialKind.PARTICIPANT_RECOVERY -> ACTOR_PARTICIPANT
        }

    private fun authenticate(
        tx: Tx,
        digest: String,
        now: Instant,
    ): Either<AppFailure, VerifiedCredential?> =
        tx.jdbc(OP_AUTHENTICATE).flatMap { jdbcTx ->
            jdbcCall(OP_AUTHENTICATE) {
                jdbcTx.connection.prepareStatement(AUTHENTICATE_SQL).use { ps ->
                    ps
                        .params()
                        .string(digest)
                        .instant(now)
                        .instant(now)
                    ps.executeQuery().use { rs -> (if (rs.next()) rs.toVerified() else null).right() }
                }
            }
        }

    private fun ResultSet.toVerified(): VerifiedCredential? {
        val gameId = getUuid("game_id")?.let(::GameId)
        val actorId = getUuid("actor_id")
        return when {
            gameId == null -> {
                null
            }

            getString("actor_kind") == ACTOR_FACILITATOR -> {
                VerifiedCredential(gameId, Actor.Facilitator(gameId))
            }

            getString("actor_kind") == ACTOR_PARTICIPANT && actorId != null -> {
                VerifiedCredential(gameId, Actor.Participant(ParticipantId(actorId)))
            }

            else -> {
                null
            }
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
        const val OP_JOIN_CODE = "peripheral.findGameByJoinCode"
        const val ACTOR_FACILITATOR = "FACILITATOR"
        const val ACTOR_PARTICIPANT = "PARTICIPANT"
        const val INSERT_DISPLAY_NAME_SQL =
            "INSERT INTO display_profiles (game_id, actor_kind, actor_id, display_name, created_at) " +
                "VALUES (?, ?, ?, ?, ?)"
        const val INSERT_CREDENTIAL_SQL =
            "INSERT INTO credentials " +
                "(credential_digest, game_id, kind, subject_id, key_version, issued_at, expires_at) " +
                "VALUES (?, ?, ?, ?, ?, ?, ?)"
        const val INSERT_SESSION_SQL =
            "INSERT INTO browser_sessions " +
                "(credential_digest, game_id, actor_kind, actor_id, key_version, expires_at) " +
                "VALUES (?, ?, ?, ?, ?, ?)"
        const val AUTHENTICATE_SQL =
            "SELECT s.game_id, s.actor_kind, s.actor_id FROM browser_sessions s " +
                "JOIN credentials c ON c.credential_digest = s.credential_digest " +
                "WHERE s.credential_digest = ? AND s.expires_at > ? AND c.expires_at > ? AND c.revoked_at IS NULL"
        const val JOIN_CODE_SQL = "SELECT game_id FROM game_join_codes WHERE join_code = ?"
    }
}
