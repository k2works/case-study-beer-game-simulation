package beergame.http

import io.ktor.http.HttpHeaders
import io.ktor.http.HttpMethod
import io.ktor.server.application.Application
import io.ktor.server.application.ApplicationCall
import io.ktor.server.application.ApplicationCallPipeline
import io.ktor.server.application.call
import io.ktor.server.plugins.origin
import io.ktor.server.request.contentLength
import io.ktor.server.request.httpMethod
import io.ktor.server.request.path

/*
 * 経路に入る前の守り: レート制限、Origin の検査（変更系）、本文のサイズ（変更系）。
 * 拒否したら、problem+json を返して、以降の処理を始めない。生存と準備の確認（health、ready）は、数えず、検査もしない。
 */

private const val WINDOW_MILLIS = 60_000L

private val SAFE_METHODS = setOf(HttpMethod.Get, HttpMethod.Head, HttpMethod.Options)
private val PROBE_PATHS = setOf("$API_BASE/health", "$API_BASE/ready")

internal fun Application.installGuards(deps: HttpDeps) {
    val origins = OriginPolicy(deps.settings.allowedOrigins)
    val limiter = RateLimiter(deps.settings.rateLimitPerMinute, WINDOW_MILLIS)
    intercept(ApplicationCallPipeline.Plugins) {
        val rejection = rejectionOf(call, deps, origins, limiter)
        if (rejection != null) {
            call.respondProblem(rejection)
            finish()
        }
    }
}

private fun rejectionOf(
    call: ApplicationCall,
    deps: HttpDeps,
    origins: OriginPolicy,
    limiter: RateLimiter,
): Problem? {
    if (call.request.path() in PROBE_PATHS) return null
    val decision = limiter.tryAcquire(call.request.origin.remoteHost)
    return when {
        decision is RateDecision.Limited -> rateLimitedProblem(decision)
        call.request.httpMethod in SAFE_METHODS -> null
        !originAllowed(call, origins) -> unauthorizedProblem()
        (call.request.contentLength() ?: 0L) > deps.settings.maxBodyBytes -> payloadTooLargeProblem()
        else -> null
    }
}

private fun rateLimitedProblem(decision: RateDecision.Limited): Problem =
    Problem(
        status = HttpStatusCodes.TOO_MANY_REQUESTS,
        code = Codes.RATE_LIMITED,
        title = "要求が多すぎます。しばらくしてからお試しください。",
        retryAfterSeconds = decision.retryAfterSeconds,
    )

private fun originAllowed(
    call: ApplicationCall,
    origins: OriginPolicy,
): Boolean =
    origins.isAllowed(
        origin = call.request.headers[HttpHeaders.Origin],
        referer = call.request.headers[HttpHeaders.Referrer],
        host = call.request.headers[HttpHeaders.Host],
    )
