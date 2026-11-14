package beergame.application

import arrow.core.Either
import arrow.core.left
import arrow.core.raise.either
import arrow.core.raise.ensure
import arrow.core.raise.ensureNotNull
import arrow.core.right
import beergame.domain.Actor
import beergame.domain.GameId
import java.time.Instant
import java.util.UUID

/*
 * コマンド処理。順序は固定（ADR-004）:
 *   ロック → 認証（操作者・資格の有効性）→ 認可の前提検査（ゲームの一致）→ 冪等記録の照合
 *   → 読み込み → decide → 追記 → 投影 → 周辺ストア → 通知 → 冪等記録の保存
 * すべて 1 つのトランザクションの中で、Left ならトランザクションごと取り消す。ここは順序と配線だけを持ち、業務ルールは持たない。
 * 読み込みから追記までの部分（[applySingle]、[applyStart]）は Streams.kt。
 */

/** 認証の要否。匿名の操作（作成、参加）は資格を見ない（認可は参加コード）。 */
internal enum class Auth { ANONYMOUS, REQUIRED }

/** 1 つの要求（冪等キー、資格、相関 ID）。 */
data class RequestMeta(
    val idempotencyKey: String,
    val credential: String?,
    val correlationId: UUID,
)

/** 何を・どのゲームに・どんな内容で。[scope] は「操作の名前 + 対象」で、冪等記録の範囲と、要求の同一性の対象になる。 */
internal class Operation(
    val gameId: GameId,
    val scope: String,
    val body: String,
)

/** 1 つのコマンド処理の入力。[issued] は、資格を発行する操作（作成、参加）だけが持つ。 */
internal class CommandRequest(
    val operation: Operation,
    val auth: Auth,
    val successStatus: Int,
    val issued: IssuedCredential?,
    val meta: RequestMeta,
)

/** トランザクションの中で、認証を終えた後に使う値。 */
internal class Ctx(
    val gameId: GameId,
    val actor: Actor,
    val at: Instant,
    val commandId: UUID,
    val correlationId: UUID,
)

/**
 * 追記の競合（[AppFailure.ConcurrencyConflict]）だけを、上限まで再試行する。上限に達したら [AppFailure.RetryExhausted]。
 * 業務上の競合（DecisionConflict など）は decide が返すので再試行しない。
 */
internal tailrec suspend fun <A> withAppendRetry(
    remaining: Int,
    block: suspend () -> Either<AppFailure, A>,
): Either<AppFailure, A> =
    when (val result = block()) {
        is Either.Right -> {
            result
        }

        is Either.Left -> {
            when {
                result.value !is AppFailure.ConcurrencyConflict -> result
                remaining > 1 -> withAppendRetry(remaining - 1, block)
                else -> AppFailure.RetryExhausted.left()
            }
        }
    }

/**
 * 認証から冪等記録の保存までの共通の流れ。[handle] は「読み込み → decide → 追記 → 投影 → ...」の部分で、版を返す。
 * 競合は、認可を含めて最初から評価し直す（再読み込みの後に権限や状態が変わっていても、正しく判定する）。
 */
internal suspend fun Ports.runCommand(
    request: CommandRequest,
    handle: suspend (Tx, Ctx) -> Either<AppFailure, Versions>,
): Either<AppFailure, CommandOutcome> {
    val gameId = request.operation.gameId
    val commandId = newId()
    val keyDigest = IdempotencyDigest.key(settings.idempotencySecret, request.meta.idempotencyKey)
    val key = IdempotencyKey(gameId, request.operation.scope, keyDigest)
    return withAppendRetry(settings.maxAttempts.coerceAtLeast(1)) {
        events.transaction { tx ->
            either {
                lock.acquireShared(tx, gameId).bind()
                val at = now()
                val actor = authenticate(tx, request, at).bind()
                val requestDigest = requestDigest(request.operation, actor)
                val stored = idempotency.find(tx, key, at).bind()
                if (stored != null) {
                    replay(stored, requestDigest).bind()
                } else {
                    val versions = handle(tx, Ctx(gameId, actor, at, commandId, request.meta.correlationId)).bind()
                    val outcome = CommandOutcome(gameId, versions, request.issued)
                    val response =
                        StoredResponse(
                            gameId,
                            requestDigest,
                            request.successStatus,
                            OutcomeCodec.encode(outcome),
                            at.plus(settings.idempotencyTtl),
                        )
                    idempotency.save(tx, key, response, at).bind()
                    outcome
                }
            }
        }
    }
}

private fun Ports.requestDigest(
    operation: Operation,
    actor: Actor,
): String =
    IdempotencyDigest.request(
        settings.idempotencySecret,
        operation.body,
        operation.scope,
        actor.toRef().id?.toString() ?: ANONYMOUS_ID,
    )

private const val ANONYMOUS_ID = "anonymous"

/** 認証と、認可の前提検査（資格の有効性、ゲームの一致）。無効なら、理由を区別せず [AppFailure.Unauthorized]。 */
private suspend fun Ports.authenticate(
    tx: Tx,
    request: CommandRequest,
    at: Instant,
): Either<AppFailure, Actor> =
    when (request.auth) {
        Auth.ANONYMOUS -> {
            Actor.Anonymous.right()
        }

        Auth.REQUIRED -> {
            either {
                val verified = verified(tx, request.meta.credential, at).bind()
                ensure(verified.gameId == request.operation.gameId) { AppFailure.Unauthorized }
                verified.actor
            }
        }
    }

private suspend fun Ports.verified(
    tx: Tx,
    credential: String?,
    at: Instant,
): Either<AppFailure, VerifiedCredential> =
    either {
        val raw = ensureNotNull(credential) { AppFailure.Unauthorized }
        val verified = peripheral.authenticate(tx, CredentialDigest.of(settings.credentialSecret, raw), at).bind()
        ensureNotNull(verified) { AppFailure.Unauthorized }
    }

private fun replay(
    stored: StoredResponse,
    requestDigest: String,
): Either<AppFailure, CommandOutcome> =
    if (stored.requestDigest == requestDigest) {
        OutcomeCodec.decode(stored.body)
    } else {
        AppFailure.IdempotencyKeyReused.left()
    }
