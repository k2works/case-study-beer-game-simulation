package beergame.application

import io.kotest.core.spec.style.FunSpec
import io.kotest.matchers.shouldBe
import io.kotest.matchers.shouldNotBe
import io.kotest.matchers.string.shouldNotContain

private val SECRET = ByteArray(32) { it.toByte() }
private val OTHER_SECRET = ByteArray(32) { (it + 1).toByte() }

class IdempotencyDigestSpec :
    FunSpec({
        test("[7.3] Given 同じ本文・対象・操作者 When 要求の digest を作る Then 同じ値（決定的）") {
            val a = IdempotencyDigest.request(SECRET, """{"q":1}""", "decision:RETAILER", "actor-1")
            val b = IdempotencyDigest.request(SECRET, """{"q":1}""", "decision:RETAILER", "actor-1")

            a shouldBe b
        }

        test("[7.3] Given 本文・対象・操作者のどれか 1 つが違う When 要求の digest を作る Then 値が変わる（別の操作者を含む）") {
            val base = IdempotencyDigest.request(SECRET, """{"q":1}""", "decision:RETAILER", "actor-1")

            IdempotencyDigest.request(SECRET, """{"q":2}""", "decision:RETAILER", "actor-1") shouldNotBe base
            IdempotencyDigest.request(SECRET, """{"q":1}""", "decision:FACTORY", "actor-1") shouldNotBe base
            IdempotencyDigest.request(SECRET, """{"q":1}""", "decision:RETAILER", "actor-2") shouldNotBe base
            IdempotencyDigest.request(OTHER_SECRET, """{"q":1}""", "decision:RETAILER", "actor-1") shouldNotBe base
        }

        test("[7.3] Given 境界をまたぐ組み合わせ When 要求の digest を作る Then 連結しても衝突しない（a|bc と ab|c）") {
            IdempotencyDigest.request(SECRET, "a", "bc", "x") shouldNotBe
                IdempotencyDigest.request(SECRET, "ab", "c", "x")
        }

        test("[7.3] Given 生の冪等キー When key digest を作る Then 生のキーを含まない 16 進の文字列で、鍵が違えば別の値") {
            val digest = IdempotencyDigest.key(SECRET, "my-raw-idempotency-key")

            digest shouldNotContain "my-raw-idempotency-key"
            digest.matches(Regex("[0-9a-f]{64}")) shouldBe true
            IdempotencyDigest.key(OTHER_SECRET, "my-raw-idempotency-key") shouldNotBe digest
        }
    })
