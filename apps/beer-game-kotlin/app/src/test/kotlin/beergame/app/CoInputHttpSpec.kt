package beergame.app

import io.kotest.core.spec.style.FunSpec
import io.kotest.matchers.collections.shouldNotContain
import io.kotest.matchers.shouldBe
import io.ktor.client.request.header
import io.ktor.client.statement.HttpResponse
import io.ktor.http.HttpMethod
import io.ktor.http.HttpStatusCode
import io.ktor.server.testing.ApplicationTestBuilder
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/*
 * 共同担当・共同入力の HTTP の統合テスト（B6 Step 6.1）。実物の永続化（H2）と全経路を通し、応答の形（保存者・保存の時刻・共同担当）、
 * 競合の 409（最新値・保存者）、冪等キーの再送、失効した資格の再送を確かめる。表示名は、同じ役割の共同担当と進行役にだけ出る。
 * 受入（features/weekly-play/co-input.feature）は、同じ振る舞いを日本語のシナリオで確かめる。
 */

private const val DEMAND = "[4,999,998]"
private const val OWNER = "小売の四郎"
private const val CO_HOLDER = "共同の花子"
private const val OWNER_KEY = "owner"
private const val CO_KEY = "coHolder"
private const val SAVE_AT = 60L
private val OTHERS = mapOf("FACTORY" to "工場の太郎", "DISTRIBUTOR" to "一次卸の次郎", "WHOLESALER" to "二次卸の三郎")

private class CoTable(
    val id: String,
    val facilitator: String,
    val cookies: Map<String, String>,
    val ids: Map<String, String>,
) {
    fun cookie(who: String): String = cookies.getValue(who)
}

/** 作成 → 5 人が参加（小売店は 2 人）→ 割り当て → 開始。 */
private suspend fun ApplicationTestBuilder.startedTable(tag: String): CoTable {
    val created =
        client.call(
            HttpMethod.Post,
            "/games",
            """{"kind":"KIT","finalWeek":3,"demand":$DEMAND}""",
            key = "create-$tag",
        )
    val facilitator = created.credential() ?: error("進行役の資格が無い")
    val id =
        created.headers["Location"]
            .orEmpty()
            .removePrefix("$API/games/")
            .removeSuffix("/state")
    val joinCode = client.call(HttpMethod.Get, "/games/$id/state", cookie = facilitator).body().str("joinCode")
    val names = mapOf(OWNER_KEY to OWNER, CO_KEY to CO_HOLDER) + OTHERS
    val cookies =
        names.mapValues { (who, name) ->
            client
                .call(
                    HttpMethod.Post,
                    "/participations/join",
                    """{"joinCode":"$joinCode","displayName":"$name"}""",
                    key = "join-$tag-$who",
                ).credential() ?: error("参加者の資格が無い")
        }
    val lobby = client.call(HttpMethod.Get, "/games/$id/lobby", cookie = facilitator).body().array("participants")
    val ids =
        names.mapValues { (_, name) ->
            lobby.map { it.jsonObject }.first { it.str("displayName") == name }.str("participantId")
        }
    val roles = mapOf(OWNER_KEY to "RETAILER", CO_KEY to "RETAILER") + OTHERS.keys.associateWith { it }
    roles.forEach { (who, role) ->
        client
            .call(
                HttpMethod.Put,
                "/games/$id/participants/${ids.getValue(who)}/role",
                """{"role":"$role"}""",
                cookie = facilitator,
                key = "assign-$tag-$who",
            ).status shouldBe HttpStatusCode.OK
    }
    client.call(HttpMethod.Post, "/games/$id/start", cookie = facilitator, key = "start-$tag").status shouldBe
        HttpStatusCode.OK
    return CoTable(id, facilitator, cookies, ids)
}

private suspend fun ApplicationTestBuilder.save(
    table: CoTable,
    who: String,
    quantity: Int,
    key: String,
    expected: Int,
): HttpResponse =
    client.callWith(HttpMethod.Put, "/sessions/${table.id}/decisions", """{"week":1,"quantity":$quantity}""") {
        header("Idempotency-Key", key)
        header("Cookie", "bg_session=${table.cookie(who)}")
        header("If-Match", "\"$expected\"")
    }

private suspend fun ApplicationTestBuilder.proxy(
    table: CoTable,
    quantity: Int,
    key: String,
): HttpResponse =
    client.call(
        HttpMethod.Put,
        "/sessions/${table.id}/proxy-decisions/RETAILER",
        """{"requestedWeek":1,"quantity":$quantity}""",
        cookie = table.facilitator,
        key = key,
    )

private suspend fun ApplicationTestBuilder.stateOf(
    table: CoTable,
    cookie: String,
): JsonObject = client.call(HttpMethod.Get, "/sessions/${table.id}/state", cookie = cookie).body()

private fun JsonObject.int(name: String): Int = getValue(name).jsonPrimitive.content.toInt()

private fun JsonObject.flag(name: String): Boolean = getValue(name).jsonPrimitive.content.toBoolean()

class CoInputHttpSpec :
    FunSpec({
        test("[B6/6.1][AC2.2.1] 共同担当が保存した When 同じ役割の共同担当が状況を取得する Then 保存者（表示名つき）・保存の時刻・共同担当が返る") {
            withWorld { world ->
                val table = startedTable("a")
                world.clock.advance(SAVE_AT)
                save(table, OWNER_KEY, 7, "a-save", 0).status shouldBe HttpStatusCode.OK

                val view = stateOf(table, table.cookie(CO_KEY))

                val status = view.obj("roleStatus")
                status.int("decision") shouldBe 7
                status.obj("decisionEditor").str("kind") shouldBe "PARTICIPANT"
                status.obj("decisionEditor").str("displayName") shouldBe OWNER
                status.obj("decisionEditor").flag("isSelf") shouldBe false
                status.str("decisionSavedAt") shouldBe T0.plusSeconds(SAVE_AT).toString()
                val coHolders = view.array("coHolders").map { it.jsonObject }
                coHolders.map { it.str("displayName") }.toSet() shouldBe setOf(OWNER, CO_HOLDER)
                coHolders.single { it.str("displayName") == CO_HOLDER }.flag("isSelf") shouldBe true
                coHolders.forEach { it.keys shouldBe setOf("displayName", "isSelf") }
            }
        }

        test("[B6/6.1][AC2.1.2] 小売店の共同担当が保存した When 他の役割の参加者が状況を取得する Then 保存者・表示名・保存の時刻は、どの項目にも出ない") {
            withWorld { world ->
                val table = startedTable("b")
                world.clock.advance(SAVE_AT)
                save(table, OWNER_KEY, 7, "b-save", 0).status shouldBe HttpStatusCode.OK

                val view = stateOf(table, table.cookie("WHOLESALER"))

                val leaves = view.leafValues()
                leaves shouldNotContain OWNER
                leaves shouldNotContain CO_HOLDER
                leaves shouldNotContain T0.plusSeconds(SAVE_AT).toString()
                view.array("coHolders").map { it.jsonObject.str("displayName") } shouldBe
                    listOf(OTHERS.getValue("WHOLESALER"))
            }
        }

        test("[B6/6.1][AC2.2.4] 進行役が代理入力した When 進行役が状況を取得する Then 保存者は進行役（代理入力。表示名なし。isSelf）") {
            withWorld {
                val table = startedTable("c")
                proxy(table, 6, "c-proxy").status shouldBe HttpStatusCode.OK

                val editor = stateOf(table, table.facilitator).obj("roles").obj("RETAILER").obj("decisionEditor")

                editor.str("kind") shouldBe "FACILITATOR_PROXY"
                editor.flag("isSelf") shouldBe true
                editor.keys.contains("displayName") shouldBe false
            }
        }

        test(
            "[B6/6.1][AC2.2.3] 同じ版から 2 人が保存 When 2 人目が保存 Then 409 で最新値・保存者・時刻が返り、2 人目の値は無い",
        ) {
            withWorld { world ->
                val table = startedTable("d")
                world.clock.advance(SAVE_AT)
                save(table, OWNER_KEY, 7, "d-first", 0).status shouldBe HttpStatusCode.OK

                val response = save(table, CO_KEY, 321, "d-second", 0)

                response.status shouldBe HttpStatusCode.Conflict
                val body = response.body()
                body.str("code") shouldBe "session.decision_conflict"
                body.str("role") shouldBe "RETAILER"
                val latest = body.obj("latest")
                latest.int("quantity") shouldBe 7
                latest.int("version") shouldBe 1
                latest.str("savedAt") shouldBe T0.plusSeconds(SAVE_AT).toString()
                latest.obj("editor").str("kind") shouldBe "PARTICIPANT"
                latest.obj("editor").str("displayName") shouldBe OWNER
                latest.obj("editor").flag("isSelf") shouldBe false
                body.leafValues() shouldNotContain "321"
            }
        }

        test("[B6/6.1][AC2.2.4] 進行役の代理入力が先に上書きした When 共同担当が古い版で保存する Then 409 の最新値の保存者は進行役（表示名なし）") {
            withWorld {
                val table = startedTable("e")
                save(table, OWNER_KEY, 7, "e-first", 0).status shouldBe HttpStatusCode.OK
                proxy(table, 6, "e-proxy").status shouldBe HttpStatusCode.OK

                val response = save(table, CO_KEY, 9, "e-second", 1)

                response.status shouldBe HttpStatusCode.Conflict
                val latest = response.body().obj("latest")
                latest.int("quantity") shouldBe 6
                latest.int("version") shouldBe 2
                latest.obj("editor").str("kind") shouldBe "FACILITATOR_PROXY"
                latest.obj("editor").keys.contains("displayName") shouldBe false
            }
        }

        test("[B6/6.1][AC2.3.1] 確認の後に共同担当が保存し直した When 進行役が古い根拠で確定する Then 409 の decisions_changed で、現在の入力（保存者つき）が返る") {
            withWorld {
                val table = startedTable("f")
                listOf(
                    "RETAILER" to OWNER_KEY,
                    "WHOLESALER" to "WHOLESALER",
                    "DISTRIBUTOR" to "DISTRIBUTOR",
                    "FACTORY" to "FACTORY",
                ).forEach { (role, who) -> save(table, who, 4, "f-$role", 0).status shouldBe HttpStatusCode.OK }
                save(table, CO_KEY, 9, "f-again", 1).status shouldBe HttpStatusCode.OK

                val response =
                    client.call(
                        HttpMethod.Post,
                        "/sessions/${table.id}/weeks/1/commit",
                        """{"requestedWeek":1,"basis":{"RETAILER":1,"WHOLESALER":1,"DISTRIBUTOR":1,"FACTORY":1}}""",
                        cookie = table.facilitator,
                        key = "f-commit",
                    )

                response.status shouldBe HttpStatusCode.Conflict
                val body = response.body()
                body.str("code") shouldBe "session.decisions_changed"
                val retailer = body.obj("current").obj("RETAILER")
                retailer.int("quantity") shouldBe 9
                retailer.int("version") shouldBe 2
                retailer.obj("editor").str("displayName") shouldBe CO_HOLDER
                retailer.obj("editor").flag("isSelf") shouldBe false
                retailer.str("savedAt") shouldBe T0.toString()
            }
        }

        test(
            "[B6/6.1][ADR-004] 同じキーの再送は保存済みの応答で入力は 1 回だけ。別の操作者の同じキーは 409（key_reused）",
        ) {
            withWorld {
                val table = startedTable("g")
                val first = save(table, OWNER_KEY, 7, "g-key", 0)
                val again = save(table, OWNER_KEY, 7, "g-key", 0)

                again.status shouldBe HttpStatusCode.OK
                again.body() shouldBe first.body()
                stateOf(table, table.cookie(OWNER_KEY)).obj("roleStatus").int("decisionVersion") shouldBe 1

                val other = save(table, CO_KEY, 7, "g-key", 0)
                other.status shouldBe HttpStatusCode.Conflict
                other.body().str("code") shouldBe "app.idempotency_key_reused"
            }
        }

        test("[B6/6.1][ADR-004] 共同担当の資格を失効させた後に、以前に成功した冪等キーを再送する Then 403 の app.unauthorized で、保存済みの応答は返らない") {
            withWorld {
                val table = startedTable("h")
                save(table, CO_KEY, 7, "h-key", 0).status shouldBe HttpStatusCode.OK
                client
                    .call(
                        HttpMethod.Post,
                        "/games/${table.id}/credentials/revoke",
                        """{"subject":{"kind":"PARTICIPANT","id":"${table.ids.getValue(CO_KEY)}"}}""",
                        cookie = table.facilitator,
                        key = "h-revoke",
                    ).status shouldBe HttpStatusCode.OK

                val response = save(table, CO_KEY, 7, "h-key", 0)

                response.status shouldBe HttpStatusCode.Forbidden
                response.body().str("code") shouldBe "app.unauthorized"
            }
        }
    })
