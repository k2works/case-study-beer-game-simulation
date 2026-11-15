package beergame.application

import io.kotest.core.spec.style.FunSpec
import io.kotest.matchers.shouldBe
import io.kotest.matchers.string.shouldNotContain

private val KEY_1 = ByteArray(32) { it.toByte() }
private val KEY_2 = ByteArray(32) { (it + 1).toByte() }

private fun ring(
    current: Int,
    vararg keys: Pair<Int, ByteArray>,
): CredentialKeyRing = CredentialKeyRing.of(current, keys.toMap()).ok()

/**
 * 資格の鍵の版（判断項目 3 の決定: 値の版の接頭辞）。資格の値は `v<版>.<乱数>` で、検証は値が示す版の鍵で行う。
 * 版を知らないと、どの鍵でダイジェストを作るか決まらないため、版は値に含める（保存の key_version と一致する）。
 */
class CredentialKeyRingSpec :
    FunSpec({
        test("[B5/4.2] Given 現在の版が 2 の鍵束 When 資格を作る Then 値は v2. で始まり、ダイジェストは版 2 の鍵で作った値と一致する") {
            val keys = ring(2, 1 to KEY_1, 2 to KEY_2)

            val minted = keys.mint("random-token")

            minted.raw shouldBe "v2.random-token"
            minted.keyVersion shouldBe 2
            minted.digest shouldBe CredentialDigest.of(KEY_2, "v2.random-token")
            minted.digest shouldNotContain "random-token"
        }

        test("[B5/4.1c] Given 版 1 で作った資格の後に現在が版 2 になった When 旧版の値を検証する Then 版 1 の鍵で同じダイジェストになる（期限まで有効）") {
            val before = ring(1, 1 to KEY_1).mint("old-token")

            val rotated = ring(2, 1 to KEY_1, 2 to KEY_2)

            rotated.digest(before.raw) shouldBe KeyedDigest(1, before.digest)
            rotated.digest("v2.new-token") shouldBe KeyedDigest(2, CredentialDigest.of(KEY_2, "v2.new-token"))
        }

        test("[B5/4.1d] Given 版 1 の鍵を設定から外した When 旧版の値を検証する Then ダイジェストを作れず null（認証は 403 になる）") {
            val dropped = ring(2, 2 to KEY_2)

            dropped.digest("v1.old-token") shouldBe null
        }

        test("[B5/4.2] Given 版の接頭辞が無い・壊れている・知らない版の値 When 検証する Then すべて null（理由を区別しない）") {
            val keys = ring(2, 1 to KEY_1, 2 to KEY_2)

            listOf(
                "",
                "no-prefix-token",
                "v.token",
                "vx.token",
                "v0.token",
                "v-1.token",
                "v1.",
                "v3.token",
                "v99999999999.token",
                "V1.token",
                " v1.token",
            ).forEach { keys.digest(it) shouldBe null }
        }

        test("[B5/4.2] Given 同じ乱数でも版が違う When ダイジェストを作る Then 値（接頭辞）も鍵も違うので別のダイジェスト") {
            val keys = ring(2, 1 to KEY_1, 2 to KEY_2)

            (keys.digest("v1.same")?.digest == keys.digest("v2.same")?.digest) shouldBe false
        }

        test("[B5/4.2] Given 現在の版が鍵に無い・版が 1 未満・鍵が空 When 鍵束を作る Then 作れず、理由を返す") {
            CredentialKeyRing.of(3, mapOf(1 to KEY_1)).err() shouldBe "現在の版 3 の鍵が無い"
            CredentialKeyRing.of(0, mapOf(0 to KEY_1)).err() shouldBe "鍵の版は 1 以上: 0"
            CredentialKeyRing.of(1, mapOf(1 to KEY_1, -2 to KEY_2)).err() shouldBe "鍵の版は 1 以上: -2"
            CredentialKeyRing.of(1, emptyMap()).err() shouldBe "現在の版 1 の鍵が無い"
        }

        test("[B5/4.2] Given 鍵束 When 文字列にする Then 鍵の内容を出さない") {
            ring(1, 1 to KEY_1).toString() shouldBe "CredentialKeyRing(current=1, versions=[1])"
        }
    })
