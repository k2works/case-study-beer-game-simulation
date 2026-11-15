package beergame.app

import arrow.core.left
import beergame.application.AppFailure
import beergame.application.AttemptPolicy
import beergame.application.PeripheralWrite
import beergame.application.Ports
import beergame.domain.CredentialSubject
import beergame.domain.GameId
import beergame.domain.ParticipantId
import io.kotest.core.spec.style.FunSpec
import io.kotest.matchers.collections.shouldContain
import io.kotest.matchers.shouldBe
import io.kotest.matchers.string.shouldContain
import io.kotest.matchers.string.shouldNotContain
import io.ktor.client.HttpClient
import io.ktor.client.request.header
import io.ktor.client.statement.HttpResponse
import io.ktor.client.statement.bodyAsText
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpMethod
import io.ktor.http.HttpStatusCode
import io.ktor.server.testing.ApplicationTestBuilder
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.time.Duration
import java.time.Instant
import java.util.UUID
import java.util.concurrent.atomic.AtomicBoolean

/*
 * 実物の永続化（H2）を通す、HTTP の試験。業務の網羅は domain と application の試験が持つので、
 * ここは「境界」（認証・認可、検証、写像、応答の形、ログ、準備の確認）を確かめる。
 */

private const val DEMAND = "[4,999,998]"
private val ROLE_NAMES =
    mapOf(
        "FACTORY" to "工場の花子",
        "DISTRIBUTOR" to "一次卸の次郎",
        "WHOLESALER" to "二次卸の三郎",
        "RETAILER" to "小売の四郎",
    )
private val ROLES = ROLE_NAMES.keys.toList()

private class Player(
    val role: String,
    val name: String,
    val cookie: String,
    val participantId: String,
)

private class Game(
    val id: String,
    val facilitator: String,
    val joinCode: String,
    val players: Map<String, Player>,
)

/**
 * 参加者の資格を失効させる。HTTP に失効の経路が無い（Step 6）ので、失効のイベントに付く書き込み（復帰資格の失効と、
 * ブラウザセッションの削除）を、周辺ストアへ直接書く（`credentials` だけの更新では、ブラウザセッションは止まらない）。
 */
private fun World.revokeParticipant(
    game: Game,
    role: String,
) {
    val subject =
        CredentialSubject.Participant(ParticipantId(UUID.fromString(game.players.getValue(role).participantId)))
    val write = PeripheralWrite.RevokeSubject(GameId(UUID.fromString(game.id)), subject, Instant.now())
    runBlocking { persistence.events.transaction { tx -> persistence.peripheral.write(tx, listOf(write)) } }
}

private suspend fun HttpClient.createGame(
    key: String = "create-1",
    body: String = """{"kind":"KIT","finalWeek":3,"demand":$DEMAND}""",
): HttpResponse = call(HttpMethod.Post, "/games", body, key = key)

/** 作成 → 4 人が参加 → 割り当て → （開始はしない）。 */
private suspend fun ApplicationTestBuilder.prepared(tag: String): Game {
    val created = client.createGame(key = "create-$tag")
    val facilitator = created.credential() ?: error("進行役の資格が発行されていない")
    val id = created.location().removePrefix("$API/games/").removeSuffix("/state")
    val joinCode = client.call(HttpMethod.Get, "/games/$id/state", cookie = facilitator).body().str("joinCode")
    val cookies =
        ROLES.associateWith { role ->
            client
                .call(
                    HttpMethod.Post,
                    "/participations/join",
                    """{"joinCode":"$joinCode","displayName":"${ROLE_NAMES.getValue(role)}"}""",
                    key = "join-$tag-$role",
                ).credential() ?: error("参加者の資格が発行されていない")
        }
    val lobby = client.call(HttpMethod.Get, "/games/$id/lobby", cookie = facilitator).body().array("participants")
    val players =
        ROLES.associateWith { role ->
            val participantId =
                lobby
                    .map { it.jsonObject }
                    .first {
                        it.str(
                            "displayName",
                        ) == ROLE_NAMES.getValue(role)
                    }.str("participantId")
            Player(role, ROLE_NAMES.getValue(role), cookies.getValue(role), participantId)
        }
    ROLES.forEach { role ->
        val response =
            client.call(
                HttpMethod.Put,
                "/games/$id/participants/${players.getValue(role).participantId}/role",
                """{"role":"$role"}""",
                cookie = facilitator,
                key = "assign-$tag-$role",
            )
        response.status shouldBe HttpStatusCode.OK
    }
    return Game(id, facilitator, joinCode, players)
}

private suspend fun ApplicationTestBuilder.started(tag: String): Game {
    val game = prepared(tag)
    client
        .call(
            HttpMethod.Post,
            "/games/${game.id}/start",
            cookie = game.facilitator,
            key = "start-$tag",
        ).status shouldBe
        HttpStatusCode.OK
    return game
}

private suspend fun ApplicationTestBuilder.save(
    game: Game,
    role: String,
    quantity: Int,
    key: String,
    ifMatch: String? = null,
): HttpResponse =
    client.callWith(HttpMethod.Put, "/sessions/${game.id}/decisions", """{"week":1,"quantity":$quantity}""") {
        header("Idempotency-Key", key)
        header("Cookie", "bg_session=${game.players.getValue(role).cookie}")
        ifMatch?.let { header(HttpHeaders.IfMatch, it) }
    }

private suspend fun ApplicationTestBuilder.commit(
    game: Game,
    key: String,
    versions: Int = 1,
): HttpResponse {
    val basis = ROLES.joinToString(",") { "\"$it\":$versions" }
    return client.call(
        HttpMethod.Post,
        "/sessions/${game.id}/weeks/1/commit",
        """{"requestedWeek":1,"basis":{$basis}}""",
        cookie = game.facilitator,
        key = key,
    )
}

private suspend fun ApplicationTestBuilder.playWeekOne(game: Game) {
    ROLES.forEach { save(game, it, 4, "save-${game.id}-$it").status shouldBe HttpStatusCode.OK }
    commit(game, "commit-${game.id}").status shouldBe HttpStatusCode.OK
}

private suspend fun ApplicationTestBuilder.state(
    game: Game,
    cookie: String?,
    query: String = "",
): HttpResponse = client.call(HttpMethod.Get, "/sessions/${game.id}/state$query", cookie = cookie)

class HttpFlowSpec :
    FunSpec({
        test("[US2.3/AC2.3.1] ウォーキングスケルトン: 作成・参加・割り当て・開始・入力・確定・表示が、HTTP で通る") {
            withWorld {
                val game = started("skeleton")
                ROLES.forEach { role ->
                    val saved = save(game, role, 4, "save-$role")
                    saved.status shouldBe HttpStatusCode.OK
                    saved.body().keys shouldBe setOf("versions")
                }

                val committed = commit(game, "commit-1")

                committed.status shouldBe HttpStatusCode.OK
                committed.body().keys shouldBe setOf("versions")
                val facilitator = state(game, game.facilitator).body()
                facilitator.str("week") shouldBe "2"
                facilitator.str("status") shouldBe "ACTIVE"
                facilitator.array("results").size shouldBe 4
                val retailer = state(game, game.players.getValue("RETAILER").cookie).body()
                retailer.str("week") shouldBe "2"
                retailer.str("role") shouldBe "RETAILER"
            }
        }

        test("[US1.1/AC1.1.1] 作成: 201、Location、資格の Cookie（HttpOnly・SameSite=Strict）。応答は versions だけ（資格の値を含めない）") {
            withWorld {
                val response = client.createGame()

                response.status shouldBe HttpStatusCode.Created
                val body = response.body()
                body.keys shouldBe setOf("versions")
                body.obj("versions").str("game") shouldBe "1"
                body.obj("versions")["session"] shouldBe JsonNull
                response.location() shouldContain "/api/v1/games/"
                val cookie = checkNotNull(response.headers.getAll("Set-Cookie")).single { it.startsWith("bg_session=") }
                cookie shouldContain "HttpOnly"
                cookie shouldContain "SameSite=Strict"
                cookie shouldContain "Path=/"
                cookie shouldContain "Max-Age="
                cookie shouldNotContain "Secure"
                // Ktor の内部の符号化の印（$x-enc）を、利用者へ出さない
                cookie shouldNotContain "\$x-enc"
                response.bodyAsText() shouldNotContain response.requireCredential()
            }
        }

        test("[US1.1/AC1.1.1] 作成の再送（同じ Idempotency-Key・同じ本文）: 同じゲームと資格を返し、ゲームは 1 つのまま") {
            withWorld { world ->
                val first = client.createGame(key = "same-key")
                val second = client.createGame(key = "same-key")

                second.status shouldBe HttpStatusCode.Created
                second.headers[HttpHeaders.Location] shouldBe first.headers[HttpHeaders.Location]
                second.credential() shouldBe first.credential()
                world.countGames() shouldBe 1
            }
        }

        test("[NF] 同じ Idempotency-Key で本文が違う要求: 409 の app.idempotency_key_reused（type つき）") {
            withWorld {
                client.createGame(key = "k").status shouldBe HttpStatusCode.Created

                val reused = client.createGame(key = "k", body = """{"kind":"KIT","finalWeek":2,"demand":[1,2]}""")

                reused.status shouldBe HttpStatusCode.Conflict
                reused.body().str("type") shouldBe "/problems/app.idempotency_key_reused"
            }
        }

        test("[US1.1/AC1.1.2] 需要が範囲外（第 5 週が 1001）: 422 で作成せず、対象の週と修正内容を示す") {
            withWorld { world ->
                val response =
                    client.createGame(
                        body = """{"kind":"KIT","finalWeek":12,"demand":[4,4,4,4,1001,4,4,4,4,4,4,4]}""",
                    )

                response.status shouldBe HttpStatusCode.UnprocessableEntity
                val errors = response.body().array("errors").map { it.jsonObject }
                errors.size shouldBe 1
                errors.single().str("field") shouldBe "demand"
                errors.single().str("week") shouldBe "5"
                errors.single().str("message") shouldBe "需要は 0〜1000 の整数"
                world.countGames() shouldBe 0
            }
        }

        test("[US1.2/AC1.2.2] 無効な参加コード: 403 の game.invitation_invalid（存在する・しないを区別しない）") {
            withWorld {
                val game = prepared("join")

                val unknown =
                    client.call(
                        HttpMethod.Post,
                        "/participations/join",
                        """{"joinCode":"ZZZZZZZZZZZZ","displayName":"田中"}""",
                        key = "j1",
                    )
                val malformed =
                    client.call(
                        HttpMethod.Post,
                        "/participations/join",
                        """{"joinCode":"short","displayName":"田中"}""",
                        key = "j2",
                    )

                listOf(unknown, malformed).forEach {
                    it.status shouldBe HttpStatusCode.Forbidden
                    it.body().str("code") shouldBe "game.invitation_invalid"
                }
                unknown.problemWithoutCorrelation() shouldBe malformed.problemWithoutCorrelation()
                game.joinCode.length shouldBe 12
            }
        }

        test(
            "[5.1][NF-S11] 参加の総当たり: 失敗が上限（3 回）の接続元は、正しい参加コードでも 429（Retry-After つき）。" +
                "成功は数えず、窓が過ぎると参加できる",
        ) {
            val attempts = AttemptPolicy.of(3, Duration.ofMinutes(10)).getOrNull() ?: error("窓の設定が不正")
            withWorld(World(attempts = attempts)) { world ->
                val created = client.createGame(key = "c-limit")
                val facilitator = created.requireCredential()
                val id = created.location().removePrefix("$API/games/").removeSuffix("/state")
                val code = client.call(HttpMethod.Get, "/games/$id/state", cookie = facilitator).body().str("joinCode")

                suspend fun join(
                    joinCode: String,
                    key: String,
                ) = client.call(
                    HttpMethod.Post,
                    "/participations/join",
                    """{"joinCode":"$joinCode","displayName":"田中"}""",
                    key = key,
                )

                // 成功は、上限を超えて繰り返しても数えない
                repeat(5) { join(code, "ok-$it").status shouldBe HttpStatusCode.OK }
                // 失敗（不明な参加コード）は 3 回まで 403。形式が不正な本文は数えない
                repeat(3) { join("ZZZZZZZZZZZ$it", "bad-$it").status shouldBe HttpStatusCode.Forbidden }
                client.call(HttpMethod.Post, "/participations/join", "{}", key = "malformed").status shouldBe
                    HttpStatusCode.UnprocessableEntity

                val blocked = join(code, "blocked")

                blocked.status shouldBe HttpStatusCode.TooManyRequests
                blocked.body().str("code") shouldBe "app.rate_limited"
                blocked.headers[HttpHeaders.RetryAfter] shouldBe "600"
                world.clock.advance(600)
                join(code, "after-window").status shouldBe HttpStatusCode.OK
            }
        }

        test("[US1.2/AC1.2.2] 受付が終了したゲーム（開始済み）への参加: 409 の game.not_preparing（理由を示す。参加者は増えない）") {
            withWorld {
                val game = started("late")

                val late =
                    client.call(
                        HttpMethod.Post,
                        "/participations/join",
                        """{"joinCode":"${game.joinCode}","displayName":"山本"}""",
                        key = "late-join",
                    )

                late.status shouldBe HttpStatusCode.Conflict
                late.body().str("code") shouldBe "game.not_preparing"
                late.credential() shouldBe null
            }
        }

        test("[US1.2/AC1.2.3] 4 役割がそろわない開始: 422 の game.start_condition_not_met で、不足する役割を示す。開始されない") {
            withWorld {
                val created = client.createGame(key = "c3")
                val facilitator = created.requireCredential()
                val id = created.location().removePrefix("$API/games/").removeSuffix("/state")

                val response = client.call(HttpMethod.Post, "/games/$id/start", cookie = facilitator, key = "s3")

                response.status shouldBe HttpStatusCode.UnprocessableEntity
                response.body().str("code") shouldBe "game.start_condition_not_met"
                response.body().array("missingRoles").map { it.jsonPrimitive.content } shouldBe
                    listOf("FACTORY", "DISTRIBUTOR", "WHOLESALER", "RETAILER")
                client.call(HttpMethod.Get, "/games/$id/state", cookie = facilitator).body().str("status") shouldBe
                    "PREPARING"
            }
        }

        test("[US1.2/AC1.2.5] 割り当て: すでに別の役割にいる参加者を割り当て直すと、移る（200）。存在しない参加者は 404") {
            withWorld {
                val game = prepared("move")
                val retailer = game.players.getValue("RETAILER")

                val moved =
                    client.call(
                        HttpMethod.Put,
                        "/games/${game.id}/participants/${retailer.participantId}/role",
                        """{"role":"WHOLESALER"}""",
                        cookie = game.facilitator,
                        key = "move-1",
                    )
                val missing =
                    client.call(
                        HttpMethod.Put,
                        "/games/${game.id}/participants/00000000-0000-0000-0000-000000000009/role",
                        """{"role":"WHOLESALER"}""",
                        cookie = game.facilitator,
                        key = "move-2",
                    )

                moved.status shouldBe HttpStatusCode.OK
                moved.body().keys shouldBe setOf("versions")
                missing.status shouldBe HttpStatusCode.NotFound
                missing.body().str("code") shouldBe "game.participant_not_found"
            }
        }

        test("[US2.3] 二重の開始: 409 の session.already_started") {
            withWorld {
                val game = started("twice")

                val again =
                    client.call(
                        HttpMethod.Post,
                        "/games/${game.id}/start",
                        cookie = game.facilitator,
                        key = "start-again",
                    )

                again.status shouldBe HttpStatusCode.Conflict
                again.body().str("code") shouldBe "session.already_started"
            }
        }

        test("[US2.1/AC2.1.2] 無効な資格はすべて同じ 403 の本文: なし・偽造・別のゲーム・存在しないゲーム・権限なし（参加者が進行役の操作、進行役が入力）") {
            withWorld {
                val game = started("auth")
                val other = started("auth-other")
                val forged = "A".repeat(43)
                val retailer = game.players.getValue("RETAILER").cookie

                val responses =
                    listOf(
                        state(game, null),
                        state(game, forged),
                        state(game, other.facilitator),
                        state(game, other.players.getValue("RETAILER").cookie),
                        client.call(
                            HttpMethod.Get,
                            "/sessions/00000000-0000-0000-0000-000000000001/state",
                            cookie = game.facilitator,
                        ),
                        client.call(HttpMethod.Post, "/games/${game.id}/start", cookie = retailer, key = "k-1"),
                        client.call(HttpMethod.Post, "/games/${game.id}/start", cookie = null, key = "k-2"),
                        client.call(HttpMethod.Post, "/games/${game.id}/start", cookie = forged, key = "k-3"),
                        client.call(
                            HttpMethod.Put,
                            "/sessions/${game.id}/decisions",
                            """{"week":1,"quantity":4}""",
                            cookie = game.facilitator,
                            key = "k-5",
                        ),
                        client.call(HttpMethod.Get, "/games/${game.id}/lobby", cookie = retailer),
                        client.call(
                            HttpMethod.Post,
                            "/sessions/${game.id}/weeks/1/commit",
                            """{"requestedWeek":1,"basis":{"FACTORY":0,"DISTRIBUTOR":0,"WHOLESALER":0,"RETAILER":0}}""",
                            cookie = retailer,
                            key = "k-6",
                        ),
                    )

                responses.forEach { it.status shouldBe HttpStatusCode.Forbidden }
                responses.map { it.problemWithoutCorrelation() }.toSet().size shouldBe 1
                responses.first().body().str("code") shouldBe "app.unauthorized"
                responses.map { it.headers[HttpHeaders.ContentType] }.toSet().size shouldBe 1
            }
        }

        test("[US2.1/AC2.1.2] 失効した資格・期限切れ（ブラウザセッション 24 時間）の資格: 403（再送でも）。期限内の進行役は有効") {
            withWorld { world ->
                val revoked = started("revoked")
                val expiring = started("expiring")
                save(revoked, "RETAILER", 4, "before-revoke").status shouldBe HttpStatusCode.OK
                save(expiring, "RETAILER", 4, "before-expiry").status shouldBe HttpStatusCode.OK
                // 参加者の資格だけを、失効のコマンドと同じ書き込み（復帰資格の失効とブラウザセッションの削除）で失効させる。
                // 進行役の資格の主体はゲームの ID
                world.revokeParticipant(revoked, "RETAILER")

                state(revoked, revoked.players.getValue("RETAILER").cookie).status shouldBe HttpStatusCode.Forbidden
                save(revoked, "RETAILER", 4, "before-revoke").status shouldBe HttpStatusCode.Forbidden
                state(revoked, revoked.facilitator).status shouldBe HttpStatusCode.OK
                state(expiring, expiring.players.getValue("RETAILER").cookie).status shouldBe HttpStatusCode.OK

                world.clock.advance(25L * 3600)

                state(expiring, expiring.players.getValue("RETAILER").cookie).status shouldBe HttpStatusCode.Forbidden
                state(expiring, expiring.facilitator).status shouldBe HttpStatusCode.Forbidden
                // 失効・期限切れの資格では、過去に成功した要求の再送（同じキー）も 403
                save(expiring, "RETAILER", 4, "before-expiry").status shouldBe HttpStatusCode.Forbidden
            }
        }

        test("[US2.1/AC2.1.1] 参加者は自分の役割の値だけを見る（他の役割・参加コード・他の参加者の表示名・将来の需要を含まない）") {
            withWorld {
                val game = started("disclosure")
                playWeekOne(game)

                val wholesaler = state(game, game.players.getValue("WHOLESALER").cookie).bodyAsText()

                listOf("FACTORY", "DISTRIBUTOR", "RETAILER").forEach { role ->
                    wholesaler shouldNotContain ROLE_NAMES.getValue(role)
                }
                wholesaler shouldNotContain game.joinCode
                wholesaler shouldNotContain "998"
                wholesaler shouldNotContain "roles"
                json(wholesaler).obj("roleStatus").containsKey("customerDemand") shouldBe false
            }
        }

        test("[US2.1/AC2.1.3] 小売店だけが当週の顧客需要を見る。将来の需要は、誰にも返らない") {
            withWorld {
                val game = started("demand")
                playWeekOne(game)

                val retailer = state(game, game.players.getValue("RETAILER").cookie)
                val facilitator = state(game, game.facilitator).bodyAsText()

                retailer.body().obj("roleStatus").str("customerDemand") shouldBe "999"
                retailer.bodyAsText() shouldNotContain "998"
                facilitator shouldNotContain "998"
            }
        }

        test("[US2.1/AC2.1.2] 他の役割の状況を取得しようとする（?role=）: 403 で、値を返さない。自分の役割なら取得できる") {
            withWorld {
                val game = started("other-role")
                val retailer = game.players.getValue("RETAILER").cookie

                val other = state(game, retailer, "?role=FACTORY")
                val own = state(game, retailer, "?role=RETAILER")
                val invalid = state(game, retailer, "?role=MANAGER")

                other.status shouldBe HttpStatusCode.Forbidden
                other.body().str("code") shouldBe "app.unauthorized"
                other.bodyAsText() shouldNotContain "inventory"
                own.status shouldBe HttpStatusCode.OK
                invalid.status shouldBe HttpStatusCode.UnprocessableEntity
            }
        }

        test("[US2.2/AC2.2.2] 数量の誤り: 範囲外（-1・1001）は 422 の quantity、小数・空は形の誤りで 422。保存されない") {
            withWorld {
                val game = started("quantity")
                val cookie = game.players.getValue("RETAILER").cookie

                val bodies = listOf("-1", "1001", "1.5", "\"\"", "null")
                val responses =
                    bodies.mapIndexed { i, quantity ->
                        client.call(
                            HttpMethod.Put,
                            "/sessions/${game.id}/decisions",
                            """{"week":1,"quantity":$quantity}""",
                            cookie = cookie,
                            key = "q-$i",
                        )
                    }

                responses.forEach {
                    it.status shouldBe HttpStatusCode.UnprocessableEntity
                    it.body().str("code") shouldBe "validation.invalid_input"
                    it
                        .body()
                        .array("errors")
                        .single()
                        .jsonObject
                        .str("field") shouldBe "quantity"
                }
                state(game, cookie).body().obj("roleStatus")["decision"] shouldBe JsonNull
            }
        }

        test("[US2.2/AC2.2.1] 入力の保存: 流通役は発注、工場は生産要請として保存される。保存した値が自分の状態に出る") {
            withWorld {
                val game = started("save")

                save(game, "DISTRIBUTOR", 8, "s-d").status shouldBe HttpStatusCode.OK
                save(game, "FACTORY", 6, "s-f").status shouldBe HttpStatusCode.OK

                state(
                    game,
                    game.players.getValue("DISTRIBUTOR").cookie,
                ).body().obj("roleStatus").str("decision") shouldBe
                    "8"
                state(game, game.players.getValue("FACTORY").cookie).body().obj("roleStatus").str("decision") shouldBe
                    "6"
            }
        }

        test("[US2.2] 入力の保存の再送（同じキー）: 同じ応答で、二重に保存されない。If-Match は意思決定の版") {
            withWorld {
                val game = started("resend")
                val first = save(game, "RETAILER", 5, "same")
                val second = save(game, "RETAILER", 5, "same")

                second.status shouldBe HttpStatusCode.OK
                second.body() shouldBe first.body()
                val version =
                    state(
                        game,
                        game.players.getValue("RETAILER").cookie,
                    ).body().obj("roleStatus").str("decisionVersion")
                version shouldBe "1"
                save(game, "RETAILER", 6, "next", ifMatch = "\"1\"").status shouldBe HttpStatusCode.OK
                state(
                    game,
                    game.players.getValue("RETAILER").cookie,
                ).body().obj("roleStatus").str("decisionVersion") shouldBe
                    "2"
            }
        }

        test("[US2.3] 入力がそろわない週の確定: 422 の session.incomplete_decisions で、不足する役割を示す。週は進まない") {
            withWorld {
                val game = started("incomplete")
                save(game, "RETAILER", 4, "i-r")

                // 小売店の入力の版は 1（保存済み）。ほかの 3 役割は未入力（版 0）
                val response =
                    client.call(
                        HttpMethod.Post,
                        "/sessions/${game.id}/weeks/1/commit",
                        """{"requestedWeek":1,"basis":{"FACTORY":0,"DISTRIBUTOR":0,"WHOLESALER":0,"RETAILER":1}}""",
                        cookie = game.facilitator,
                        key = "commit-i",
                    )

                response.status shouldBe HttpStatusCode.UnprocessableEntity
                response.body().str("code") shouldBe "session.incomplete_decisions"
                response.body().array("missingRoles").map { it.jsonPrimitive.content } shouldBe
                    listOf("FACTORY", "DISTRIBUTOR", "WHOLESALER")
                state(game, game.facilitator).body().str("week") shouldBe "1"
            }
        }

        test("[US2.3/AC2.3.2] 確定済みの週を別のキーで確定: 409 の session.week_advanced（結果は一度だけ）") {
            withWorld {
                val game = started("advanced")
                playWeekOne(game)

                val again = commit(game, "commit-again")

                again.status shouldBe HttpStatusCode.Conflict
                again.body().str("code") shouldBe "session.week_advanced"
                state(game, game.facilitator).body().array("results").size shouldBe 4
            }
        }

        test("[US2.3/AC2.3.2] 確定の再送（同じキー）: 同じ応答で、結果は 4 件のまま") {
            withWorld {
                val game = started("commit-resend")
                ROLES.forEach { save(game, it, 4, "save-$it").status shouldBe HttpStatusCode.OK }
                val first = commit(game, "commit-same")

                val second = commit(game, "commit-same")

                second.status shouldBe HttpStatusCode.OK
                second.body() shouldBe first.body()
                state(game, game.facilitator).body().array("results").size shouldBe 4
            }
        }

        test("[US2.3] 経路の週と本文の requestedWeek が違う確定: 422 で拒否") {
            withWorld {
                val game = started("mismatch")

                val response =
                    client.call(
                        HttpMethod.Post,
                        "/sessions/${game.id}/weeks/2/commit",
                        """{"requestedWeek":1,"basis":{"FACTORY":0,"DISTRIBUTOR":0,"WHOLESALER":0,"RETAILER":0}}""",
                        cookie = game.facilitator,
                        key = "mm",
                    )

                response.status shouldBe HttpStatusCode.UnprocessableEntity
                response
                    .body()
                    .array("errors")
                    .single()
                    .jsonObject
                    .str("field") shouldBe "requestedWeek"
            }
        }

        test("[US2.3] 準備中のゲームのセッションの状態: 409 の session.not_active") {
            withWorld {
                val game = prepared("preparing")

                val response = state(game, game.facilitator)

                response.status shouldBe HttpStatusCode.Conflict
                response.body().str("code") shouldBe "session.not_active"
            }
        }

        test("[US6.1/AC6.1.4] 実 DB: /ready は 200。接続を失うと 503（type つき）になり、/health は 200 のまま") {
            withWorld { world ->
                client.call(HttpMethod.Get, "/ready").status shouldBe HttpStatusCode.OK

                world.dataSource.close()

                val ready = client.call(HttpMethod.Get, "/ready")
                ready.status shouldBe HttpStatusCode.ServiceUnavailable
                ready.body().str("type") shouldBe "/problems/app.not_ready"
                ready.body().obj("checks").str("database") shouldBe "false"
                client.call(HttpMethod.Get, "/health").status shouldBe HttpStatusCode.OK
            }
        }

        test("[US6.1/AC6.1.4] 通知の受信が生きていない: /ready は 503（ChangeNotifier.isAlive）") {
            val wrap = { ports: Ports -> deadNotifier(ports) }
            withWorld(World(wrap = wrap)) {
                val ready = client.call(HttpMethod.Get, "/ready")

                ready.status shouldBe HttpStatusCode.ServiceUnavailable
                ready.body().obj("checks").str("notifier") shouldBe "false"
                ready.body().obj("checks").str("database") shouldBe "true"
            }
        }

        test("[US6.1/AC6.1.1] ログ: 全体の流れを通しても、資格・表示名・参加コードを含まない。相関 ID は応答のヘッダーと一致する") {
            val world = World()
            withWorld(world) {
                val game = started("log")
                playWeekOne(game)
                val response = state(game, game.facilitator)
                val secrets =
                    game.players.values.flatMap { listOf(it.cookie, it.name) } + listOf(game.facilitator, game.joinCode)

                val text = world.logs.text()

                secrets.forEach { text shouldNotContain it }
                text shouldNotContain "bg_session"
                text shouldNotContain "Cookie"
                (world.logs.all().size > 15) shouldBe true
                val correlationId = checkNotNull(response.headers["x-correlation-id"])
                world.logs.all().map { it.correlationId } shouldContain correlationId
                val commit = world.logs.all().first { it.operation == "commitWeek" }
                commit.status shouldBe 200
                commit.result shouldBe "ok"
                commit.gameId shouldBe game.id
                (commit.sessionVersion != null) shouldBe true
            }
        }

        test("[US6.1/AC6.1.2] 予期しないエラー: 500 の app.internal。利用者へは相関 ID だけ。スタックと相関 ID を記録し、秘密を含まない") {
            val broken = AtomicBoolean(false)
            val world =
                World(
                    wrap = { ports ->
                        val events = ports.stores.events
                        ports.withEvents(
                            events.copy(
                                read = { tx, id, stream ->
                                    check(!broken.get()) { "接続文字列 postgres://app:topsecret@db/x" }
                                    events.read(tx, id, stream)
                                },
                            ),
                        )
                    },
                )
            withWorld(world) {
                val created = client.createGame(key = "c-err")
                val facilitator = created.requireCredential()
                val id = created.location().removePrefix("$API/games/").removeSuffix("/state")
                broken.set(true)

                val response = client.call(HttpMethod.Post, "/games/$id/start", cookie = facilitator, key = "start-err")

                response.status shouldBe HttpStatusCode.InternalServerError
                response.body().str("type") shouldBe "/problems/app.internal"
                response.bodyAsText() shouldNotContain "topsecret"
                val record = world.logs.all().single { it.level == "ERROR" }
                record.correlationId shouldBe response.headers["x-correlation-id"]
                record.operation shouldBe "startGame"
                (record.stack ?: emptyList()).isNotEmpty() shouldBe true
                world.logs.text() shouldNotContain "topsecret"
                world.logs.text() shouldNotContain facilitator
            }
        }

        test("[NF] 再試行の上限: 503 の app.retry_exhausted（type と Retry-After つき）。バックエンド自身の 503 は必ず type を持つ") {
            val world =
                World(
                    maxAttempts = 2,
                    wrap = { ports ->
                        val events = ports.stores.events
                        ports.withEvents(events.copy(append = { _, _, _ -> AppFailure.ConcurrencyConflict.left() }))
                    },
                )
            withWorld(world) {
                val response = client.createGame(key = "retry")

                response.status shouldBe HttpStatusCode.ServiceUnavailable
                response.body().str("type") shouldBe "/problems/app.retry_exhausted"
                response.headers[HttpHeaders.RetryAfter] shouldBe "1"
            }
        }

        test("[NF-S10] 64 KB を超える本文: 413（ゲームは作られない）") {
            withWorld { world ->
                val response = client.createGame(body = """{"kind":"KIT","pad":"${"x".repeat(70_000)}"}""")

                response.status shouldBe HttpStatusCode.PayloadTooLarge
                world.countGames() shouldBe 0
            }
        }

        test("[NF-S8] 外部の Origin からの変更系: 403 で、ゲームは作られない") {
            withWorld { world ->
                val response =
                    client.callWith(HttpMethod.Post, "/games", """{"kind":"KIT","finalWeek":1,"demand":[1]}""") {
                        header("Idempotency-Key", "csrf")
                        header(HttpHeaders.Origin, "https://evil.example.org")
                    }

                response.status shouldBe HttpStatusCode.Forbidden
                world.countGames() shouldBe 0
            }
        }

        test("[NF] コマンドの応答の本文は versions（game と session）だけ: 作成・参加・割り当て・開始・保存・確定のすべて") {
            withWorld {
                val created = client.createGame(key = "shape")
                val facilitator = created.requireCredential()
                val id = created.location().removePrefix("$API/games/").removeSuffix("/state")
                val joinCode =
                    client
                        .call(
                            HttpMethod.Get,
                            "/games/$id/state",
                            cookie = facilitator,
                        ).body()
                        .str("joinCode")
                val joined =
                    client.call(
                        HttpMethod.Post,
                        "/participations/join",
                        """{"joinCode":"$joinCode","displayName":"田中"}""",
                        key = "shape-join",
                    )
                val lobby =
                    client
                        .call(
                            HttpMethod.Get,
                            "/games/$id/lobby",
                            cookie = facilitator,
                        ).body()
                        .array("participants")
                val participantId = lobby.single().jsonObject.str("participantId")
                val assigned =
                    client.call(
                        HttpMethod.Put,
                        "/games/$id/participants/$participantId/role",
                        """{"role":"RETAILER"}""",
                        cookie = facilitator,
                        key = "shape-assign",
                    )

                listOf(created, joined, assigned).forEach { response ->
                    response.body().keys shouldBe setOf("versions")
                    response.body().obj("versions").keys shouldBe setOf("game", "session")
                }
                joined.bodyAsText() shouldNotContain joined.requireCredential()
                val game = started("shape-2")
                val saved = save(game, "RETAILER", 1, "shape-save")
                saved.body().keys shouldBe setOf("versions")
                saved.body().obj("versions").keys shouldBe setOf("game", "session")
            }
        }
    })

private fun World.countGames(): Int = count("game_roots")

private fun HttpResponse.location(): String = checkNotNull(headers[HttpHeaders.Location]) { "Location がない" }

private fun HttpResponse.requireCredential(): String = checkNotNull(credential()) { "資格情報がない" }

private fun deadNotifier(ports: Ports): Ports = ports.withNotifier(ports.notifier.copy(isAlive = { false }))

private fun Ports.withEvents(events: beergame.application.EventStore): Ports =
    Ports(
        generators,
        beergame.application.Stores(
            events,
            stores.project,
            stores.idempotency,
            stores.peripheral,
            stores.attempts,
            stores.reader,
        ),
        lock,
        notifier,
        settings,
    )

private fun Ports.withNotifier(notifier: beergame.application.ChangeNotifier): Ports =
    Ports(generators, stores, lock, notifier, settings)
