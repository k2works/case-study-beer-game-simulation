package beergame.application

import arrow.core.Either
import beergame.domain.Actor
import beergame.domain.ActorRef
import beergame.domain.DisplayName
import beergame.domain.GameCommand
import beergame.domain.GameId
import beergame.domain.JoinCode
import beergame.domain.ParticipantId
import java.time.Instant
import java.util.UUID

/*
 * 資格（進行役の資格、参加者の復帰資格）と周辺ストア（表示名、資格のダイジェスト、ブラウザセッション）。
 * 判断項目 #14（B1）: 資格を発行するコマンド（作成、参加）が、`credentials` と `browser_sessions` を、同じダイジェストで、
 * 追記と同じトランザクションで書く。生の値は応答だけが運び、DB にもイベントにも入れない（NF-S14）。
 */

/** 資格の種別。観察用の招待（B9）は含めない。 */
enum class CredentialKind { FACILITATOR, PARTICIPANT_RECOVERY }

/** 応答だけが運ぶ、資格の生の値と主体。 */
data class IssuedCredential(
    val raw: String,
    val kind: CredentialKind,
    val actor: ActorRef,
)

/** 発行した資格と、保存するダイジェスト。生の値は、ダイジェストの元になった値。 */
internal data class DigestedCredential(
    val digest: String,
    val credential: IssuedCredential,
)

/** 資格の検証結果。有効（未失効・未期限切れ）なときだけ返る。 */
data class VerifiedCredential(
    val gameId: GameId,
    val actor: Actor,
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

    /** `credentials` と、同じダイジェストの `browser_sessions` の行（B1 の仮置き。[expiresAt] は両方に使う）。 */
    data class IssueCredentialRow(
        val gameId: GameId,
        val digest: String,
        val kind: CredentialKind,
        val subjectId: UUID,
        val keyVersion: Int,
        val issuedAt: Instant,
        val expiresAt: Instant,
    ) : PeripheralWrite
}

/**
 * 周辺ストア。
 * - [write]: 表示名と資格の行（追記の後、同じトランザクションで）。
 * - [authenticate]: ダイジェストから操作者を引く。不明・失効・期限切れは null（区別しない）。
 * - [findGameByJoinCode]: 参加コードからゲームを引く（投影 `game_join_codes`）。
 */
data class PeripheralStore(
    val write: suspend (Tx, List<PeripheralWrite>) -> Either<AppFailure, Unit>,
    val authenticate: suspend (Tx, String, Instant) -> Either<AppFailure, VerifiedCredential?>,
    val findGameByJoinCode: suspend (Tx, JoinCode) -> Either<AppFailure, GameId?>,
)

/**
 * 周辺ストアに書く行を、純粋に導く。呼び出し側（追記したときだけ）が、決まった事実（空でない）の後に呼ぶ。
 * 表示名と資格の値はイベントに入れない（ドメインモデル D7）ので、コマンドが運んだ値から作る。
 * 資格を発行しない（[issued] が無い）コマンドは、何も書かない。
 */
internal fun peripheralWrites(
    gameId: GameId,
    command: GameCommand,
    issued: DigestedCredential?,
    keyVersion: Int,
    now: Instant,
): List<PeripheralWrite> =
    when {
        issued == null -> {
            emptyList()
        }

        command is GameCommand.CreateGame -> {
            listOf(issued.row(gameId, gameId.value, keyVersion, now, command.facilitatorCredentialExpiresAt))
        }

        command is GameCommand.JoinGame -> {
            listOf(
                PeripheralWrite.SaveDisplayName(gameId, command.participantId, command.displayName, now),
                issued.row(gameId, command.participantId.value, keyVersion, now, command.credentialExpiresAt),
            )
        }

        else -> {
            emptyList()
        }
    }

private fun DigestedCredential.row(
    gameId: GameId,
    subjectId: UUID,
    keyVersion: Int,
    now: Instant,
    expiresAt: Instant,
): PeripheralWrite =
    PeripheralWrite.IssueCredentialRow(gameId, digest, credential.kind, subjectId, keyVersion, now, expiresAt)
