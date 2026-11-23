package beergame.app

import beergame.application.AttemptPolicy
import io.kotest.core.spec.style.FunSpec
import io.kotest.matchers.shouldBe
import io.kotest.matchers.string.shouldContain
import io.kotest.matchers.string.shouldNotContain
import io.ktor.client.statement.HttpResponse
import io.ktor.client.statement.bodyAsText
import io.ktor.http.HttpMethod
import io.ktor.http.HttpStatusCode
import io.ktor.server.testing.ApplicationTestBuilder
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.jsonObject
import java.time.Duration
import java.time.Instant
import java.util.UUID

/*
 * 継続と資格の HTTP の試験（B5 Step 6.1）。経路・認可の行列・冪等の再送・Set-Cookie・code と problem+json を確かめる。
 * 業務の規則の網羅は domain と application の試験が持つので、ここは「境界」だけを確かめる。
 * 受け入れ（apps/beer-game-features/continuation）は、同じ振る舞いを日本語のシナリオで、実プロセスに対して確かめる。
 */

private const val SESSION_MAX_AGE = "Max-Age=86400"
private const val RECOVERY_MAX_AGE = "Max-Age=2592000"
private const val RECOVERY_PATH = "Path=/api/v1/participations/recover"
private const val DEMAND = "[4,999,998]"
private const val RECOVER_PATH = "/participations/recover"
private const val UNKNOWN_CODE = "v1.unknown-recovery-code"
private val ROLES = listOf("FACTORY", "DISTRIBUTOR", "WHOLESALER", "RETAILER")

private class Member(
    val role: String?,
    val participantId: String,
    val session: String,
    val recovery: String,
)

private class Table(
    val id: String,
    val facilitator: String,
    val facilitatorRecovery: String,
    val facilitatorCode: String,
    val joinCode: String,
    val members: Map<String, Member>,
) {
    fun member(role: String): Member = members.getValue(role)
}

private fun newKey(): String = UUID.randomUUID().toString()

private fun HttpResponse.setCookie(name: String): String? =
    headers.getAll("Set-Cookie").orEmpty().firstOrNull { it.startsWith("$name=") }

private fun HttpResponse.cookieValue(name: String): String? =
    setCookie(name)?.substringAfter("$name=")?.substringBefore(";")

private fun cookies(
    session: String? = null,
    recovery: String? = null,
): String? =
    listOfNotNull(session?.let { "bg_session=$it" }, recovery?.let { "bg_recovery=$it" })
        .joinToString("; ")
        .ifEmpty { null }

private suspend fun ApplicationTestBuilder.send(
    method: HttpMethod,
    path: String,
    body: String? = null,
    session: String? = null,
    key: String? = newKey(),
): HttpResponse = sendWithCookies(method, path, body, cookies(session), key)

/** Cookie ヘッダーそのもの（`bg_session`・`bg_recovery`）を渡して送る。 */
private suspend fun ApplicationTestBuilder.sendWithCookies(
    method: HttpMethod,
    path: String,
    body: String?,
    cookieHeader: String?,
    key: String?,
): HttpResponse =
    client.callWith(method, path, body) {
        key?.let { headers.append("Idempotency-Key", it) }
        cookieHeader?.let { headers.append("Cookie", it) }
    }

private suspend fun ApplicationTestBuilder.createTable(
    tag: String,
    start: Boolean,
    spare: Boolean = false,
): Table {
    val created =
        send(HttpMethod.Post, "/games", """{"kind":"KIT","finalWeek":3,"demand":$DEMAND}""", key = "create-$tag")
    val facilitator = created.credential() ?: error("進行役のブラウザセッションが無い")
    val id =
        created.headers["Location"]
            .orEmpty()
            .removePrefix("$API/games/")
            .removeSuffix("/state")
    val joinCode = send(HttpMethod.Get, "/games/$id/state", session = facilitator, key = null).body().str("joinCode")
    val joined = mutableMapOf<String, Member>()
    val names = ROLES.associateWith { "$it-$tag" } + if (spare) mapOf("SPARE" to "控え-$tag") else emptyMap()
    names.forEach { (role, name) ->
        val response =
            send(HttpMethod.Post, "/participations/join", """{"joinCode":"$joinCode","displayName":"$name"}""")
        joined[role] = Member(null, "", response.credential().orEmpty(), response.cookieValue("bg_recovery").orEmpty())
    }
    val lobby = send(HttpMethod.Get, "/games/$id/lobby", session = facilitator, key = null).body().array("participants")
    val members =
        joined.mapValues { (role, member) ->
            val participantId =
                lobby.map { it.jsonObject }.first { it.str("displayName") == names.getValue(role) }.str("participantId")
            if (role != "SPARE") {
                send(
                    HttpMethod.Put,
                    "/games/$id/participants/$participantId/role",
                    """{"role":"$role"}""",
                    session = facilitator,
                ).status shouldBe HttpStatusCode.OK
            }
            Member(role.takeIf { it != "SPARE" }, participantId, member.session, member.recovery)
        }
    if (start) {
        send(HttpMethod.Post, "/games/$id/start", session = facilitator).status shouldBe HttpStatusCode.OK
    }
    return Table(
        id,
        facilitator,
        created.cookieValue("bg_recovery").orEmpty(),
        created.body().str("recoveryCode"),
        joinCode,
        members,
    )
}

private suspend fun ApplicationTestBuilder.pause(
    table: Table,
    session: String? = table.facilitator,
    key: String? = newKey(),
) = send(HttpMethod.Post, "/sessions/${table.id}/pause", session = session, key = key)

private suspend fun ApplicationTestBuilder.resume(
    table: Table,
    session: String? = table.facilitator,
) = send(HttpMethod.Post, "/sessions/${table.id}/resume", session = session)

private suspend fun ApplicationTestBuilder.proxy(
    table: Table,
    role: String,
    week: Int,
    quantity: Int,
    session: String? = table.facilitator,
) = send(
    HttpMethod.Put,
    "/sessions/${table.id}/proxy-decisions/$role",
    """{"requestedWeek":$week,"quantity":$quantity}""",
    session = session,
)

private fun subject(participantId: String) = """{"subject":{"kind":"PARTICIPANT","id":"$participantId"}}"""

private suspend fun ApplicationTestBuilder.revoke(
    table: Table,
    role: String,
    session: String? = table.facilitator,
) = send(
    HttpMethod.Post,
    "/games/${table.id}/credentials/revoke",
    subject(table.member(role).participantId),
    session = session,
)

private suspend fun ApplicationTestBuilder.reissue(
    table: Table,
    role: String,
    session: String? = table.facilitator,
    key: String? = newKey(),
) = send(
    HttpMethod.Post,
    "/games/${table.id}/credentials/reissue",
    subject(table.member(role).participantId),
    session = session,
    key = key,
)

private suspend fun ApplicationTestBuilder.recover(
    gameId: String,
    recovery: String? = null,
    code: String? = null,
    key: String? = newKey(),
) = sendWithCookies(
    HttpMethod.Post,
    "/participations/recover",
    """{"gameId":"$gameId"${code?.let { ",\"recoveryCode\":\"$it\"" } ?: ""}}""",
    cookies(recovery = recovery),
    key,
)

private suspend fun ApplicationTestBuilder.save(
    table: Table,
    role: String,
    quantity: Int,
    version: Int,
    key: String = newKey(),
) = client.callWith(HttpMethod.Put, "/sessions/${table.id}/decisions", """{"week":1,"quantity":$quantity}""") {
    headers.append("Idempotency-Key", key)
    headers.append("Cookie", "bg_session=${table.member(role).session}")
    headers.append("If-Match", "\"$version\"")
}

private suspend fun ApplicationTestBuilder.sessionStatus(table: Table): String =
    send(HttpMethod.Get, "/sessions/${table.id}/state", session = table.facilitator, key = null).body().str("status")

private suspend fun ApplicationTestBuilder.gameStateOf(
    table: Table,
    session: String?,
) = send(HttpMethod.Get, "/games/${table.id}/state", session = session, key = null)

class ContinuationHttpSpec :
    FunSpec({
        test("[US1.1/H3] 作成の応答: versions と復帰コード（recoveryCode）。bg_session は 24 時間、bg_recovery は 30 日（復帰の経路だけ）") {
            withWorld { world ->
                val created = send(HttpMethod.Post, "/games", """{"kind":"KIT","finalWeek":3,"demand":$DEMAND}""")

                created.status shouldBe HttpStatusCode.Created
                val body = created.body()
                body.keys shouldBe setOf("versions", "recoveryCode")
                val session = checkNotNull(created.setCookie("bg_session"))
                val recovery = checkNotNull(created.setCookie("bg_recovery"))
                session shouldContain SESSION_MAX_AGE
                session shouldContain "HttpOnly"
                session shouldContain "SameSite=Strict"
                recovery shouldContain RECOVERY_MAX_AGE
                recovery shouldContain "HttpOnly"
                recovery shouldContain "SameSite=Strict"
                recovery shouldContain RECOVERY_PATH
                recovery shouldNotContain "\$x-enc"
                // 復帰コードは、復帰資格の値（ブラウザセッションの値とは別）
                body.str("recoveryCode") shouldBe created.cookieValue("bg_recovery")
                body.str("recoveryCode") shouldBe body.str("recoveryCode").trim()
                (body.str("recoveryCode") == created.cookieValue("bg_session")) shouldBe false
                created.bodyAsText() shouldNotContain checkNotNull(created.cookieValue("bg_session"))
                world.logs.text() shouldNotContain body.str("recoveryCode")
            }
        }

        test("[実測] 冪等な再送（同じ Idempotency-Key・同じ本文）でも、作成・再発行の応答は同じ復帰コードを返す") {
            withWorld { world ->
                val body = """{"kind":"KIT","finalWeek":3,"demand":$DEMAND}"""
                val first = send(HttpMethod.Post, "/games", body, key = "same-create")
                val second = send(HttpMethod.Post, "/games", body, key = "same-create")

                second.status shouldBe HttpStatusCode.Created
                second.body().str("recoveryCode") shouldBe first.body().str("recoveryCode")
                second.cookieValue("bg_recovery") shouldBe first.cookieValue("bg_recovery")
                world.logs.text() shouldNotContain first.body().str("recoveryCode")

                val table = createTable("reissue-replay", start = true)
                revoke(table, "RETAILER").status shouldBe HttpStatusCode.OK
                val before = world.count("credentials")
                val one = reissue(table, "RETAILER", key = "same-reissue")
                val two = reissue(table, "RETAILER", key = "same-reissue")

                two.status shouldBe HttpStatusCode.OK
                two.body().str("recoveryCode") shouldBe one.body().str("recoveryCode")
                two.body().str("expiresAt") shouldBe one.body().str("expiresAt")
                // 再送は新しい資格を作らない（作ったのは最初の 1 回だけ）
                (world.count("credentials") - before) shouldBe 1
            }
        }

        test("[判断項目 7] 参加の応答: versions と gameId。復帰資格は bg_recovery の Cookie（本文に出さない）") {
            withWorld {
                val created = send(HttpMethod.Post, "/games", """{"kind":"KIT","finalWeek":3,"demand":$DEMAND}""")
                val id =
                    created.headers["Location"]
                        .orEmpty()
                        .removePrefix("$API/games/")
                        .removeSuffix("/state")
                val facilitator = checkNotNull(created.credential())
                val joinCode =
                    send(
                        HttpMethod.Get,
                        "/games/$id/state",
                        session = facilitator,
                        key = null,
                    ).body().str("joinCode")

                val joined =
                    send(HttpMethod.Post, "/participations/join", """{"joinCode":"$joinCode","displayName":"田中"}""")

                joined.status shouldBe HttpStatusCode.OK
                joined.body().keys shouldBe setOf("versions", "gameId")
                joined.body().str("gameId") shouldBe id
                checkNotNull(joined.setCookie("bg_session")) shouldContain SESSION_MAX_AGE
                checkNotNull(joined.setCookie("bg_recovery")) shouldContain RECOVERY_MAX_AGE
                joined.bodyAsText() shouldNotContain checkNotNull(joined.cookieValue("bg_recovery"))
            }
        }

        test("[認可の行列] 停止・再開・代理入力・失効・再発行は進行役だけ。参加者・資格なし・不明・別のゲームの進行役は、同じ 403 の本文") {
            withWorld {
                val table = createTable("matrix", start = true)
                val other = createTable("matrix-other", start = false)
                val retailer = table.member("RETAILER").session
                val credentials = listOf(retailer, null, "unknown-session", other.facilitator)
                // 判定の順は「状態 → 権限」（ゲート 2 の決定）。権限が判定に届くよう、再開は停止中のゲームで試す
                val pausedTable = createTable("matrix-paused", start = true)
                pause(pausedTable).status shouldBe HttpStatusCode.OK
                val calls: List<suspend (String?) -> HttpResponse> =
                    listOf(
                        { who -> pause(table, who) },
                        { who -> resume(pausedTable, who) },
                        { who -> proxy(table, "RETAILER", 1, 4, who) },
                        { who -> revoke(table, "WHOLESALER", who) },
                        { who -> reissue(table, "WHOLESALER", who) },
                    )

                calls.forEach { call ->
                    val denied = credentials.map { call(it) }
                    denied.forEach { it.status shouldBe HttpStatusCode.Forbidden }
                    denied.forEach { it.body().str("code") shouldBe "app.unauthorized" }
                    denied.map { it.problemWithoutCorrelation() }.toSet().size shouldBe 1
                }
                // 拒否は、何も変えない
                sessionStatus(table) shouldBe "ACTIVE"
                sessionStatus(pausedTable) shouldBe "PAUSED"
                // 状態が先に判定される（ゲート 2）。資格のある参加者が、停止中でないゲームを再開しようとすると 409
                resume(table, retailer).body().str("code") shouldBe "session.not_paused"
            }
        }

        test("[AC3.1.1・AC3.1.3] 停止 → 再開: 停止中は保存・確定を session.paused（409）で拒否し、入力は残る。再開すると、続きから入力できる") {
            withWorld {
                val table = createTable("pause", start = true)
                save(table, "RETAILER", 4, 0).status shouldBe HttpStatusCode.OK

                val paused = pause(table)

                paused.status shouldBe HttpStatusCode.OK
                paused.body().keys shouldBe setOf("versions")
                sessionStatus(table) shouldBe "PAUSED"
                val refusedSave = save(table, "WHOLESALER", 7, 0)
                refusedSave.status shouldBe HttpStatusCode.Conflict
                refusedSave.body().str("code") shouldBe "session.paused"
                refusedSave.headers["Content-Type"].orEmpty() shouldContain "application/problem+json"
                refusedSave.body().str("type") shouldBe "/problems/session.paused"
                val basis = ROLES.joinToString(",") { "\"$it\":1" }
                val refusedCommit =
                    send(
                        HttpMethod.Post,
                        "/sessions/${table.id}/weeks/1/commit",
                        """{"requestedWeek":1,"basis":{$basis}}""",
                        session = table.facilitator,
                    )
                refusedCommit.status shouldBe HttpStatusCode.Conflict
                refusedCommit.body().str("code") shouldBe "session.paused"
                pause(table).body().str("code") shouldBe "session.paused"
                val retailerState =
                    send(
                        HttpMethod.Get,
                        "/sessions/${table.id}/state",
                        session = table.member("RETAILER").session,
                        key = null,
                    )
                retailerState.body().obj("roleStatus").str("decision") shouldBe "4"

                val resumed = resume(table)

                resumed.status shouldBe HttpStatusCode.OK
                resumed.body().keys shouldBe setOf("versions")
                sessionStatus(table) shouldBe "ACTIVE"
                resume(table).body().str("code") shouldBe "session.not_paused"
                save(table, "WHOLESALER", 7, 0).status shouldBe HttpStatusCode.OK
            }
        }

        test("[AC3.1.2] 代理入力: 進行中・停止中のどちらでも受け付け、停止中は確定しない。古い週は session.week_advanced。監査履歴に値が残る") {
            withWorld { world ->
                val table = createTable("proxy", start = true)
                pause(table).status shouldBe HttpStatusCode.OK

                val accepted = proxy(table, "FACTORY", 1, 6)

                accepted.status shouldBe HttpStatusCode.OK
                accepted.body().keys shouldBe setOf("versions")
                sessionStatus(table) shouldBe "PAUSED"
                val stale = proxy(table, "FACTORY", 2, 6)
                stale.status shouldBe HttpStatusCode.Conflict
                stale.body().str("code") shouldBe "session.week_advanced"
                world.count(
                    "events WHERE event_type = 'ProxyDecisionSubmitted' AND actor_kind = 'FACILITATOR'",
                ) shouldBe
                    1
                proxy(table, "FACTORY", 1, 1001).status shouldBe HttpStatusCode.UnprocessableEntity
                proxy(table, "MANAGER", 1, 6).status shouldBe HttpStatusCode.UnprocessableEntity
                send(
                    HttpMethod.Put,
                    "/sessions/${table.id}/proxy-decisions/FACTORY",
                    """{"quantity":6}""",
                    session = table.facilitator,
                ).status shouldBe HttpStatusCode.UnprocessableEntity
            }
        }

        test("[NF-C8] 保存回数の上限: 1 役割・1 週あたり 9 回。10 回目は session.save_limit_reached（409）") {
            withWorld {
                val table = createTable("limit", start = true)
                (0 until 9).forEach { save(table, "RETAILER", it + 1, it).status shouldBe HttpStatusCode.OK }

                val over = save(table, "RETAILER", 100, 9)

                over.status shouldBe HttpStatusCode.Conflict
                over.body().str("code") shouldBe "session.save_limit_reached"
            }
        }

        test("[AC3.2.5・ADR-004] 失効: 以前の資格は使えず、以前に成功した識別子の再送も 403。二重の失効・有効な資格の再発行は 409") {
            withWorld {
                val table = createTable("revoke", start = true)
                val member = table.member("RETAILER")
                val sentKey = "sent-before-revoke"
                save(table, "RETAILER", 4, 0, key = sentKey).status shouldBe HttpStatusCode.OK
                reissue(table, "RETAILER").body().str("code") shouldBe "game.credential_not_revoked"

                val revoked = revoke(table, "RETAILER")

                revoked.status shouldBe HttpStatusCode.OK
                revoked.body().keys shouldBe setOf("versions")
                gameStateOf(table, member.session).status shouldBe HttpStatusCode.Forbidden
                recover(table.id, recovery = member.recovery).status shouldBe HttpStatusCode.Forbidden
                save(table, "RETAILER", 4, 0, key = sentKey).status shouldBe HttpStatusCode.Forbidden
                val again = revoke(table, "RETAILER")
                again.status shouldBe HttpStatusCode.Conflict
                again.body().str("code") shouldBe "game.credential_already_revoked"
                gameStateOf(table, table.member("WHOLESALER").session).status shouldBe HttpStatusCode.OK
            }
        }

        test("[AC3.2.5] 再発行: 新しい復帰コードと期限を一度だけ示す。新しいコードで復帰でき、失効した古い資格は使えないまま") {
            withWorld {
                val table = createTable("reissue", start = true)
                val member = table.member("RETAILER")
                revoke(table, "RETAILER").status shouldBe HttpStatusCode.OK

                val reissued = reissue(table, "RETAILER")

                reissued.status shouldBe HttpStatusCode.OK
                reissued.body().keys shouldBe setOf("versions", "recoveryCode", "expiresAt")
                Instant.parse(reissued.body().str("expiresAt")) shouldBe
                    Instant.parse("2026-11-16T09:00:00Z").plus(Duration.ofDays(30))
                val code = reissued.body().str("recoveryCode")
                recover(table.id, recovery = member.recovery).status shouldBe HttpStatusCode.Forbidden
                gameStateOf(table, member.session).status shouldBe HttpStatusCode.Forbidden

                val recovered = recover(table.id, code = code)

                recovered.status shouldBe HttpStatusCode.OK
                val fresh = checkNotNull(recovered.credential())
                gameStateOf(table, fresh).body().str("role") shouldBe "RETAILER"
            }
        }

        test("[入力の形] 失効・再発行の対象: 形が違えば 422、存在しない参加者は 404、進行役自身の資格は対象外") {
            withWorld {
                val table = createTable("subject", start = true)
                val path = "/games/${table.id}/credentials/revoke"
                val unknown = "00000000-0000-0000-0000-000000000009"

                listOf(
                    "{}",
                    """{"subject":{"kind":"FACILITATOR","id":"${table.id}"}}""",
                    """{"subject":{"kind":"PARTICIPANT","id":"not-a-uuid"}}""",
                    """{"subject":{"kind":"PARTICIPANT"}}""",
                ).forEach { body ->
                    send(HttpMethod.Post, path, body, session = table.facilitator).status shouldBe
                        HttpStatusCode.UnprocessableEntity
                }
                val missing = send(HttpMethod.Post, path, subject(unknown), session = table.facilitator)
                missing.status shouldBe HttpStatusCode.NotFound
                missing.body().str("code") shouldBe "game.participant_not_found"
            }
        }

        test("[AC3.2.1・AC3.2.4] 復帰: Cookie でも本文の復帰コードでも復帰できる。新しい bg_session（24 時間）を発行し、gameId・kind・role を返す") {
            withWorld {
                val table = createTable("recover", start = true)
                val member = table.member("RETAILER")

                val byCookie = recover(table.id, recovery = member.recovery)

                byCookie.status shouldBe HttpStatusCode.OK
                byCookie.body().keys shouldBe setOf("versions", "gameId", "kind", "role")
                byCookie.body().str("gameId") shouldBe table.id
                byCookie.body().str("kind") shouldBe "PARTICIPANT"
                byCookie.body().str("role") shouldBe "RETAILER"
                checkNotNull(byCookie.setCookie("bg_session")) shouldContain SESSION_MAX_AGE
                byCookie.setCookie("bg_recovery") shouldBe null
                val fresh = checkNotNull(byCookie.credential())
                gameStateOf(table, fresh).body().str("participantId") shouldBe member.participantId

                val facilitator = recover(table.id, code = table.facilitatorCode)

                facilitator.status shouldBe HttpStatusCode.OK
                facilitator.body().str("kind") shouldBe "FACILITATOR"
                facilitator.body().containsKey("role") shouldBe false
                gameStateOf(table, facilitator.credential()).body().str("joinCode") shouldBe table.joinCode
                val viaCookie = recover(table.id, recovery = table.facilitatorRecovery)
                viaCookie.status shouldBe HttpStatusCode.OK
                // 本文の復帰コードは、Cookie より優先する
                val prefer = recover(table.id, recovery = member.recovery, code = table.member("WHOLESALER").recovery)
                prefer.body().str("role") shouldBe "WHOLESALER"
            }
        }

        test("[AC3.2.2・NF-S12] 復帰の失敗: なし・不明・失効・期限切れ・別のゲーム・形式違いは、すべて同じ 403 の本文。セッションは発行しない") {
            withWorld { world ->
                // 期限切れの復帰資格だけを先に作り、時計を進めてから、ほかのゲームを作る（期限切れが、ほかの拒否の理由にならない）
                val expiring = createTable("refuse-expire", start = true)
                world.clock.advance(31L * 24 * 3600)
                val table = createTable("refuse", start = true)
                val other = createTable("refuse-other", start = true)
                revoke(table, "WHOLESALER").status shouldBe HttpStatusCode.OK

                val refused =
                    listOf(
                        recover(table.id),
                        recover(table.id, recovery = UNKNOWN_CODE),
                        recover(table.id, code = "garbage"),
                        recover(table.id, recovery = table.member("WHOLESALER").recovery),
                        recover(table.id, recovery = other.member("RETAILER").recovery),
                        recover(expiring.id, recovery = expiring.member("RETAILER").recovery),
                    )

                refused.forEach { it.status shouldBe HttpStatusCode.Forbidden }
                refused.forEach { it.body().str("code") shouldBe "app.unauthorized" }
                refused.forEach { it.credential() shouldBe null }
                refused.map { it.problemWithoutCorrelation() }.toSet().size shouldBe 1
            }
        }

        test("[ADR-004] 復帰の再送: 同じキー・同じ復帰資格は同じ応答。失効の後は 403（保存済みのセッションを返さない）。別の復帰資格は 409") {
            withWorld {
                val table = createTable("recover-replay", start = true)
                val member = table.member("RETAILER")
                val first = recover(table.id, recovery = member.recovery, key = "recover-1")
                first.status shouldBe HttpStatusCode.OK

                val replay = recover(table.id, recovery = member.recovery, key = "recover-1")
                replay.status shouldBe HttpStatusCode.OK
                replay.credential() shouldBe first.credential()
                val reused = recover(table.id, recovery = table.member("WHOLESALER").recovery, key = "recover-1")
                reused.status shouldBe HttpStatusCode.Conflict
                reused.body().str("code") shouldBe "app.idempotency_key_reused"

                revoke(table, "RETAILER").status shouldBe HttpStatusCode.OK
                val afterRevoke = recover(table.id, recovery = member.recovery, key = "recover-1")
                afterRevoke.status shouldBe HttpStatusCode.Forbidden
                afterRevoke.credential() shouldBe null
            }
        }

        test("[入力の形] 復帰の本文: gameId が無い・UUID でない場合は 422、JSON でなければ 400。Idempotency-Key が無ければ 400") {
            withWorld {
                val table = createTable("recover-shape", start = true)
                val recovery = table.member("RETAILER").recovery

                listOf(
                    "{}",
                    """{"gameId":"not-a-uuid"}""",
                    """{"gameId":"${table.id}","recoveryCode":5}""",
                ).forEach { body ->
                    sendWithCookies(
                        HttpMethod.Post,
                        RECOVER_PATH,
                        body,
                        cookies(recovery = recovery),
                        newKey(),
                    ).status shouldBe
                        HttpStatusCode.UnprocessableEntity
                }
                val notJson = "{ここは JSON ではない"
                sendWithCookies(
                    HttpMethod.Post,
                    RECOVER_PATH,
                    notJson,
                    cookies(recovery = recovery),
                    newKey(),
                ).status shouldBe
                    HttpStatusCode.BadRequest
                recover(table.id, recovery = recovery, key = null).status shouldBe HttpStatusCode.BadRequest
            }
        }

        test("[NF-S11] 復帰の総当たり: 失敗が上限（2 回）の接続元は、正しい復帰資格でも 429（Retry-After つき）。成功は数えない") {
            val attempts = AttemptPolicy.of(2, Duration.ofMinutes(10)).getOrNull() ?: error("窓の設定が不正")
            withWorld(World(attempts = attempts)) { world ->
                val table = createTable("recover-limit", start = true)
                val recovery = table.member("RETAILER").recovery

                repeat(5) { recover(table.id, recovery = recovery).status shouldBe HttpStatusCode.OK }
                repeat(2) { recover(table.id, recovery = UNKNOWN_CODE).status shouldBe HttpStatusCode.Forbidden }

                val blocked = recover(table.id, recovery = recovery)

                blocked.status shouldBe HttpStatusCode.TooManyRequests
                blocked.body().str("code") shouldBe "app.rate_limited"
                blocked.headers["Retry-After"] shouldBe "600"
                world.clock.advance(600)
                recover(table.id, recovery = recovery).status shouldBe HttpStatusCode.OK
            }
        }

        test("[H4・AC3.2.5] 入れ替え（開始後の assignRole）: 旧担当者の資格は失効し、新担当者が引き継ぐ。ロビーは旧担当者を replaced で示す") {
            withWorld {
                val table = createTable("replace", start = true, spare = true)
                val old = table.member("RETAILER")
                val incoming = table.member("SPARE")
                save(table, "RETAILER", 4, 0).status shouldBe HttpStatusCode.OK

                val replaced =
                    send(
                        HttpMethod.Put,
                        "/games/${table.id}/participants/${incoming.participantId}/role",
                        """{"role":"RETAILER"}""",
                        session = table.facilitator,
                    )

                replaced.status shouldBe HttpStatusCode.OK
                replaced.body().keys shouldBe setOf("versions")
                // 入れ替えは game と session の 2 ストリームにまたがる（両方の版が進む）
                (replaced.body().obj("versions")["game"] == JsonNull) shouldBe false
                (replaced.body().obj("versions")["session"] == JsonNull) shouldBe false
                gameStateOf(table, old.session).status shouldBe HttpStatusCode.Forbidden
                recover(table.id, recovery = old.recovery).status shouldBe HttpStatusCode.Forbidden
                gameStateOf(table, incoming.session).body().str("role") shouldBe "RETAILER"
                save(table, "RETAILER", 5, 1).status shouldBe HttpStatusCode.Forbidden
                val lobby =
                    send(HttpMethod.Get, "/games/${table.id}/lobby", session = table.facilitator, key = null)
                        .body()
                        .array("participants")
                        .map { it.jsonObject }
                lobby.first { it.str("participantId") == old.participantId }["replaced"]?.toString() shouldBe "true"
                lobby.first { it.str("participantId") == incoming.participantId }.str("role") shouldBe "RETAILER"
            }
        }

        test("[H4] 入れ替えの拒否: 進行役以外は 403、別の役割にいる人の付け替えは game.not_preparing、失効した参加者は game.credential_already_revoked") {
            withWorld {
                val table = createTable("replace-refuse", start = true, spare = true)
                val spare = table.member("SPARE")

                suspend fun assign(
                    id: String,
                    role: String,
                    who: String?,
                ) = send(
                    HttpMethod.Put,
                    "/games/${table.id}/participants/$id/role",
                    """{"role":"$role"}""",
                    session = who,
                )

                assign(spare.participantId, "RETAILER", table.member("RETAILER").session).status shouldBe
                    HttpStatusCode.Forbidden
                val moved = assign(table.member("WHOLESALER").participantId, "RETAILER", table.facilitator)
                moved.status shouldBe HttpStatusCode.Conflict
                moved.body().str("code") shouldBe "game.not_preparing"
                send(
                    HttpMethod.Post,
                    "/games/${table.id}/credentials/revoke",
                    subject(spare.participantId),
                    session = table.facilitator,
                ).status shouldBe HttpStatusCode.OK
                val revoked = assign(spare.participantId, "RETAILER", table.facilitator)
                revoked.status shouldBe HttpStatusCode.Conflict
                revoked.body().str("code") shouldBe "game.credential_already_revoked"
                val same = assign(table.member("RETAILER").participantId, "RETAILER", table.facilitator)
                same.status shouldBe HttpStatusCode.OK
            }
        }

        test("[Max-Age の整合] ブラウザセッションの Cookie（24 時間）と有効期限は一致する。期限が切れても、復帰資格で復帰できる") {
            withWorld { world ->
                val table = createTable("ttl", start = true)
                val member = table.member("RETAILER")
                gameStateOf(table, member.session).status shouldBe HttpStatusCode.OK

                world.clock.advance(24L * 3600 - 1)
                gameStateOf(table, member.session).status shouldBe HttpStatusCode.OK
                world.clock.advance(1)
                gameStateOf(table, member.session).status shouldBe HttpStatusCode.Forbidden
                gameStateOf(table, table.facilitator).status shouldBe HttpStatusCode.Forbidden

                val recovered = recover(table.id, recovery = member.recovery)

                recovered.status shouldBe HttpStatusCode.OK
                gameStateOf(table, recovered.credential()).status shouldBe HttpStatusCode.OK
                val facilitator = recover(table.id, code = table.facilitatorCode)
                gameStateOf(table, facilitator.credential()).body().str("joinCode") shouldBe table.joinCode
            }
        }

        test("[NF-S14] ログ: 継続と資格の流れを通しても、復帰コード・資格の値・参加コードを含まない") {
            withWorld { world ->
                val table = createTable("logs", start = true)
                val member = table.member("RETAILER")
                pause(table)
                resume(table)
                revoke(table, "RETAILER")
                val code = reissue(table, "RETAILER").body().str("recoveryCode")
                recover(table.id, code = code)

                val text = world.logs.text()

                listOf(code, member.session, member.recovery, table.facilitator, table.facilitatorCode, table.joinCode)
                    .forEach { text shouldNotContain it }
            }
        }
    })
