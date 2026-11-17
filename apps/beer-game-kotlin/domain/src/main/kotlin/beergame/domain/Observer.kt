package beergame.domain

import arrow.core.Either
import arrow.core.raise.either
import arrow.core.raise.ensure
import arrow.core.raise.ensureNotNull
import java.time.Instant

/*
 * Game 集約の観察者（B9）。観察用の招待の発行・失効と、観察者の参加。規則は decide（このファイルの decideInvite など）に集まり、
 * evolve は事実を採用するだけ。招待コードの値はドメインに入れない（周辺ストアのダイジェストだけ。ドメインモデル D7）。
 * 観察者は役割を持たず、入力・確定・進行の操作は、操作者の種別で拒否される（Session の editorOf、進行役だけの操作）。
 */

/** 観察用の招待の有効性。有効期限と、失効したか。期限の瞬間から使えない。 */
@Term("観察用の招待", "進行役が発行する、観察者を招くためのコード。参加コードとは別の値で、失効または期限切れの招待では新しく参加できない", "AC1.3.1〜1.3.4、BR-17")
data class InvitationEntry(
    val expiresAt: Instant,
    val revoked: Boolean,
) {
    /** 時刻 [now] に、新しい参加に使えるか。 */
    fun isUsable(now: Instant): Boolean = !revoked && now.isBefore(expiresAt)
}

private const val FACILITATOR_ONLY = "観察用の招待の発行と失効は進行役だけができる"

/** 進行役の操作の前提。ゲームがあり、操作者がそのゲームの進行役。未作成は、進行役になれる人がいないので `Forbidden`。 */
private fun GameState.facilitatorData(actor: Actor): Either<GameError, GameData> =
    either {
        val data = ensureNotNull(dataOrNull()) { GameError.Forbidden(FACILITATOR_ONLY) }
        ensure(actor.isFacilitatorOf(data.gameId)) { GameError.Forbidden(FACILITATOR_ONLY) }
        data
    }

/** 観察用の招待を発行する。準備中と開始後の両方（プレイ中の観察のため）。 */
internal fun decideInvite(
    state: GameState,
    command: GameCommand.InviteObserver,
): Either<GameError, List<GameEvent>> =
    either {
        state.facilitatorData(command.actor).bind()
        listOf(GameEvent.ObserverInvited(command.invitationId, command.expiresAt))
    }

/** 失効していない招待を失効させる（期限切れの招待も失効させられる）。 */
internal fun decideRevokeInvitation(
    state: GameState,
    command: GameCommand.RevokeObserverInvitation,
): Either<GameError, List<GameEvent>> =
    either {
        val data = state.facilitatorData(command.actor).bind()
        val entry = ensureNotNull(data.invitations[command.invitationId]) { GameError.InvitationNotFound }
        ensure(!entry.revoked) { GameError.CredentialAlreadyRevoked }
        listOf(GameEvent.ObserverInvitationRevoked(command.invitationId))
    }

/**
 * 招待で観察者として参加する。不明・失効・期限切れは区別せず `InvitationInvalid`（列挙の防止。AC1.3.4）。
 * 招待コードから招待を引くのは境界なので、ここへは招待の ID が届く。
 */
internal fun decideJoinAsObserver(
    state: GameState,
    command: GameCommand.JoinAsObserver,
): Either<GameError, List<GameEvent>> =
    either {
        val data = ensureNotNull(state.dataOrNull()) { GameError.InvitationInvalid }
        val entry = ensureNotNull(data.invitations[command.invitationId]) { GameError.InvitationInvalid }
        ensure(entry.isUsable(command.at)) { GameError.InvitationInvalid }
        listOf(GameEvent.ObserverJoined(command.observerId, command.invitationId, command.credentialExpiresAt))
    }

/** 招待を足す。同じ ID の招待があれば、decide が作らない列（null）。 */
internal fun GameData.invited(
    invitationId: InvitationId,
    expiresAt: Instant,
): GameData? =
    if (invitationId in invitations) {
        null
    } else {
        copy(invitations = invitations + (invitationId to InvitationEntry(expiresAt, false)))
    }

/** 失効していない招待を失効にする。未知の招待と失効済みは、decide が作らない列（null）。 */
internal fun GameData.invitationRevoked(invitationId: InvitationId): GameData? =
    invitations[invitationId]
        ?.takeIf { !it.revoked }
        ?.let { copy(invitations = invitations + (invitationId to it.copy(revoked = true))) }

/** 観察者を足し、資格を発行する。未知の招待と、参加済みの観察者は、decide が作らない列（null）。 */
internal fun GameData.observerJoined(
    observerId: ObserverId,
    invitationId: InvitationId,
    credentialExpiresAt: Instant,
): GameData? =
    if (invitationId !in invitations || observerId in observers) {
        null
    } else {
        copy(observers = observers + (observerId to invitationId))
            .withIssued(CredentialSubject.Observer(observerId), credentialExpiresAt)
    }
