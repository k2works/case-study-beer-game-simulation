package beergame.application

import io.kotest.core.spec.style.FunSpec
import io.kotest.matchers.shouldBe
import io.kotest.matchers.shouldNotBe
import io.kotest.matchers.string.shouldMatch
import io.kotest.matchers.string.shouldNotContain

/*
 * 接続元の正規化と鍵付き要約（B5 Step 5。NF-S11・NF-S19）。生の接続元（IP アドレス）は DB にもログにも残さず、
 * 鍵付きの要約だけを窓の鍵にする。同じ接続元は、書き方が違っても同じ鍵になる。
 */
class AttemptSourceSpec :
    FunSpec({
        context("[5.1] 接続元の正規化") {
            test("Given IPv4 When 正規化する Then そのまま（前後の空白は除く）") {
                AttemptSource.of("203.0.113.7").normalized shouldBe "203.0.113.7"
                AttemptSource.of("  203.0.113.7 ").normalized shouldBe "203.0.113.7"
            }

            test("Given IPv4 射影の IPv6 When 正規化する Then IPv4 と同じ接続元になる") {
                AttemptSource.of("::ffff:203.0.113.7") shouldBe AttemptSource.of("203.0.113.7")
            }

            test("Given 同じ /64 の IPv6 When 正規化する Then 同じ接続元（書き方・大文字小文字・省略の違いを吸収する）") {
                val a = AttemptSource.of("2001:DB8:1:2:aaaa:bbbb:cccc:dddd")
                val b = AttemptSource.of("2001:0db8:0001:0002::1")
                a shouldBe b
                a.normalized shouldBe "2001:db8:1:2::/64"
            }

            test("Given 別の /64 の IPv6 When 正規化する Then 別の接続元") {
                AttemptSource.of("2001:db8:1:2::1") shouldNotBe AttemptSource.of("2001:db8:1:3::1")
            }

            test("Given 角括弧・ゾーン識別子つきの IPv6 When 正規化する Then 取り除く") {
                AttemptSource.of("[2001:db8:1:2::1]") shouldBe AttemptSource.of("2001:db8:1:2::1")
                AttemptSource.of("fe80::1%eth0") shouldBe AttemptSource.of("fe80::2")
            }

            test("Given IP でない文字列と空 When 正規化する Then 小文字にした不透明な値、空は unknown（名前の解決はしない）") {
                AttemptSource.of("LocalHost").normalized shouldBe "localhost"
                AttemptSource.of("").normalized shouldBe "unknown"
                AttemptSource.of("   ").normalized shouldBe "unknown"
            }

            test("Given 接続元 When 文字列にする Then 接続元の値を含まない（ログや例外に漏れない）") {
                AttemptSource.of("203.0.113.7").toString() shouldNotContain "203.0.113.7"
            }
        }

        context("[5.1] 接続元の鍵付き要約") {
            val settings = testSettings()

            test("Given 同じ接続元 When 要約する Then 決定的で、64 桁の 16 進（HMAC-SHA256）") {
                val key = settings.sourceKey(AttemptSource.of("203.0.113.7"))

                key shouldBe settings.sourceKey(AttemptSource.of(" ::ffff:203.0.113.7"))
                key shouldMatch Regex("[0-9a-f]{64}")
            }

            test("Given 別の接続元・別の鍵 When 要約する Then 値が変わる（鍵が違えば突き合わせられない）") {
                val key = settings.sourceKey(AttemptSource.of("203.0.113.7"))

                settings.sourceKey(AttemptSource.of("203.0.113.8")) shouldNotBe key
                val otherSecret =
                    AppSettings(
                        maxAttempts = 3,
                        ttls = settings.ttls,
                        idempotencySecret = ByteArray(32) { (it + 1).toByte() },
                        credentialKeys = settings.credentialKeys,
                        attempts = settings.attempts,
                    )
                otherSecret.sourceKey(AttemptSource.of("203.0.113.7")) shouldNotBe key
            }
        }
    })
