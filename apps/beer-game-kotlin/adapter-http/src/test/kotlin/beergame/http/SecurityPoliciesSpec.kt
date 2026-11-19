package beergame.http

import io.kotest.core.spec.style.FunSpec
import io.kotest.matchers.shouldBe

class SecurityPoliciesSpec :
    FunSpec({
        val policy = OriginPolicy(setOf("http://localhost:5173", "https://beer.example.com"))

        test("[NF-S8] Given 許可したオリジン When Origin を検査する Then 許す（大文字小文字と末尾の差を除いて比べる）") {
            policy.isAllowed(origin = "http://localhost:5173", referer = null, host = "api.internal") shouldBe true
            policy.isAllowed(origin = "HTTPS://Beer.Example.com", referer = null, host = "api.internal") shouldBe true
        }

        test("[NF-S8] Given 外部のオリジン When 検査する Then 拒む（ポート違い・スキーム違い・サブドメインも別のオリジン）") {
            listOf(
                "https://evil.example.org",
                "http://localhost:5174",
                "http://beer.example.com",
                "https://beer.example.com.evil.org",
                "https://sub.beer.example.com",
                "null",
                "file://",
                "",
            ).forEach { origin ->
                policy.isAllowed(origin = origin, referer = null, host = "api.internal") shouldBe false
            }
        }

        test("[NF-S8] Given Host と同じ権限（authority）のオリジン When 検査する Then 同一オリジンとして許す") {
            policy.isAllowed(origin = "http://127.0.0.1:8080", referer = null, host = "127.0.0.1:8080") shouldBe true
            policy.isAllowed(origin = "http://127.0.0.1:8080", referer = null, host = "127.0.0.1:9090") shouldBe false
            policy.isAllowed(origin = "http://127.0.0.1:8080", referer = null, host = null) shouldBe false
        }

        test("[NF-S8] Given Origin が無く Referer がある When 検査する Then Referer のオリジンで判定する") {
            policy.isAllowed(origin = null, referer = "http://localhost:5173/games/1", host = "api.internal") shouldBe
                true
            policy.isAllowed(origin = null, referer = "https://evil.example.org/x", host = "api.internal") shouldBe
                false
            policy.isAllowed(origin = null, referer = "not a url", host = "api.internal") shouldBe false
        }

        test("[NF-S8] Given Origin も Referer も無い When 検査する Then 許す（ブラウザの外のクライアント。CSRF はブラウザが前提）") {
            policy.isAllowed(origin = null, referer = null, host = "api.internal") shouldBe true
        }

        test("[NF-S8] Given Origin と Referer の両方 When 検査する Then Origin を優先する") {
            policy.isAllowed(
                origin = "https://evil.example.org",
                referer = "http://localhost:5173/",
                host = "api.internal",
            ) shouldBe false
        }

        test("[NF-S11] Given 窓ごとの上限 When 上限を超える Then 拒み、窓の残りを Retry-After（秒）で示す") {
            var now = 1_000L
            val limiter = RateLimiter(limit = 3, windowMillis = 60_000, now = { now })

            repeat(3) { limiter.tryAcquire("a") shouldBe RateDecision.Allowed }
            now = 11_000L
            limiter.tryAcquire("a") shouldBe RateDecision.Limited(retryAfterSeconds = 50)
        }

        test("[NF-S11] Given 窓が過ぎた When 要求する Then 数え直す。別の鍵は別に数える") {
            var now = 0L
            val limiter = RateLimiter(limit = 1, windowMillis = 1_000, now = { now })

            limiter.tryAcquire("a") shouldBe RateDecision.Allowed
            limiter.tryAcquire("b") shouldBe RateDecision.Allowed
            (limiter.tryAcquire("a") is RateDecision.Limited) shouldBe true
            now = 1_000L
            limiter.tryAcquire("a") shouldBe RateDecision.Allowed
        }

        test("[NF-S11] Given 多数の鍵 When 古い窓がたまる Then 記憶する鍵の数に上限がある（メモリを使い切らない）") {
            var now = 0L
            val limiter = RateLimiter(limit = 1, windowMillis = 1_000, maxKeys = 100, now = { now })

            repeat(1_000) { i ->
                now += 10
                limiter.tryAcquire("k$i")
            }

            (limiter.trackedKeys() <= 100) shouldBe true
        }
    })
