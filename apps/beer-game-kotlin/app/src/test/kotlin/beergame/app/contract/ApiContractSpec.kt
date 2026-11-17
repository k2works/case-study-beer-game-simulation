package beergame.app.contract

import beergame.app.World
import beergame.app.array
import beergame.app.body
import beergame.app.credential
import beergame.app.str
import beergame.app.withWorld
import beergame.application.Ports
import io.kotest.assertions.withClue
import io.kotest.core.spec.style.FunSpec
import io.kotest.matchers.collections.shouldBeEmpty
import io.kotest.matchers.collections.shouldContain
import io.kotest.matchers.collections.shouldContainExactlyInAnyOrder
import io.kotest.matchers.shouldBe
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpMethod
import io.ktor.server.testing.ApplicationTestBuilder
import java.nio.file.Files
import java.nio.file.Path
import java.util.concurrent.atomic.AtomicBoolean

/*
 * API の契約テスト（ADR-008、test-strategy.md「API の契約テスト（OpenAPI）」）。
 * 仕様 contracts/openapi.yaml と、実際のルート（H2 の永続化つき。PostgreSQL は不要）の一致を、機械的に確かめる。
 * HttpFlowSpec は境界の振る舞い（認可・検証・写像）を確かめる。ここは、仕様と実装が同じことを言っているかを確かめる。
 * 「仕様の検証」（redocly lint）と「型の生成物の差分 0」は、web/ の npm スクリプトと CI が受け持つ。
 */

private val PROBES = setOf("getHealth", "getReady")

private const val UNKNOWN_PARTICIPANT = "00000000-0000-0000-0000-000000000009"

internal fun findSpecFile(): Path =
    generateSequence(Path.of("").toAbsolutePath()) { it.parent }
        .map { it.resolve("contracts/openapi.yaml") }
        .first { Files.exists(it) }

internal val DOC: OpenApiDocument = OpenApiDocument.load(findSpecFile())

private fun domainSources(): Path = findSpecFile().parent.parent.resolve("domain/src/main/kotlin")

private fun withContract(
    world: World = World(),
    block: suspend ApplicationTestBuilder.(ContractClient, World) -> Unit,
) = withWorld(world) { w -> block(ContractClient(client, DOC), w) }

/** 1 回の呼び出し。 */
private class Call(
    val method: HttpMethod,
    val path: String,
    val body: String? = null,
    val cookie: String? = null,
    val headers: Map<String, String> = emptyMap(),
    val recovery: String? = null,
)

private fun get(
    path: String,
    cookie: String? = null,
) = Call(HttpMethod.Get, path, cookie = cookie)

private fun post(
    path: String,
    body: String? = null,
    cookie: String? = null,
) = Call(HttpMethod.Post, path, body, cookie)

private fun put(
    path: String,
    body: String,
    cookie: String? = null,
    ifMatch: String? = null,
) = Call(HttpMethod.Put, path, body, cookie, listOfNotNull(ifMatch?.let { "If-Match" to "\"$it\"" }).toMap())

/** 呼び出して、応答を仕様に照らし（違反なら失敗）、状態が [status] であることを確かめる。 */
private suspend fun ContractClient.expect(
    status: Int,
    call: Call,
) = send(call.method, call.path, call.body, call.cookie, call.headers + call.recoveryCookie()).also {
    it.status.value shouldBe status
}

/** 復帰資格の Cookie（bg_session とは別の Cookie ヘッダーにはせず、復帰の経路だけが読む）。 */
private fun Call.recoveryCookie(): Map<String, String> =
    recovery?.let { mapOf(HttpHeaders.Cookie to "bg_recovery=$it") }.orEmpty()

private const val BAD_DEMAND = """{"kind":"KIT","finalWeek":2,"demand":[4,1001]}"""
private const val OTHER_GAME = """{"kind":"KIT","finalWeek":2,"demand":[1,2]}"""

/** 準備中の経路: 作成・参加・割り当て・ロビーの、成功と失敗。 */
private suspend fun ContractClient.preparingPhase(): PlayedGame {
    expect(400, post("/games", "{ここは JSON ではない"))
    expect(422, post("/games", BAD_DEMAND))
    expect(201, Call(HttpMethod.Post, "/games", KIT_GAME, headers = mapOf(IDEMPOTENCY_KEY to "same-key")))
    expect(409, Call(HttpMethod.Post, "/games", OTHER_GAME, headers = mapOf(IDEMPOTENCY_KEY to "same-key")))
    val game = prepared()
    val retailer = game.cookieOf("RETAILER")
    expect(403, post("/participations/join", """{"joinCode":"ZZZZZZZZZZZZ","displayName":"田中"}"""))
    expect(422, post("/participations/join", """{"displayName":"田中"}"""))
    expect(403, get("/games/${game.id}/state"))
    expect(200, get("/games/${game.id}/state", retailer))
    expect(403, get("/games/${game.id}/lobby", retailer))
    expect(
        404,
        put("/games/${game.id}/participants/$UNKNOWN_PARTICIPANT/role", """{"role":"FACTORY"}""", game.facilitator),
    )
    val factoryRole = "/games/${game.id}/participants/${game.players.getValue("FACTORY").participantId}/role"
    expect(422, put(factoryRole, """{"role":"MANAGER"}""", game.facilitator))
    expect(409, get("/sessions/${game.id}/state", game.facilitator))
    return game
}

/** 開始の経路: 条件の不足、成功、二重の開始、受付終了後の参加。 */
private suspend fun ContractClient.startPhase(game: PlayedGame) {
    val lonely = createGame()
    val lonelyId =
        lonely.headers["Location"]
            .orEmpty()
            .substringAfter("/games/")
            .substringBefore("/state")
    expect(422, post("/games/$lonelyId/start", cookie = lonely.credential()))
    expect(200, post("/games/${game.id}/start", cookie = game.facilitator))
    expect(409, post("/games/${game.id}/start", cookie = game.facilitator))
    expect(409, post("/participations/join", """{"joinCode":"${game.joinCode}","displayName":"遅刻"}"""))
}

/** 進行の経路: 入力、確定、役割別の表示、週の進行後の確定。 */
private suspend fun ContractClient.playPhase(game: PlayedGame) {
    val decisions = "/sessions/${game.id}/decisions"
    val commit = "/sessions/${game.id}/weeks/1/commit"
    expect(422, put(decisions, """{"week":1,"quantity":1001}""", game.cookieOf("FACTORY")))
    expect(403, put(decisions, """{"week":1,"quantity":4}""", game.facilitator))
    expect(422, post(commit, commitBody(1, 0), game.facilitator))
    playFirstWeek(game)
    expect(409, post(commit, commitBody(1, 1), game.facilitator))
    ROLES.forEach { expect(200, get("/sessions/${game.id}/state", game.cookieOf(it))) }
    expect(200, get("/sessions/${game.id}/state", game.facilitator))
    expect(403, get("/sessions/${game.id}/state?role=FACTORY", game.cookieOf("RETAILER")))
    expect(422, get("/sessions/${game.id}/state?role=NOBODY", game.cookieOf("RETAILER")))
}

/** 振り返りの経路（B4）: 終了前は 409、終了後は進行役と参加者に 200、資格の無い人は 403。 */
private suspend fun ContractClient.reviewPhase() {
    val game = started()
    expect(409, get("/games/${game.id}/review", game.facilitator))
    expect(409, get("/games/${game.id}/review", game.cookieOf("RETAILER")))
    (1..FINAL_WEEK).forEach { week ->
        ROLES.forEach { role ->
            expect(200, put("/sessions/${game.id}/decisions", """{"week":$week,"quantity":4}""", game.cookieOf(role)))
        }
        expect(200, post("/sessions/${game.id}/weeks/$week/commit", commitBody(week, 1), game.facilitator))
    }
    expect(200, get("/games/${game.id}/review", game.facilitator))
    expect(200, get("/games/${game.id}/review", game.cookieOf("FACTORY")))
    expect(403, get("/games/${game.id}/review"))
}

/**
 * 観察者の経路（B9）: 招待の発行・失効、観察者の参加、観察、観察者の権限。
 * 準備で発行した招待と、その招待で参加した観察者（[PlayedGame.observer]）を使う。
 */
private suspend fun ContractClient.observerPhase() {
    val game = started()
    val invitations = "/games/${game.id}/observer-invitations"
    val observation = "/games/${game.id}/observation"
    val retailer = game.cookieOf("RETAILER")
    val invited = expect(200, post(invitations, "{}", game.facilitator)).body()
    val invitationId = invited.str("invitationId")

    // 発行は進行役だけ。参加は、有効な招待コードだけ（形式の誤りは 422）
    expect(403, post(invitations, "{}", retailer))
    expect(403, post(invitations, "{}", game.observer))
    expect(403, post(invitations, "{}"))
    expect(400, post(invitations, "{ここは JSON ではない", game.facilitator))
    expect(422, post("/participations/observe", """{"displayName":"x"}"""))
    expect(403, post("/participations/observe", """{"invitationCode":"v1.WRONG-CODE","displayName":"x"}"""))
    expect(403, post("/participations/observe", """{"invitationCode":"${game.joinCode}","displayName":"x"}"""))
    val joined =
        expect(
            200,
            post("/participations/observe", """{"invitationCode":"${game.invitationCode}","displayName":"見学"}"""),
        )
    joined.body().str("kind") shouldBe "OBSERVER"
    val observer = checkNotNull(joined.credential()) { "観察者の資格が発行されていない" }

    // 観察は、観察者と進行役だけ。観察者は、役割別の状態・ロビー・入力・確定・進行・招待ができない
    expect(200, get(observation, observer))
    expect(200, get(observation, game.facilitator))
    expect(403, get(observation, retailer))
    expect(403, get(observation))
    expect(403, get("/games/${game.id}/state", observer))
    expect(403, get("/games/${game.id}/lobby", observer))
    expect(403, get("/sessions/${game.id}/state", observer))
    expect(403, put("/sessions/${game.id}/decisions", """{"week":1,"quantity":4}""", observer))
    expect(403, post("/sessions/${game.id}/weeks/1/commit", commitBody(1, 1), observer))
    expect(403, post("/sessions/${game.id}/pause", cookie = observer))
    expect(409, get("/games/${game.id}/review", observer))

    // ロビー（進行役）に、招待と観察者が載る。失効は進行役だけ。失効済みは 409、知らない招待は 404
    val lobby = expect(200, get("/games/${game.id}/lobby", game.facilitator)).body()
    lobby.array("invitations").size shouldBe 2
    lobby.array("observers").size shouldBe 2
    expect(403, post("$invitations/$invitationId/revoke", cookie = observer))
    expect(403, post("$invitations/$invitationId/revoke", cookie = retailer))
    expect(404, post("$invitations/$UNKNOWN_PARTICIPANT/revoke", cookie = game.facilitator))
    expect(200, post("$invitations/$invitationId/revoke", cookie = game.facilitator))
    expect(409, post("$invitations/$invitationId/revoke", cookie = game.facilitator))
    expect(
        403,
        post(
            "/participations/observe",
            """{"invitationCode":"${invited.str("invitationCode")}","displayName":"遅れて"}""",
        ),
    )
    expect(200, get(observation, observer))
}

private const val FINAL_WEEK = 3

/** 確定の根拠にした入力が、確定の前に変わった（409）。古い版の保存は、B1 でどう返っても、仕様の宣言に収まること。 */
private suspend fun ContractClient.changedDecisionsPhase() {
    val game = started()
    val decisions = "/sessions/${game.id}/decisions"
    val retailer = game.cookieOf("RETAILER")
    ROLES.forEach { saveFirst(game, it) }
    expect(200, put(decisions, """{"week":1,"quantity":9}""", retailer, ifMatch = "1"))
    expect(409, post("/sessions/${game.id}/weeks/1/commit", commitBody(1, 1), game.facilitator))
    val stale = put(decisions, """{"week":1,"quantity":7}""", retailer, ifMatch = "0")
    send(stale.method, stale.path, stale.body, stale.cookie, stale.headers)
}

private const val PROXY_BODY = """{"requestedWeek":1,"quantity":4}"""

private fun recover(
    gameId: String,
    code: String? = null,
    recovery: String? = null,
) = Call(
    HttpMethod.Post,
    "/participations/recover",
    """{"gameId":"$gameId"${code?.let { ",\"recoveryCode\":\"$it\"" } ?: ""}}""",
    recovery = recovery,
)

/** 継続と資格の経路（B5）: 停止・再開・代理入力、失効・再発行、復帰の、成功と失敗。 */
private suspend fun ContractClient.continuationPhase() {
    val game = started()
    val retailer = game.players.getValue("RETAILER")
    val session = "/sessions/${game.id}"
    val credentials = "/games/${game.id}/credentials"
    val target = subjectBody(retailer.participantId)
    val unknown = subjectBody(UNKNOWN_PARTICIPANT)

    expect(403, post("$session/pause", cookie = retailer.cookie))
    expect(200, post("$session/pause", cookie = game.facilitator))
    expect(409, post("$session/pause", cookie = game.facilitator))
    expect(409, put("$session/decisions", """{"week":1,"quantity":4}""", retailer.cookie))
    expect(200, put("$session/proxy-decisions/FACTORY", PROXY_BODY, game.facilitator))
    expect(409, put("$session/proxy-decisions/FACTORY", """{"requestedWeek":2,"quantity":4}""", game.facilitator))
    expect(422, put("$session/proxy-decisions/MANAGER", PROXY_BODY, game.facilitator))
    expect(200, post("$session/resume", cookie = game.facilitator))
    expect(409, post("$session/resume", cookie = game.facilitator))
    expect(403, put("$session/commit-mode", """{"commitMode":"AUTO"}""", retailer.cookie))
    expect(422, put("$session/commit-mode", """{"commitMode":"UNKNOWN"}""", game.facilitator))
    expect(200, put("$session/commit-mode", """{"commitMode":"AUTO"}""", game.facilitator))

    expect(409, post("$credentials/reissue", target, game.facilitator))
    expect(403, post("$credentials/revoke", target, retailer.cookie))
    expect(404, post("$credentials/revoke", unknown, game.facilitator))
    expect(
        422,
        post("$credentials/revoke", """{"subject":{"kind":"FACILITATOR","id":"${game.id}"}}""", game.facilitator),
    )
    expect(200, post("$credentials/revoke", target, game.facilitator))
    expect(409, post("$credentials/revoke", target, game.facilitator))
    val code = expect(200, post("$credentials/reissue", target, game.facilitator)).body().str("recoveryCode")

    expect(422, post("/participations/recover", "{}"))
    expect(403, recover(game.id, recovery = retailer.recovery))
    expect(200, recover(game.id, code = code))
    expect(200, recover(game.id, recovery = game.players.getValue("FACTORY").recovery))
    expect(200, recover(game.id, code = game.facilitatorCode))
}

/** 全体の守りを調べる: [requests] を [status] で返す応答が、すべて仕様に適合すること。違反（と、状態の違い）の一覧を返す。 */
private suspend fun ContractClient.violationsOf(
    requests: List<OperationRequest>,
    status: Int,
    bodyOf: (OperationRequest) -> String? = { it.body },
): List<String> =
    requests.flatMap { r ->
        val observed = observe(r.method, r.path, sendRaw(r.method, r.path, bodyOf(r), r.cookie))
        val found =
            if (observed.status == status) {
                DOC.responseViolations(observed)
            } else {
                listOf("${observed.status}（$status でない）")
            }
        found.map { "${r.operationId}: $it" }
    }

class ApiContractSpec :
    FunSpec({
        test("[仕様の構造] 変更系の操作は Idempotency-Key を必須とし、If-Match は SaveDecision だけが宣言する") {
            val commands = DOC.operations.filter { it.method in setOf("POST", "PUT") }
            val queries = DOC.operations.filter { it.method == "GET" }

            commands.filter { !DOC.requiresHeader(it, IDEMPOTENCY_KEY) }.map { it.id }.shouldBeEmpty()
            queries.filter { DOC.declaresHeader(it, IDEMPOTENCY_KEY) }.map { it.id }.shouldBeEmpty()
            DOC.operations.filter { DOC.declaresHeader(it, "If-Match") }.map { it.id } shouldBe listOf("saveDecision")
            DOC.operations
                .map { it.id }
                .toSet()
                .size shouldBe DOC.operations.size
        }

        test("[応答の適合] 全経路を通して、成功の応答と problem+json が、仕様のスキーマ・状態・ヘッダーに適合する") {
            withContract { c, _ ->
                val game = c.preparingPhase()
                c.startPhase(game)
                c.playPhase(game)
                c.changedDecisionsPhase()
                c.reviewPhase()
                c.observerPhase()
                c.continuationPhase()
                // 経路・メソッドの違い（仕様に無い経路は、request.* の problem+json）と、運用の確認
                c.expect(404, get("/no-such-route"))
                c.expect(405, Call(HttpMethod.Delete, "/games"))
                c.expect(200, get("/health"))
                c.expect(200, get("/ready"))

                val successes =
                    c
                        .observed()
                        .filter { it.substringAfter(' ').startsWith("2") }
                        .map { it.substringBefore(' ') }
                withClue("仕様のすべての操作で、成功の応答を観測した（観測: ${c.observed().sorted()}）") {
                    successes shouldContainExactlyInAnyOrder DOC.operations.map { it.id }
                }
            }
        }

        test("[応答の適合] 通知の受信が止まっていれば、/ready は 503 の problem+json（NotReadyProblem）で、仕様に適合する") {
            val dead = { ports: Ports ->
                Ports(
                    ports.generators,
                    ports.stores,
                    ports.lock,
                    ports.notifier.copy(isAlive = { false }),
                    ports.settings,
                )
            }
            withContract(World(wrap = dead)) { c, _ ->
                val ready = c.expect(503, get("/ready"))

                ready.body().str("type") shouldBe "/problems/app.not_ready"
            }
        }

        test("[全体の守り] 429（レート制限）は、仕様のすべての操作に宣言されている") {
            withContract(World(rateLimitPerMinute = 1)) { c, _ ->
                val placeholder = placeholderGame()
                // 1 回目で上限に達し、以降の要求は、経路に入る前に 429 になる
                c.sendRaw(HttpMethod.Get, "/games/${placeholder.id}/state", cookie = "placeholder", key = null)

                c.violationsOf(operationRequests(placeholder), 429).shouldBeEmpty()
            }
        }

        test("[全体の守り] 413（本文が 64 KB を超える）は、本文を受ける変更系のすべての操作に宣言されている") {
            withContract { c, _ ->
                val oversized = """{"padding":"${"x".repeat(70_000)}"}"""
                val requests = operationRequests(placeholderGame()).filter { it.method != HttpMethod.Get }

                c.violationsOf(requests, 413) { oversized }.shouldBeEmpty()
            }
        }

        test("[全体の守り] 予期しない失敗の 500 は、仕様のすべての操作に宣言されている") {
            val broken = AtomicBoolean(false)
            withContract(World(wrap = { ports -> throwingPorts(ports, broken) })) { c, _ ->
                val game = c.prepared()
                broken.set(true)

                c.violationsOf(operationRequests(game), 500).shouldBeEmpty()
            }
        }

        test("[全体の守り] 再試行の上限の 503 は、追記する変更系のすべての操作に宣言されている") {
            val broken = AtomicBoolean(false)
            withContract(World(maxAttempts = 2, wrap = { ports -> conflictingPorts(ports, broken) })) { c, _ ->
                // 追記まで届く要求にするため、操作ごとに、その操作が受け付ける状態のゲームを用意する
                val prepared = c.prepared()
                val started = c.started()
                val decided = c.started().also { game -> ROLES.forEach { c.saveFirst(game, it) } }
                // 停止中でなければ再開は追記まで届かず、失効していなければ再発行は追記まで届かない
                val paused =
                    c.started().also { game ->
                        c.expect(200, post("/sessions/${game.id}/pause", cookie = game.facilitator))
                    }
                val revoked =
                    c.started().also { game ->
                        val subject = subjectBody(game.players.getValue("RETAILER").participantId)
                        c.expect(200, post("/games/${game.id}/credentials/revoke", subject, game.facilitator))
                    }
                broken.set(true)
                val needsState =
                    setOf(
                        "saveDecision",
                        "commitWeek",
                        "pauseSession",
                        "resumeSession",
                        "setCommitMode",
                        "submitProxyDecision",
                        "reissueCredential",
                    )
                val requests =
                    operationRequests(prepared).filter { it.operationId !in needsState } +
                        operationRequests(started).filter {
                            it.operationId in
                                setOf("saveDecision", "pauseSession", "setCommitMode", "submitProxyDecision")
                        } +
                        operationRequests(decided).filter { it.operationId == "commitWeek" } +
                        operationRequests(paused).filter { it.operationId == "resumeSession" } +
                        operationRequests(revoked).filter { it.operationId == "reissueCredential" }

                c.violationsOf(requests.filter { it.method != HttpMethod.Get }, 503).shouldBeEmpty()
            }
        }

        test("[全体の守り] 要求の表（OperationRequest）は、仕様の操作（探針を除く）をすべて含む") {
            operationRequests(placeholderGame()).map { it.operationId } shouldContainExactlyInAnyOrder
                DOC.operations.map { it.id }.filter { it !in PROBES }
        }

        test("[検査の検査] 適合の検査は、仕様に反する応答を、違反として見つける（常に緑ではない）") {
            val code = "app.unauthorized"
            val problem = """{"type":"/problems/$code","title":"t","status":403,"code":"$code","correlationId":"c"}"""
            val goodHeaders =
                mapOf(
                    "content-type" to listOf("application/problem+json"),
                    "x-correlation-id" to listOf("c"),
                )
            val goodPath = "/games/00000000-0000-0000-0000-000000000001/state"

            fun violations(
                status: Int = 403,
                headers: Map<String, List<String>> = goodHeaders,
                body: String = problem,
                path: String = goodPath,
            ) = DOC.responseViolations(ObservedResponse("GET", path, status, headers, body))

            violations().shouldBeEmpty()
            withClue("仕様に無い code") { violations(body = problem.replace(code, "app.made_up")).isEmpty() shouldBe false }
            withClue("必須の項目が無い") {
                violations(body = problem.replace(",\"correlationId\":\"c\"", "")).isEmpty() shouldBe false
            }
            withClue("仕様に無い項目が増えた") {
                violations(body = problem.replace("\"code\"", "\"leak\":\"x\",\"code\"")).isEmpty() shouldBe false
            }
            withClue("宣言されていない状態") { violations(status = 418).isEmpty() shouldBe false }
            withClue("Content-Type の違い") {
                val json = mapOf("content-type" to listOf("application/json"), "x-correlation-id" to listOf("c"))
                violations(headers = json).isEmpty() shouldBe false
            }
            withClue("宣言されたヘッダーが無い") {
                val noCorrelation = mapOf("content-type" to listOf("application/problem+json"))
                violations(headers = noCorrelation).isEmpty() shouldBe false
            }
            withClue("仕様に無い経路の 404 は、request.not_found の problem でなければならない") {
                violations(status = 404, path = "/nowhere").isEmpty() shouldBe false
            }
        }

        test("[リクエストの適合] 仕様の要求スキーマの判定と、実装の受理・拒否が、事例ごとの期待と一致する") {
            withContract { c, _ ->
                val prepared = c.prepared()
                val started = c.started()
                ROLES.filter { it != "FACTORY" }.forEach { c.saveFirst(started, it) }

                val mismatches = requestCases(prepared, started).mapNotNull { c.mismatchOf(it) }

                mismatches.shouldBeEmpty()
            }
        }

        test("[リクエストの適合] 変更系の操作は、Idempotency-Key が無ければ拒否する") {
            withContract { c, _ ->
                val game = c.prepared()
                val accepted =
                    operationRequests(game).filter { it.method != HttpMethod.Get }.mapNotNull { r ->
                        val response = c.sendRaw(r.method, r.path, r.body, r.cookie, key = null)
                        val rejected = response.status.value == 400 || response.status.value == 422
                        if (rejected && response.body().str("code") == "validation.invalid_input") {
                            null
                        } else {
                            "${r.operationId}: ${response.status.value}"
                        }
                    }

                accepted.shouldBeEmpty()
            }
        }

        test("[エラー code の一致] 仕様の ErrorCode と、実装が返す code の全体は、欠けても余っても失敗する") {
            val domain = ErrorCodeInventory.domainCodes(domainSources())
            val implemented = ErrorCodeInventory.domainCodesReturned(domainSources()) + ErrorCodeInventory.httpCodes()

            (domain.size >= 12) shouldBe true
            domain.keys shouldContain "session.week_advanced"
            // 分類が Forbidden の業務の誤りは、参加コードの失敗を除いて、利用者へ返らない（app.unauthorized に写る）
            domain
                .filterValues { it == "Forbidden" }
                .keys
                .filter { it != "game.invitation_invalid" }
                .forEach { DOC.errorCodes.contains(it) shouldBe false }
            val missing = DOC.errorCodes - implemented
            val extra = implemented - DOC.errorCodes
            withClue("仕様にあって実装に無い code: $missing、実装にあって仕様に無い code: $extra") {
                DOC.errorCodes shouldBe implemented
            }
        }

        test("[ルートの網羅] 実装のルートはすべて仕様にあり、仕様のルートはすべて実装にある") {
            val implemented = implementedRoutes().map { it.replaceFirst(" ${DOC.basePath}/", " /") }.toSet()
            val specified = DOC.operations.map { "${it.method} ${it.template}" }.toSet()

            withClue("実装にあって仕様に無い: ${implemented - specified}、仕様にあって実装に無い: ${specified - implemented}") {
                implemented shouldBe specified
            }
        }
    })

/** 事例の期待と食い違えば、その説明（食い違いが無ければ null）。 */
private suspend fun ContractClient.mismatchOf(case: RequestCase): String? {
    val target = case.target
    val body = checkNotNull(target.body)
    val specValid = DOC.requestBodyViolations(DOC.operation(case.operationId), body).isEmpty()
    val response = sendRaw(target.method, target.path, body, target.cookie)
    val accepted = response.status.value in 200..299
    val code = if (accepted) null else response.body().str("code")
    return when {
        specValid != case.expectation.specValid -> {
            "${case.label}: 仕様の判定が $specValid（期待 ${case.expectation.specValid}）"
        }

        accepted != case.expectation.accepted -> {
            "${case.label}: 実装が ${response.status.value}（受理 ${case.expectation.accepted} を期待）"
        }

        !accepted && code != "validation.invalid_input" -> {
            "${case.label}: code=$code"
        }

        else -> {
            null
        }
    }
}
