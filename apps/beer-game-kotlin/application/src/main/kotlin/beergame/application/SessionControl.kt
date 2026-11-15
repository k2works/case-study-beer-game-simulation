package beergame.application

import arrow.core.Either
import arrow.core.raise.either
import beergame.domain.GameId
import beergame.domain.SessionCommand

/*
 * セッションの進行の制御（B5）。停止・再開・代理入力。どれも session ストリームへのコマンドで、
 * 認可（進行役だけ）と状態の規則（停止中は参加者の保存・確定を拒否する、など）は decide（domain）が持つ。
 * ここは、認証 → 認可の前提検査 → 冪等記録の照合の順序（[runCommand]）と、入力の形の検証だけを持つ。
 */

/** 進行中のセッションを一時停止する。停止中は、参加者の入力の保存と週の確定を拒否する（AC3.1.1）。 */
suspend fun Ports.pauseSession(
    gameId: GameId,
    meta: RequestMeta,
): Either<AppFailure, CommandOutcome> {
    val request = CommandRequest(Operation(gameId, SCOPE_PAUSE, SCOPE_PAUSE), Auth.REQUIRED, STATUS_OK, meta)
    return runCommand(
        request,
    ) { tx, ctx -> applySingle(tx, ctx, sessionStream, SessionCommand.PauseSession(ctx.actor, ctx.at)) }
}

/** 停止中のセッションを再開する。最後に確定した週から入力できる（AC3.1.3）。 */
suspend fun Ports.resumeSession(
    gameId: GameId,
    meta: RequestMeta,
): Either<AppFailure, CommandOutcome> {
    val request = CommandRequest(Operation(gameId, SCOPE_RESUME, SCOPE_RESUME), Auth.REQUIRED, STATUS_OK, meta)
    return runCommand(request) { tx, ctx ->
        applySingle(tx, ctx, sessionStream, SessionCommand.ResumeSession(ctx.actor, ctx.at))
    }
}

/** 進行役が、参加者の代わりに入力する（進行中・停止中のどちらでも。AC3.1.2）。数量・週の形の誤りは、すべて集める。 */
suspend fun Ports.submitProxyDecision(
    gameId: GameId,
    input: ProxyDecisionInput,
    meta: RequestMeta,
): Either<AppFailure, CommandOutcome> =
    either {
        val (week, quantity) = validateProxy(input).mapLeft(AppFailure::Invalid).bind()
        val body = "proxy|${input.role.name}|${input.requestedWeek}|${input.quantity}"
        val request =
            CommandRequest(Operation(gameId, "proxy:${input.role.name}", body), Auth.REQUIRED, STATUS_OK, meta)
        runCommand(request) { tx, ctx ->
            val command = SessionCommand.SubmitProxyDecision(ctx.actor, ctx.at, input.role, week, quantity)
            applySingle(tx, ctx, sessionStream, command)
        }.bind()
    }

private const val SCOPE_PAUSE = "pause"
private const val SCOPE_RESUME = "resume"
private const val STATUS_OK = 200
