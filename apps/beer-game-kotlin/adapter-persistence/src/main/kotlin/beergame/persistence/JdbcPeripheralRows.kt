package beergame.persistence

import beergame.application.CredentialKind
import beergame.application.PeripheralWrite
import beergame.domain.CredentialSubject
import java.util.UUID

/**
 * 周辺ストアの書き込み（表示名、復帰資格、ブラウザセッション、失効）の SQL。生の資格は受け取らず、ダイジェストだけを書く。
 * 失効（[PeripheralWrite.RevokeSubject]）は、主体の復帰資格を失効させ、同じ主体のブラウザセッションの行を**削除**する
 * （B5 の H2 案 A。スキーマ変更なし。失効後の再発行で、古いセッションは復活しない）。呼び出し側のトランザクションの中で実行する。
 */
internal object JdbcPeripheralRows {
    fun write(
        tx: JdbcTx,
        write: PeripheralWrite,
    ) {
        when (write) {
            is PeripheralWrite.SaveDisplayName -> insertDisplayName(tx, write)
            is PeripheralWrite.IssueRecoveryRow -> insertRecovery(tx, write)
            is PeripheralWrite.IssueSessionRow -> insertSession(tx, write)
            is PeripheralWrite.ExtendRecoveryRow -> extendRecovery(tx, write)
            is PeripheralWrite.RevokeSubject -> revokeSubject(tx, write)
            is PeripheralWrite.SaveObserverName -> insertObserverName(tx, write)
            is PeripheralWrite.RevokeInvitationRow -> revokeInvitation(tx, write)
        }
    }

    private fun insertObserverName(
        tx: JdbcTx,
        write: PeripheralWrite.SaveObserverName,
    ) {
        tx.connection.prepareStatement(INSERT_DISPLAY_NAME_SQL).use { ps ->
            ps
                .params()
                .uuid(write.gameId.value)
                .string(ACTOR_OBSERVER)
                .uuid(write.observerId.value)
                .string(write.name.value)
                .instant(write.at)
            ps.executeUpdate()
        }
    }

    /** 観察用の招待の行を失効させる。すでに参加した観察者のブラウザセッションは、そのまま残る（AC1.3.4）。 */
    private fun revokeInvitation(
        tx: JdbcTx,
        write: PeripheralWrite.RevokeInvitationRow,
    ) {
        tx.connection.prepareStatement(REVOKE_CREDENTIALS_SQL).use { ps ->
            ps
                .params()
                .instant(write.at)
                .uuid(write.gameId.value)
                .string(CredentialKind.OBSERVER_INVITATION.name)
                .uuid(write.invitationId.value)
            ps.executeUpdate()
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

    private fun insertRecovery(
        tx: JdbcTx,
        write: PeripheralWrite.IssueRecoveryRow,
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
    }

    private fun insertSession(
        tx: JdbcTx,
        write: PeripheralWrite.IssueSessionRow,
    ) {
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

    /** 失効した行は更新しない（失効は、再発行（新しい行）でだけ解く）。 */
    private fun extendRecovery(
        tx: JdbcTx,
        write: PeripheralWrite.ExtendRecoveryRow,
    ) {
        tx.connection.prepareStatement(EXTEND_CREDENTIAL_SQL).use { ps ->
            ps.params().instant(write.expiresAt).string(write.digest)
            ps.executeUpdate()
        }
    }

    private fun revokeSubject(
        tx: JdbcTx,
        write: PeripheralWrite.RevokeSubject,
    ) {
        val (kind, subjectId) = write.subject.rowKey()
        tx.connection.prepareStatement(REVOKE_CREDENTIALS_SQL).use { ps ->
            ps
                .params()
                .instant(write.at)
                .uuid(write.gameId.value)
                .string(kind.name)
                .uuid(subjectId)
            ps.executeUpdate()
        }
        tx.connection.prepareStatement(DELETE_SESSIONS_SQL).use { ps ->
            ps
                .params()
                .uuid(write.gameId.value)
                .string(actorKindOf(kind))
                .uuid(subjectId)
            ps.executeUpdate()
        }
    }

    private fun CredentialSubject.rowKey(): Pair<CredentialKind, UUID> =
        when (this) {
            is CredentialSubject.Facilitator -> CredentialKind.FACILITATOR to gameId.value
            is CredentialSubject.Participant -> CredentialKind.PARTICIPANT_RECOVERY to id.value
            is CredentialSubject.Observer -> CredentialKind.OBSERVER to id.value
        }

    private fun actorKindOf(kind: CredentialKind): String =
        when (kind) {
            CredentialKind.FACILITATOR -> ACTOR_FACILITATOR
            CredentialKind.PARTICIPANT_RECOVERY -> ACTOR_PARTICIPANT
            CredentialKind.OBSERVER, CredentialKind.OBSERVER_INVITATION -> ACTOR_OBSERVER
        }

    const val ACTOR_FACILITATOR = "FACILITATOR"
    const val ACTOR_PARTICIPANT = "PARTICIPANT"
    const val ACTOR_OBSERVER = "OBSERVER"
    private const val INSERT_DISPLAY_NAME_SQL =
        "INSERT INTO display_profiles (game_id, actor_kind, actor_id, display_name, created_at) " +
            "VALUES (?, ?, ?, ?, ?)"
    private const val INSERT_CREDENTIAL_SQL =
        "INSERT INTO credentials " +
            "(credential_digest, game_id, kind, subject_id, key_version, issued_at, expires_at) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?)"
    private const val INSERT_SESSION_SQL =
        "INSERT INTO browser_sessions " +
            "(credential_digest, game_id, actor_kind, actor_id, key_version, expires_at) " +
            "VALUES (?, ?, ?, ?, ?, ?)"
    private const val EXTEND_CREDENTIAL_SQL =
        "UPDATE credentials SET expires_at = ? WHERE credential_digest = ? AND revoked_at IS NULL"
    private const val REVOKE_CREDENTIALS_SQL =
        "UPDATE credentials SET revoked_at = ? " +
            "WHERE game_id = ? AND kind = ? AND subject_id = ? AND revoked_at IS NULL"
    private const val DELETE_SESSIONS_SQL =
        "DELETE FROM browser_sessions WHERE game_id = ? AND actor_kind = ? AND actor_id = ?"
}
