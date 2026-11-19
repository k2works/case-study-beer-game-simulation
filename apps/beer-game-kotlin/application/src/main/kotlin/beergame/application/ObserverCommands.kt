package beergame.application

import arrow.core.Either
import arrow.core.raise.either
import arrow.core.raise.ensureNotNull
import beergame.domain.Actor
import beergame.domain.DisplayName
import beergame.domain.GameCommand
import beergame.domain.GameError
import beergame.domain.GameId
import beergame.domain.InvitationId
import beergame.domain.ObserverId
import java.time.Instant

/*
 * 観察者（B9）。HTTP の層が呼ぶ公開の操作。経路・入力の形の検証・`Set-Cookie`・招待コードの応答は HTTP の層。
 * - 招待の発行・失効: 進行役のブラウザセッションが認可（decide が進行役だけに限る）。招待コードの値は、発行の応答だけが運び、
 *   保存するのはダイジェストだけ（`credentials`、`kind = OBSERVER_INVITATION`）。イベントには招待の ID と期限だけを入れる。
 * - 観察者の参加: 認可は招待コード。不明・失効・期限切れ・形式不正は、区別せず `game.invitation_invalid`（AC1.3.4）。
 *   参加と同じ接続元の窓で数える（総当たりで招待コードを当てられない）。観察者はブラウザセッションだけを受け取り、復帰資格は持たない。
 */

/** 観察用の招待の発行の応答。招待の ID は、[IssuedCredential.actor] の ID に入れる（[invitationIdOf]）。 */
private fun invitationCredential(
    minted: MintedCredential,
    gameId: GameId,
    invitationId: InvitationId,
    expiresAt: Instant,
): IssuedCredential =
    IssuedCredential(
        minted.raw,
        CredentialKind.OBSERVER_INVITATION,
        Actor.Facilitator(gameId).toRef().copy(id = invitationId.value),
        expiresAt,
    )

/** 発行した招待の応答から、招待の ID を取り出す。招待の発行だけが持つ。 */
fun invitationIdOf(issued: IssuedCredential): InvitationId =
    InvitationId(checkNotNull(issued.actor.id) { "招待の ID が無い" })

/** 進行役が、観察用の招待を発行する（AC1.3.1）。招待コードは、参加コードとは別の乱数と別のダイジェスト。 */
suspend fun Ports.inviteObserver(
    gameId: GameId,
    meta: RequestMeta,
): Either<AppFailure, CommandOutcome> {
    val invitationId = InvitationId(newId())
    val minted = settings.credentialKeys.mint(newJoinCode())
    val request =
        CommandRequest(
            Operation(gameId, "invite-observer", "invite-observer"),
            Auth.REQUIRED,
            STATUS_OK,
            meta,
            // 応答に示す有効期限は、イベントの期限（ctx.at + 期間）と同じ時刻から作る（冪等な再送でも同じ値）
            recovery = {
                _,
                at,
                ->
                invitationCredential(minted, gameId, invitationId, at.plus(settings.observerInvitationTtl))
            },
        )
    return runCommand(request) { tx, ctx ->
        val expiresAt = ctx.at.plus(settings.observerInvitationTtl)
        val command = GameCommand.InviteObserver(ctx.actor, ctx.at, invitationId, expiresAt)
        applySingle(tx, ctx, gameStream, command) {
            listOf(
                PeripheralWrite.IssueRecoveryRow(
                    gameId,
                    minted.digest,
                    CredentialKind.OBSERVER_INVITATION,
                    invitationId.value,
                    minted.keyVersion,
                    ctx.at,
                    expiresAt,
                ),
            )
        }
    }
}

/** 進行役が、観察用の招待を失効させる（AC1.3.4）。すでに参加した観察者は影響を受けない。 */
suspend fun Ports.revokeObserverInvitation(
    gameId: GameId,
    invitationId: InvitationId,
    meta: RequestMeta,
): Either<AppFailure, CommandOutcome> {
    val key = invitationId.value.toString()
    val request =
        CommandRequest(
            Operation(gameId, "revoke-invitation:$key", "revoke-invitation|$key"),
            Auth.REQUIRED,
            STATUS_OK,
            meta,
        )
    return runCommand(request) { tx, ctx ->
        val command = GameCommand.RevokeObserverInvitation(ctx.actor, ctx.at, invitationId)
        applySingle(tx, ctx, gameStream, command) {
            listOf(PeripheralWrite.RevokeInvitationRow(gameId, invitationId, ctx.at))
        }
    }
}

data class JoinObserverInput(
    val invitationCode: String,
    val displayName: String,
)

/**
 * 観察用の招待コードと表示名で、観察者として参加する。入力の形（表示名）の検証は、窓に数えない。
 * 招待コードの検査から先を、接続元ごとの窓で制限する（参加と同じ窓）。
 */
suspend fun Ports.joinAsObserver(
    input: JoinObserverInput,
    meta: RequestMeta,
): Either<AppFailure, CommandOutcome> =
    either {
        val name =
            DisplayName
                .of(input.displayName)
                .nel()
                .mapLeft(AppFailure::Invalid)
                .bind()
        limitedAttempts(AttemptScope.JOIN, meta.source) { joinWithInvitation(input.invitationCode, name, meta) }.bind()
    }

private suspend fun Ports.joinWithInvitation(
    invitationCode: String,
    name: DisplayName,
    meta: RequestMeta,
): Either<AppFailure, CommandOutcome> =
    either {
        val keyed = ensureNotNull(settings.credentialKeys.digest(invitationCode)) { invalidInvitation() }
        val found =
            ensureNotNull(events.transaction { tx -> peripheral.findInvitation(tx, keyed.digest) }.bind()) {
                invalidInvitation()
            }
        val observerId = ObserverId(newId())
        val session = issue(CredentialKind.OBSERVER, Actor.Observer(observerId).toRef())
        val operation = Operation(found.gameId, "observe", "observe|${found.invitationId.value}|${name.value}")
        val request =
            CommandRequest(operation, Auth.ANONYMOUS, STATUS_OK, meta, issued = { session.credential })
        runCommand(request) { tx, ctx ->
            val command =
                GameCommand.JoinAsObserver(
                    ctx.actor,
                    ctx.at,
                    observerId,
                    found.invitationId,
                    name,
                    ctx.at.plus(settings.participantCredentialTtl),
                )
            applySingle(tx, ctx, gameStream, command) {
                listOf(
                    PeripheralWrite.SaveObserverName(found.gameId, observerId, name, ctx.at),
                    PeripheralWrite.IssueSessionRow(
                        found.gameId,
                        session.digest,
                        CredentialKind.OBSERVER,
                        observerId.value,
                        session.keyVersion,
                        ctx.at.plus(settings.sessionTtl),
                    ),
                )
            }
        }.bind()
    }

private fun invalidInvitation(): AppFailure = AppFailure.Domain(GameError.InvitationInvalid)

private const val STATUS_OK = 200
