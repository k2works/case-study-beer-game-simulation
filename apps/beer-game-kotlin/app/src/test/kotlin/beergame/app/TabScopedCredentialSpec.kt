package beergame.app

import io.kotest.core.spec.style.FunSpec
import io.kotest.matchers.shouldBe
import io.kotest.matchers.shouldNotBe
import io.kotest.matchers.string.shouldContain
import io.kotest.matchers.string.shouldNotContain
import io.ktor.client.HttpClient
import io.ktor.client.request.header
import io.ktor.client.statement.HttpResponse
import io.ktor.http.HttpMethod
import io.ktor.http.HttpStatusCode

/*
 * タブごとの資格（ADR-020）。画面が `X-Tab-Id` ヘッダーで送るタブの識別子から、資格の Cookie の名前を決める
 * （`bg_session_<識別子>`・`bg_recovery_<識別子>`）。同じブラウザの複数のタブが、別の人として操作できる。
 * ヘッダーが無い・形が不正なときは、従来の名前（`bg_session`・`bg_recovery`）のまま。
 */

private const val DEMAND = "[4,999,998]"
private const val TAB_HEADER = "X-Tab-Id"
private const val TAB_A = "tabAAAAAAAAAAAAAAAA"
private const val TAB_B = "tabBBBBBBBBBBBBBBBB"
private const val RECOVER_PATH = "/participations/recover"

private fun HttpResponse.setCookie(name: String): String? =
    headers.getAll("Set-Cookie").orEmpty().firstOrNull { it.startsWith("$name=") }

private fun HttpResponse.cookieValue(name: String): String? =
    setCookie(name)?.substringAfter("$name=")?.substringBefore(";")

private fun HttpResponse.gameId(): String =
    checkNotNull(headers["Location"]).removePrefix("$API/games/").removeSuffix("/state")

private suspend fun HttpClient.createIn(
    tab: String?,
    key: String,
): HttpResponse =
    callWith(HttpMethod.Post, "/games", """{"kind":"KIT","finalWeek":3,"demand":$DEMAND}""") {
        header("Idempotency-Key", key)
        tab?.let { header(TAB_HEADER, it) }
    }

private suspend fun HttpClient.stateAs(
    gameId: String,
    cookie: String?,
    tab: String?,
): HttpResponse =
    callWith(HttpMethod.Get, "/games/$gameId/state") {
        cookie?.let { header("Cookie", it) }
        tab?.let { header(TAB_HEADER, it) }
    }

class TabScopedCredentialSpec :
    FunSpec({
        test("タブの識別子つきの作成: 資格の Cookie は bg_session_<識別子>（HttpOnly）で、従来の名前では発行しない") {
            withWorld {
                val response = client.createIn(TAB_A, "create-a")

                response.status shouldBe HttpStatusCode.Created
                val session = checkNotNull(response.setCookie("bg_session_$TAB_A"))
                session shouldContain "HttpOnly"
                session shouldContain "SameSite=Strict"
                response.setCookie("bg_session") shouldBe null
                val recovery = checkNotNull(response.setCookie("bg_recovery_$TAB_A"))
                recovery shouldContain "Path=/api/v1/participations/recover"
                response.setCookie("bg_recovery") shouldBe null
            }
        }

        test("タブの識別子が無いときは、従来の名前（bg_session・bg_recovery）のまま") {
            withWorld {
                val response = client.createIn(null, "create-legacy")

                response.cookieValue("bg_session") shouldNotBe null
                response.cookieValue("bg_recovery") shouldNotBe null
            }
        }

        test("形が不正なタブの識別子は無視して、従来の名前で扱う（Cookie の名前に使わない）") {
            withWorld {
                val response = client.createIn("a b;c=d", "create-bad")

                response.status shouldBe HttpStatusCode.Created
                response.cookieValue("bg_session") shouldNotBe null
                response.headers
                    .getAll("Set-Cookie")
                    .orEmpty()
                    .none { it.contains("a b") } shouldBe true
            }
        }

        test("読むのは、自分のタブの Cookie だけ: 別のタブの識別子・識別子なしでは、同じ Cookie を送っても 403") {
            withWorld {
                val created = client.createIn(TAB_A, "create-a")
                val cookie = "bg_session_$TAB_A=${checkNotNull(created.cookieValue("bg_session_$TAB_A"))}"
                val id = created.gameId()

                client.stateAs(id, cookie, TAB_A).status shouldBe HttpStatusCode.OK
                client.stateAs(id, cookie, TAB_B).status shouldBe HttpStatusCode.Forbidden
                client.stateAs(id, cookie, null).status shouldBe HttpStatusCode.Forbidden
            }
        }

        test("従来の名前（bg_session）の Cookie しか無いときは、タブの識別子つきの要求でも、それで認可する（移行）") {
            withWorld {
                val created = client.createIn(null, "create-legacy")
                val cookie = "bg_session=${checkNotNull(created.cookieValue("bg_session"))}"

                client.stateAs(created.gameId(), cookie, TAB_A).status shouldBe HttpStatusCode.OK
            }
        }

        test("タブの名前の Cookie と従来の名前の Cookie が両方あれば、タブの名前の Cookie を優先する") {
            withWorld {
                val legacy = client.createIn(null, "create-legacy")
                val legacyId = legacy.gameId()
                val tabbed = client.createIn(TAB_A, "create-a")
                val jar =
                    "bg_session=${checkNotNull(legacy.cookieValue("bg_session"))}; " +
                        "bg_session_$TAB_A=${checkNotNull(tabbed.cookieValue("bg_session_$TAB_A"))}"

                // タブの資格は、別のゲームの進行役。従来の資格のゲームは、タブの資格では読めない（403）
                client.stateAs(tabbed.gameId(), jar, TAB_A).status shouldBe HttpStatusCode.OK
                client.stateAs(legacyId, jar, TAB_A).status shouldBe HttpStatusCode.Forbidden
            }
        }

        test("同じブラウザ（同じ Cookie の入れ物）の 2 つのタブが、進行役と参加者として別々に扱われる") {
            withWorld {
                val created = client.createIn(TAB_A, "create-a")
                val id = created.gameId()
                val facilitatorCookie = "bg_session_$TAB_A=${checkNotNull(created.cookieValue("bg_session_$TAB_A"))}"
                val joinCode = client.stateAs(id, facilitatorCookie, TAB_A).body().str("joinCode")

                // タブ B が、同じブラウザで参加者として参加する（タブ A の Cookie は、そのまま残る）
                val joined =
                    client.callWith(
                        HttpMethod.Post,
                        "/participations/join",
                        """{"joinCode":"$joinCode","displayName":"田中"}""",
                    ) {
                        header("Idempotency-Key", "join-b")
                        header(TAB_HEADER, TAB_B)
                    }
                joined.status shouldBe HttpStatusCode.OK
                joined.setCookie("bg_session") shouldBe null
                val participantCookie = "bg_session_$TAB_B=${checkNotNull(joined.cookieValue("bg_session_$TAB_B"))}"
                val jar = "$facilitatorCookie; $participantCookie"

                // 1 つの入れ物（Cookie ヘッダー）に両方があっても、タブごとに自分の資格で読む
                client.stateAs(id, jar, TAB_A).body().str("joinCode") shouldBe joinCode
                val asParticipant = client.stateAs(id, jar, TAB_B).body()
                asParticipant.keys.contains("joinCode") shouldBe false
            }
        }

        test("復帰: タブの識別子つきの復帰資格の Cookie（bg_recovery_<識別子>）で、本文の復帰コードなしに復帰できる") {
            withWorld {
                val created = client.createIn(TAB_A, "create-a")
                val id = created.gameId()
                val recovery = "bg_recovery_$TAB_A=${checkNotNull(created.cookieValue("bg_recovery_$TAB_A"))}"

                val recovered =
                    client.callWith(HttpMethod.Post, RECOVER_PATH, """{"gameId":"$id"}""") {
                        header("Idempotency-Key", "recover-a")
                        header("Cookie", recovery)
                        header(TAB_HEADER, TAB_A)
                    }

                recovered.status shouldBe HttpStatusCode.OK
                recovered.setCookie("bg_session_$TAB_A") shouldNotBe null
                recovered.setCookie("bg_session") shouldBe null
            }
        }
    })
