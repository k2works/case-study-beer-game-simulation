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

/**
 * 認証の要否と、確かめる資格。
 * - [ANONYMOUS]: 匿名の操作（作成、参加）は資格を見ない（認可は参加コード）。
 * - [REQUIRED]: ブラウザセッション（`browser_sessions`）の有効性が認可。
 * - [RECOVERY]: **提示した復帰資格（`credentials`）の有効性が認可**（復帰）。冪等記録の照合より前に検証する。
 *   `ANONYMOUS` で作ると、失効した復帰資格の再送に、保存済みの新しいセッションが返ってしまう（ADR-004、ADR-015）。
 */
internal enum class Auth { ANONYMOUS, REQUIRED, RECOVERY }

/**
 * 1 つの要求（冪等キー、資格、相関 ID）。[source] は正規化した接続元で、参加・復帰の専用のレート制限（[limitedAttempts]）だけが使う。
 * HTTP の層が必ず渡す。無い呼び出し（HTTP の外の試験など）は、制限を受けない。
 */
data class RequestMeta(
    val idempotencyKey: String,
    val credential: String?,
    val correlationId: UUID,
    val source: AttemptSource? = null,
)

/** 何を・どのゲームに・どんな内容で。[scope] は「操作の名前 + 対象」で、冪等記録の範囲と、要求の同一性の対象になる。 */
internal class Operation(
    val gameId: GameId,
    val scope: String,
    val body: String,
)

/**
 * 1 つのコマンド処理の入力。[issued]（ブラウザセッションの値）と [recovery]（復帰資格の値）は、資格を発行する操作
 * （作成、参加、復帰、再発行）だけが持つ。復帰は、認証で主体が決まるまで主体を知らないので、操作者から作る関数で渡す。
 */
internal class CommandRequest(
    val operation: Operation,
    val auth: Auth,
    val successStatus: Int,
    val meta: RequestMeta,
    val issued: (Actor) -> IssuedCredential? = { null },
    val recovery: (Actor) -> IssuedCredential? = { null },
)

/** 復帰の認証に使った復帰資格のダイジェストと、現在の期限。 */
internal class PresentedRecovery(
    val digest: String,
    val expiresAt: Instant,
)

/** トランザクションの中で、認証を終えた後に使う値。[presented] は、復帰（[Auth.RECOVERY]）だけが持つ。 */
internal class Ctx(
    val gameId: GameId,
    val actor: Actor,
    val at: Instant,
    val commandId: UUID,
    val correlationId: UUID,
    val presented: PresentedRecovery? = null,
)

/** 認証の結果。[presented] は、復帰の認証に使った復帰資格。 */
private class Authenticated(
    val actor: Actor,
    val presented: PresentedRecovery? = null,
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
                val authenticated = authenticate(tx, request, at).bind()
                val actor = authenticated.actor
                val requestDigest = requestDigest(request.operation, actor)
                val stored = idempotency.find(tx, key, at).bind()
                if (stored != null) {
                    replay(stored, requestDigest).bind()
                } else {
                    val ctx = Ctx(gameId, actor, at, commandId, request.meta.correlationId, authenticated.presented)
                    val versions = handle(tx, ctx).bind()
                    val outcome = CommandOutcome(gameId, versions, request.issued(actor), request.recovery(actor))
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

/**
 * 認証と、認可の前提検査（資格の有効性、ゲームの一致）。無効なら、理由（無い・不明・版が違う・鍵が外された・失効・
 * 期限切れ・別のゲーム）を区別せず [AppFailure.Unauthorized]。
 */
private suspend fun Ports.authenticate(
    tx: Tx,
    request: CommandRequest,
    at: Instant,
): Either<AppFailure, Authenticated> =
    when (request.auth) {
        Auth.ANONYMOUS -> {
            Authenticated(Actor.Anonymous).right()
        }

        Auth.REQUIRED -> {
            either {
                val verified = verifiedSession(tx, request.meta.credential, at).bind()
                ensure(verified.gameId == request.operation.gameId) { AppFailure.Unauthorized }
                Authenticated(verified.actor)
            }
        }

        Auth.RECOVERY -> {
            either {
                val raw = ensureNotNull(request.meta.credential) { AppFailure.Unauthorized }
                val keyed = ensureNotNull(settings.credentialKeys.digest(raw)) { AppFailure.Unauthorized }
                val found = peripheral.authenticateRecovery(tx, keyed.digest, at).bind()
                val verified = ensureNotNull(found) { AppFailure.Unauthorized }
                ensure(verified.gameId == request.operation.gameId) { AppFailure.Unauthorized }
                Authenticated(verified.actor, PresentedRecovery(keyed.digest, verified.expiresAt))
            }
        }
    }

/** ブラウザセッションの検証。鍵が無い版（外された鍵）の値は、ダイジェストを作れないので同じ失敗になる。 */
internal suspend fun Ports.verifiedSession(
    tx: Tx,
    credential: String?,
    at: Instant,
): Either<AppFailure, VerifiedCredential> =
    either {
        val raw = ensureNotNull(credential) { AppFailure.Unauthorized }
        val keyed = ensureNotNull(settings.credentialKeys.digest(raw)) { AppFailure.Unauthorized }
        val verified = peripheral.authenticate(tx, keyed.digest, at).bind()
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
