package beergame.application

import arrow.core.Either
import beergame.domain.Actor
import beergame.domain.ActorRef
import beergame.domain.CredentialSubject
import beergame.domain.DisplayName
import beergame.domain.DomainEvent
import beergame.domain.EventEnvelope
import beergame.domain.GameCommand
import beergame.domain.GameEvent
import beergame.domain.GameId
import beergame.domain.JoinCode
import beergame.domain.ParticipantId
import java.time.Duration
import java.time.Instant
import java.util.UUID

/*
 * 資格（進行役の資格、参加者の復帰資格）と周辺ストア（表示名、資格のダイジェスト、ブラウザセッション）。
 * 判断項目 #14（B1）: 資格を発行するコマンド（作成、参加）が、`credentials` と `browser_sessions` を、
 * 追記と同じトランザクションで書く。生の値は応答だけが運び、DB にもイベントにも入れない（NF-S14）。
 *
 * B5 Step 4: **ブラウザセッションと復帰資格は、別の値・別のダイジェスト**にする（B1 は 1 つの値で兼ねた）。
 * - ブラウザセッション（`browser_sessions`。24 時間）: 操作の認証に使う。Cookie `bg_session`。
 * - 復帰資格（`credentials`。参加者は 30 日、進行役はゲームの保持期間）: 復帰（`RecoverParticipation`）だけに使う。
 * 失効（`CredentialRevoked`）は、同じトランザクションで、主体の復帰資格の行を失効させ、ブラウザセッションの行を削除する
 * （H2 案 A。失効後の再発行で、古いセッションが復活しない）。
 */

/** 資格の種別。観察用の招待（B9）は含めない。 */
enum class CredentialKind { FACILITATOR, PARTICIPANT_RECOVERY }

/**
 * 応答だけが運ぶ、資格の生の値と主体。[expiresAt] は、再発行した復帰資格の有効期限（応答に示す。冪等な再送でも同じ値を返すため、
 * 冪等記録に含める）。ほかの資格は null。
 */
data class IssuedCredential(
    val raw: String,
    val kind: CredentialKind,
    val actor: ActorRef,
    val expiresAt: Instant? = null,
)

/** 発行した資格と、保存するダイジェストとそれを作った鍵の版。生の値は、ダイジェストの元になった値。 */
internal data class DigestedCredential(
    val digest: String,
    val keyVersion: Int,
    val credential: IssuedCredential,
)

/** 作成・参加が一度に発行する 2 つの資格。別の乱数・別のダイジェスト。 */
internal data class Issuance(
    val session: DigestedCredential,
    val recovery: DigestedCredential,
)

/** ブラウザセッションの検証結果。有効（未期限切れ。失効は行の削除）なときだけ返る。 */
data class VerifiedCredential(
    val gameId: GameId,
    val actor: Actor,
)

/** 復帰資格の検証結果。有効（未失効・未期限切れ）なときだけ返る。[expiresAt] は現在の期限。 */
data class VerifiedRecovery(
    val gameId: GameId,
    val actor: Actor,
    val expiresAt: Instant,
)

/** 資格の digest（鍵付き HMAC-SHA256。冪等キーの digest とは、部分の並びが違うので衝突しない）。 */
object CredentialDigest {
    fun of(
        secret: ByteArray,
        raw: String,
    ): String = Hmac.hex(secret, listOf("credential", raw))
}

/** 追記と同じトランザクションで書く、イベント以外の行。 */
sealed interface PeripheralWrite {
    data class SaveDisplayName(
        val gameId: GameId,
        val participantId: ParticipantId,
        val name: DisplayName,
        val at: Instant,
    ) : PeripheralWrite

    /** `credentials` の行（復帰資格）を足す。作成・参加・再発行で発行する。 */
    data class IssueRecoveryRow(
        val gameId: GameId,
        val digest: String,
        val kind: CredentialKind,
        val subjectId: UUID,
        val keyVersion: Int,
        val issuedAt: Instant,
        val expiresAt: Instant,
    ) : PeripheralWrite

    /** `browser_sessions` の行（ブラウザセッション）を足す。作成・参加・復帰で発行する。 */
    data class IssueSessionRow(
        val gameId: GameId,
        val digest: String,
        val kind: CredentialKind,
        val subjectId: UUID,
        val keyVersion: Int,
        val expiresAt: Instant,
    ) : PeripheralWrite

    /** 復帰資格の期限を新しくする（復帰）。失効した行は更新しない。 */
    data class ExtendRecoveryRow(
        val digest: String,
        val expiresAt: Instant,
    ) : PeripheralWrite

    /** 主体の復帰資格を失効させ、その主体のブラウザセッションを削除する。`CredentialRevoked` から導く。 */
    data class RevokeSubject(
        val gameId: GameId,
        val subject: CredentialSubject,
        val at: Instant,
    ) : PeripheralWrite
}

/**
 * 周辺ストア。
 * - [write]: 表示名と資格の行（追記の後、同じトランザクションで）。
 * - [authenticate]: ブラウザセッションのダイジェストから操作者を引く。不明・期限切れ・失効（行の削除）は null（区別しない）。
 * - [authenticateRecovery]: 復帰資格のダイジェストから主体を引く。不明・失効・期限切れは null（区別しない）。
 * - [findGameByJoinCode]: 参加コードからゲームを引く（投影 `game_join_codes`）。
 */
data class PeripheralStore(
    val write: suspend (Tx, List<PeripheralWrite>) -> Either<AppFailure, Unit>,
    val authenticate: suspend (Tx, String, Instant) -> Either<AppFailure, VerifiedCredential?>,
    val authenticateRecovery: suspend (Tx, String, Instant) -> Either<AppFailure, VerifiedRecovery?>,
    val findGameByJoinCode: suspend (Tx, JoinCode) -> Either<AppFailure, GameId?>,
)

/**
 * 周辺ストアに書く行を、純粋に導く。呼び出し側（追記したときだけ）が、決まった事実（空でない）の後に呼ぶ。
 * 表示名と資格の値はイベントに入れない（ドメインモデル D7）ので、コマンドが運んだ値から作る。
 * 資格を発行しない（[issuance] が無い）コマンドは、何も書かない。ブラウザセッションの期限は [sessionTtl]。
 */
internal fun peripheralWrites(
    gameId: GameId,
    command: GameCommand,
    issuance: Issuance?,
    sessionTtl: Duration,
    now: Instant,
): List<PeripheralWrite> =
    when {
        issuance == null -> {
            emptyList()
        }

        command is GameCommand.CreateGame -> {
            issuance.rows(gameId, gameId.value, now, command.facilitatorCredentialExpiresAt, sessionTtl)
        }

        command is GameCommand.JoinGame -> {
            listOf<PeripheralWrite>(
                PeripheralWrite.SaveDisplayName(gameId, command.participantId, command.displayName, now),
            ) + issuance.rows(gameId, command.participantId.value, now, command.credentialExpiresAt, sessionTtl)
        }

        else -> {
            emptyList()
        }
    }

private fun Issuance.rows(
    gameId: GameId,
    subjectId: UUID,
    now: Instant,
    recoveryExpiresAt: Instant,
    sessionTtl: Duration,
): List<PeripheralWrite> =
    listOf(
        PeripheralWrite.IssueRecoveryRow(
            gameId,
            recovery.digest,
            recovery.credential.kind,
            subjectId,
            recovery.keyVersion,
            now,
            recoveryExpiresAt,
        ),
        PeripheralWrite.IssueSessionRow(
            gameId,
            session.digest,
            session.credential.kind,
            subjectId,
            session.keyVersion,
            now.plus(sessionTtl),
        ),
    )

/**
 * 追記したイベントから、資格の行の変更を導く。**`CredentialRevoked` があれば、必ず、対応する失効の行の変更を書く**
 * （資格の行の変更が、対応するイベントなしに起きない・イベントだけが書かれて行が残らない、のどちらも防ぐ）。
 * 手動の失効と、役割の入れ替えでの自動の失効（`ParticipantReplaced` と対の `CredentialRevoked`）の両方に効く。
 */
internal fun revocationWrites(envelopes: List<EventEnvelope<DomainEvent>>): List<PeripheralWrite> =
    envelopes.mapNotNull { envelope ->
        (envelope.payload as? GameEvent.CredentialRevoked)?.let {
            PeripheralWrite.RevokeSubject(envelope.gameId, it.subject, envelope.occurredAt)
        }
    }
