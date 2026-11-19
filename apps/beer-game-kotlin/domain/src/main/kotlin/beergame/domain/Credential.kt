package beergame.domain

import arrow.core.Either
import arrow.core.raise.either
import arrow.core.raise.ensure
import arrow.core.raise.ensureNotNull
import java.time.Instant

/*
 * Game 集約の資格（失効・再発行・復帰。B5）。資格の値（ダイジェスト）はドメインに入れず、有効性だけを持つ。
 * 規則は decide（このファイルの decideRevoke・decideReissue・decideRecover）に集まり、evolve は事実を採用するだけ。
 */

/** 資格の主体。進行役・参加者・観察者（B9）。失効・再発行・復帰の対象は、参加者（復帰は進行役も）だけ。 */
@Term("資格の主体", "資格を持つ人。進行役（ゲーム単位）、参加者、観察者。資格の失効・再発行・復帰は、主体ごとに行う（観察者は対象外）", "ドメインモデル 資格、AC3.2.5")
sealed interface CredentialSubject {
    data class Facilitator(
        val gameId: GameId,
    ) : CredentialSubject

    data class Participant(
        val id: ParticipantId,
    ) : CredentialSubject

    /** 観察者。参加（`ObserverJoined`）で資格を持つが、失効・再発行・復帰の対象ではない（観察者の復帰は設計の未決）。 */
    data class Observer(
        val id: ObserverId,
    ) : CredentialSubject
}

/** ある時刻での資格の状態。失効は期限より優先する。 */
enum class CredentialStatus { VALID, REVOKED, EXPIRED }

/**
 * 資格の有効性。有効期限と、失効したか。発行・失効の時刻はイベントの封筒（occurredAt）が持ち、evolve は時刻を読まないので、
 * 状態には持たない（設計書の「発行時刻・失効時刻」からの差）。期限の瞬間から使えない。
 */
@Term("資格の有効性", "資格の有効期限と、失効したか。失効は期限より優先する。期限の瞬間から使えない。不明・失効・期限切れは、利用者には区別して見せない", "AC3.2.2、AC3.2.5、NF-S12")
data class CredentialValidity(
    val expiresAt: Instant,
    val revoked: Boolean,
) {
    fun status(now: Instant): CredentialStatus =
        when {
            revoked -> CredentialStatus.REVOKED
            now.isBefore(expiresAt) -> CredentialStatus.VALID
            else -> CredentialStatus.EXPIRED
        }
}

/** 操作者が、資格の主体として復帰を求めているときの主体。匿名は主体を持たない。 */
internal fun Actor.asSubject(): CredentialSubject? =
    when (this) {
        is Actor.Facilitator -> CredentialSubject.Facilitator(gameId)
        is Actor.Participant -> CredentialSubject.Participant(id)
        is Actor.Observer -> CredentialSubject.Observer(id)
        is Actor.Anonymous -> null
    }

private const val FACILITATOR_ONLY = "失効と再発行は進行役だけができる"
private const val FACILITATOR_NOT_TARGET = "進行役自身の資格は失効・再発行の対象外"

/** 復帰の失敗は、不明・失効・期限切れ・別の主体を区別しない同じ値にする（NF-S12。資格の存在を漏らさない）。 */
private val recoveryRefused: GameError = GameError.Forbidden("復帰できない")

/**
 * 失効・再発行に共通の前提。進行役の操作で、対象は参加者の資格で、その資格が存在する。
 * 未作成は、進行役になれる人がいないので `Forbidden`。進行役自身の資格は対象外（ゲート 1 の決定）。
 */
private fun GameState.participantCredential(
    actor: Actor,
    subject: CredentialSubject,
): Either<GameError, CredentialValidity> =
    either {
        val data = ensureNotNull(dataOrNull()) { GameError.Forbidden(FACILITATOR_ONLY) }
        ensure(actor.isFacilitatorOf(data.gameId)) { GameError.Forbidden(FACILITATOR_ONLY) }
        val participantId =
            when (subject) {
                is CredentialSubject.Facilitator, is CredentialSubject.Observer -> {
                    raise(GameError.Forbidden(FACILITATOR_NOT_TARGET))
                }

                is CredentialSubject.Participant -> {
                    subject.id
                }
            }
        ensureNotNull(data.credentials[subject]) { GameError.ParticipantNotFound(participantId) }
    }

/** 失効していない資格を失効させる。期限切れの資格も失効させられる（失効してから再発行する）。 */
internal fun decideRevoke(
    state: GameState,
    command: GameCommand.RevokeCredential,
): Either<GameError, List<GameEvent>> =
    either {
        val validity = state.participantCredential(command.actor, command.subject).bind()
        ensure(!validity.revoked) { GameError.CredentialAlreadyRevoked }
        listOf(GameEvent.CredentialRevoked(command.subject))
    }

/** 失効した資格だけを再発行する。有効な資格は置き換えない。 */
internal fun decideReissue(
    state: GameState,
    command: GameCommand.ReissueCredential,
): Either<GameError, List<GameEvent>> =
    either {
        val validity = state.participantCredential(command.actor, command.subject).bind()
        ensure(validity.revoked) { GameError.CredentialNotRevoked }
        listOf(GameEvent.CredentialReissued(command.subject, command.expiresAt))
    }

/** 有効な復帰資格の持ち主（その主体自身）だけが復帰できる。復帰すると、復帰資格の期限が新しくなる。 */
internal fun decideRecover(
    state: GameState,
    command: GameCommand.RecoverParticipation,
): Either<GameError, List<GameEvent>> =
    either {
        val validity = ensureNotNull(state.dataOrNull()?.credentials?.get(command.subject)) { recoveryRefused }
        ensure(command.subject !is CredentialSubject.Observer) { recoveryRefused }
        ensure(command.actor.asSubject() == command.subject) { recoveryRefused }
        ensure(validity.status(command.at) == CredentialStatus.VALID) { recoveryRefused }
        listOf(GameEvent.ParticipationRecovered(command.subject, command.credentialExpiresAt))
    }

/** 主体に、発行直後（未失効）の資格を結び付ける。作成（進行役）と参加（参加者）で発行する。 */
internal fun GameData.withIssued(
    subject: CredentialSubject,
    expiresAt: Instant,
): GameData = copy(credentials = credentials + (subject to CredentialValidity(expiresAt, false)))

/** 失効していない資格を失効にする。未知の主体と失効済みは、decide が作らない列（null）。 */
internal fun GameData.revoked(subject: CredentialSubject): GameData? =
    credentials[subject]
        ?.takeIf { !it.revoked }
        ?.let { copy(credentials = credentials + (subject to it.copy(revoked = true))) }

/** 失効した資格を、失効を解いて新しい期限にする。未知の主体と有効な資格は、decide が作らない列（null）。 */
internal fun GameData.reissued(
    subject: CredentialSubject,
    expiresAt: Instant,
): GameData? =
    credentials[subject]
        ?.takeIf { it.revoked }
        ?.let { copy(credentials = credentials + (subject to CredentialValidity(expiresAt, false))) }

/** 失効していない資格の期限を新しくする。未知の主体と失効済みは、decide が作らない列（null）。 */
internal fun GameData.recovered(
    subject: CredentialSubject,
    expiresAt: Instant,
): GameData? =
    credentials[subject]
        ?.takeIf { !it.revoked }
        ?.let { copy(credentials = credentials + (subject to it.copy(expiresAt = expiresAt))) }
