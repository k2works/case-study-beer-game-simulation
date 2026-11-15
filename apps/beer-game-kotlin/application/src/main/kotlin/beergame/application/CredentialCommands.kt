package beergame.application

import arrow.core.Either
import arrow.core.raise.either
import arrow.core.raise.ensureNotNull
import beergame.domain.Actor
import beergame.domain.ActorRef
import beergame.domain.CredentialSubject
import beergame.domain.GameCommand
import beergame.domain.GameId
import java.util.UUID

/*
 * 資格の失効・再発行・復帰（B5）。**application の内側の操作**で、HTTP・公開の関数への配線は Step 6 が行う
 * （入力の形の検証、経路、`Set-Cookie`・復帰コードの応答は Step 6）。ここは、認可 → 冪等記録の照合の順序
 * （ADR-004）と、資格の行の変更が追記と同じトランザクションにあること（Step 4）を、実際のコマンドで確かめるための土台。
 * - 失効: 進行役のブラウザセッションが認可。`CredentialRevoked` に付く行の変更（復帰資格の失効とブラウザセッションの削除）は、
 *   追記の共通の流れ（[revocationWrites]）が書く。
 * - 再発行: 進行役のブラウザセッションが認可。新しい復帰資格の値は、応答（[CommandOutcome.recovery]）だけが運ぶ。
 * - 復帰: **提示した復帰資格の有効性が認可**（[Auth.RECOVERY]。冪等記録の照合より前に検証する）。新しいブラウザセッションを発行し、
 *   復帰資格の期限を新しくする。
 */

private fun CredentialSubject.rowId(): UUID =
    when (this) {
        is CredentialSubject.Facilitator -> gameId.value
        is CredentialSubject.Participant -> id.value
    }

private fun CredentialSubject.operationKey(): String =
    when (this) {
        is CredentialSubject.Facilitator -> "facilitator"
        is CredentialSubject.Participant -> id.value.toString()
    }

private fun CredentialSubject.actorRef(): ActorRef =
    when (this) {
        is CredentialSubject.Facilitator -> Actor.Facilitator(gameId).toRef()
        is CredentialSubject.Participant -> Actor.Participant(id).toRef()
    }

private fun Actor.subject(): CredentialSubject? =
    when (this) {
        is Actor.Facilitator -> CredentialSubject.Facilitator(gameId)
        is Actor.Participant -> CredentialSubject.Participant(id)
        is Actor.Anonymous -> null
    }

private fun CredentialSubject.kind(): CredentialKind =
    when (this) {
        is CredentialSubject.Facilitator -> CredentialKind.FACILITATOR
        is CredentialSubject.Participant -> CredentialKind.PARTICIPANT_RECOVERY
    }

/** 進行役が、参加者の資格を失効させる。復帰資格を失効させ、そのブラウザセッションを止める（同じトランザクション）。 */
internal suspend fun Ports.revokeCredential(
    gameId: GameId,
    subject: CredentialSubject,
    meta: RequestMeta,
): Either<AppFailure, CommandOutcome> {
    val key = subject.operationKey()
    val request =
        CommandRequest(Operation(gameId, "revoke:$key", "revoke|$key"), Auth.REQUIRED, STATUS_OK, meta)
    return runCommand(request) { tx, ctx ->
        applySingle(tx, ctx, gameStream, GameCommand.RevokeCredential(ctx.actor, ctx.at, subject))
    }
}

/** 進行役が、失効した参加者の資格を再発行する。新しい復帰資格の値は、この応答だけが運ぶ（再表示しない）。 */
internal suspend fun Ports.reissueCredential(
    gameId: GameId,
    subject: CredentialSubject,
    meta: RequestMeta,
): Either<AppFailure, CommandOutcome> {
    val key = subject.operationKey()
    val recovery = issue(subject.kind(), subject.actorRef())
    val request =
        CommandRequest(
            Operation(gameId, "reissue:$key", "reissue|$key"),
            Auth.REQUIRED,
            STATUS_OK,
            meta,
            recovery = { recovery.credential },
        )
    return runCommand(request) { tx, ctx ->
        val expiresAt = ctx.at.plus(settings.participantCredentialTtl)
        val command = GameCommand.ReissueCredential(ctx.actor, ctx.at, subject, expiresAt)
        applySingle(tx, ctx, gameStream, command) {
            listOf(
                PeripheralWrite.IssueRecoveryRow(
                    gameId,
                    recovery.digest,
                    recovery.credential.kind,
                    subject.rowId(),
                    recovery.keyVersion,
                    ctx.at,
                    expiresAt,
                ),
            )
        }
    }
}

/**
 * 提示した復帰資格（[RequestMeta.credential]）で復帰する。復帰資格が無効（不明・失効・期限切れ・別のゲーム・鍵が外された版）なら、
 * 理由を区別せず [AppFailure.Unauthorized]（冪等記録を検索する前）。有効なら、新しいブラウザセッションを発行し、復帰資格の期限を新しくする
 * （参加者は復帰した時刻から [AppSettings.participantCredentialTtl]。進行役は保持期間の期限のまま）。
 */
internal suspend fun Ports.recoverParticipation(
    gameId: GameId,
    meta: RequestMeta,
): Either<AppFailure, CommandOutcome> {
    val session = settings.credentialKeys.mint(newCredential())
    val request =
        CommandRequest(
            Operation(gameId, SCOPE_RECOVER, SCOPE_RECOVER),
            Auth.RECOVERY,
            STATUS_OK,
            meta,
            issued = { actor -> actor.subject()?.let { IssuedCredential(session.raw, it.kind(), it.actorRef()) } },
        )
    return runCommand(request) { tx, ctx ->
        either {
            val subject = ensureNotNull(ctx.actor.subject()) { AppFailure.Unauthorized }
            val presented = ensureNotNull(ctx.presented) { AppFailure.Unauthorized }
            val expiresAt =
                when (subject) {
                    is CredentialSubject.Participant -> ctx.at.plus(settings.participantCredentialTtl)
                    is CredentialSubject.Facilitator -> presented.expiresAt
                }
            val command = GameCommand.RecoverParticipation(ctx.actor, ctx.at, subject, expiresAt)
            applySingle(tx, ctx, gameStream, command) {
                listOf(
                    PeripheralWrite.ExtendRecoveryRow(presented.digest, expiresAt),
                    PeripheralWrite.IssueSessionRow(
                        gameId,
                        session.digest,
                        subject.kind(),
                        subject.rowId(),
                        session.keyVersion,
                        ctx.at.plus(settings.sessionTtl),
                    ),
                )
            }.bind()
        }
    }
}

private const val STATUS_OK = 200
private const val SCOPE_RECOVER = "recover"
