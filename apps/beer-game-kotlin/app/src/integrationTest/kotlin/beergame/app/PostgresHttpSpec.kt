package beergame.app

import beergame.http.HttpDeps
import beergame.http.HttpSettings
import beergame.http.beerGameModule
import beergame.persistence.Dialect
import beergame.persistence.Migrations
import beergame.persistence.Persistence
import beergame.persistence.PersistenceConfig
import com.zaxxer.hikari.HikariConfig
import com.zaxxer.hikari.HikariDataSource
import io.kotest.core.spec.style.FunSpec
import io.kotest.matchers.collections.shouldNotContain
import io.kotest.matchers.shouldBe
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpMethod
import io.ktor.http.HttpStatusCode
import io.ktor.server.testing.testApplication
import kotlinx.serialization.json.jsonObject
import org.testcontainers.postgresql.PostgreSQLContainer
import java.sql.DriverManager

/**
 * 実 PostgreSQL 18（Testcontainers）の上で、HTTP のウォーキングスケルトンを 1 本通す（最小の統合）。
 * 網羅は H2 の HttpFlowSpec が持つ。ここは、PostgreSQL 版のポート（排他・LISTEN/NOTIFY）と SQL が、HTTP から通ることを確かめる。
 */
private val ROLES = listOf("FACTORY", "DISTRIBUTOR", "WHOLESALER", "RETAILER")

class PostgresHttpSpec :
    FunSpec({
        val container = PostgreSQLContainer("postgres:18-alpine").withDatabaseName("beergame_http_test")

        beforeSpec { container.start() }
        afterSpec { container.stop() }

        test("[US2.3/AC2.3.1] PostgreSQL 18: 作成・参加・割り当て・開始・入力・確定・表示が HTTP で通り、/ready は通知の受信の生存も見る") {
            val dataSource =
                HikariDataSource(
                    HikariConfig().apply {
                        jdbcUrl = container.jdbcUrl
                        username = container.username
                        password = container.password
                        maximumPoolSize = 8
                        connectionTimeout = 2_000
                    },
                )
            Migrations.migrate(dataSource, Dialect.POSTGRES)
            val persistence =
                Persistence.open(
                    Dialect.POSTGRES,
                    dataSource,
                    PersistenceConfig(TEST_SECRETS.responseKey),
                ) { DriverManager.getConnection(container.jdbcUrl, container.username, container.password) }
            val logs = CapturingLogs()
            val deps =
                HttpDeps(
                    ports = appPorts(persistence, TEST_SECRETS, maxAttempts = 5),
                    database = databaseProbe(dataSource),
                    settings = HttpSettings(setOf("http://localhost:5173"), cookieSecure = false),
                    logs = logs,
                )

            try {
                testApplication {
                    application { beerGameModule(deps) }
                    client.call(HttpMethod.Get, "/ready").status shouldBe HttpStatusCode.OK

                    val created =
                        client.call(
                            HttpMethod.Post,
                            "/games",
                            """{"kind":"KIT","finalWeek":3,"demand":[4,999,998]}""",
                            key = "pg-create",
                        )
                    created.status shouldBe HttpStatusCode.Created
                    val facilitator = checkNotNull(created.credential()) { "進行役の資格情報がない" }
                    val id =
                        checkNotNull(created.headers[HttpHeaders.Location]) { "Location がない" }
                            .removePrefix("$API/games/")
                            .removeSuffix("/state")
                    val joinCode =
                        client
                            .call(
                                HttpMethod.Get,
                                "/games/$id/state",
                                cookie = facilitator,
                            ).body()
                            .str("joinCode")
                    val players =
                        ROLES.associateWith { role ->
                            checkNotNull(
                                client
                                    .call(
                                        HttpMethod.Post,
                                        "/participations/join",
                                        """{"joinCode":"$joinCode","displayName":"参加者-$role"}""",
                                        key = "pg-join-$role",
                                    ).credential(),
                            ) { "参加者 $role の資格情報がない" }
                        }
                    val lobby =
                        client
                            .call(
                                HttpMethod.Get,
                                "/games/$id/lobby",
                                cookie = facilitator,
                            ).body()
                            .array("participants")
                    ROLES.forEach { role ->
                        val participant =
                            lobby
                                .map { it.jsonObject }
                                .first {
                                    it.str(
                                        "displayName",
                                    ) == "参加者-$role"
                                }.str("participantId")
                        client
                            .call(
                                HttpMethod.Put,
                                "/games/$id/participants/$participant/role",
                                """{"role":"$role"}""",
                                cookie = facilitator,
                                key = "pg-assign-$role",
                            ).status shouldBe HttpStatusCode.OK
                    }
                    client
                        .call(
                            HttpMethod.Post,
                            "/games/$id/start",
                            cookie = facilitator,
                            key = "pg-start",
                        ).status shouldBe
                        HttpStatusCode.OK
                    ROLES.forEach { role ->
                        client
                            .call(
                                HttpMethod.Put,
                                "/sessions/$id/decisions",
                                """{"week":1,"quantity":4}""",
                                cookie = players.getValue(role),
                                key = "pg-save-$role",
                            ).status shouldBe HttpStatusCode.OK
                    }
                    val commit =
                        client.call(
                            HttpMethod.Post,
                            "/sessions/$id/weeks/1/commit",
                            """{"requestedWeek":1,"basis":{"FACTORY":1,"DISTRIBUTOR":1,"WHOLESALER":1,"RETAILER":1}}""",
                            cookie = facilitator,
                            key = "pg-commit",
                        )

                    commit.status shouldBe HttpStatusCode.OK
                    commit.body().keys shouldBe setOf("versions")
                    val state = client.call(HttpMethod.Get, "/sessions/$id/state", cookie = facilitator).body()
                    state.str("week") shouldBe "2"
                    state.array("results").size shouldBe 4
                    val retailer =
                        client.call(
                            HttpMethod.Get,
                            "/sessions/$id/state",
                            cookie = players.getValue("RETAILER"),
                        )
                    val retailerBody = retailer.body()
                    retailerBody.obj("roleStatus").str("customerDemand") shouldBe "999"
                    retailerBody.leafValues() shouldNotContain "998"

                    dataSource.close()
                    client.call(HttpMethod.Get, "/ready").status shouldBe HttpStatusCode.ServiceUnavailable
                    client.call(HttpMethod.Get, "/health").status shouldBe HttpStatusCode.OK
                }
            } finally {
                persistence.close()
                dataSource.close()
            }
        }
    })
