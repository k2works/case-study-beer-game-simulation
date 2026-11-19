package beergame.http

import io.kotest.core.spec.style.FunSpec
import io.kotest.matchers.shouldBe
import io.kotest.matchers.string.shouldContain
import io.kotest.matchers.string.shouldNotContain
import io.ktor.client.HttpClient
import io.ktor.client.request.get
import io.ktor.client.statement.HttpResponse
import io.ktor.client.statement.bodyAsText
import io.ktor.http.HttpStatusCode
import io.ktor.server.testing.testApplication
import java.nio.file.Files
import java.nio.file.Path

private const val INDEX = "<!doctype html><title>beer-game</title><div id=\"root\"></div>"
private const val SCRIPT = "console.log('beer-game');"

private val fetch: suspend HttpClient.(String) -> HttpResponse = { path -> get(path) }
private val readText: suspend HttpResponse.() -> String = { bodyAsText() }

private fun webRoot(): Path =
    Files.createTempDirectory("beer-game-web").also { root ->
        Files.writeString(root.resolve("index.html"), INDEX)
        Files.createDirectories(root.resolve("assets"))
        Files.writeString(root.resolve("assets/app.js"), SCRIPT)
    }

private fun withWeb(
    root: String?,
    block: suspend io.ktor.server.testing.ApplicationTestBuilder.() -> Unit,
) = testApplication {
    application {
        beerGameModule(
            HttpDeps(
                ports = stubPorts(),
                database = DatabaseProbe { true },
                settings = testSettings(webRoot = root),
                logs = CapturingLogSink(),
                clock = { FIXED_NOW },
            ),
        )
    }
    block()
}

/** デモ環境のため、API が画面（web のビルド成果物）も同じ URL から配信できる。設定したときだけ配信する。 */
class WebRoutesSpec :
    FunSpec({
        test("[デモ] Given webRoot の設定 When GET / Then index.html を返す") {
            val root = webRoot().toString()
            withWeb(root) {
                val response = client.fetch("/")
                response.status shouldBe HttpStatusCode.OK
                response.readText() shouldContain "<title>beer-game</title>"
            }
        }

        test("[デモ] Given webRoot の設定 When GET /assets/app.js Then そのファイルを返す") {
            val root = webRoot().toString()
            withWeb(root) {
                val response = client.fetch("/assets/app.js")
                response.status shouldBe HttpStatusCode.OK
                response.readText() shouldBe SCRIPT
            }
        }

        test("[デモ] Given webRoot の設定 When 画面の経路（/games/…/lobby）を直接開く Then index.html を返す（画面側で経路を決める）") {
            val root = webRoot().toString()
            withWeb(root) {
                val response = client.fetch("/games/00000000-0000-0000-0000-000000000001/lobby")
                response.status shouldBe HttpStatusCode.OK
                response.readText() shouldContain "<title>beer-game</title>"
            }
        }

        test("[デモ] Given webRoot の設定 When 存在しないファイル（拡張子つき）を要求 Then 404（HTML を返して、読み込みの失敗を隠さない）") {
            val root = webRoot().toString()
            withWeb(root) {
                client.fetch("/assets/missing.js").status shouldBe HttpStatusCode.NotFound
            }
        }

        test("[デモ] Given webRoot の設定 When 存在しない API の経路 Then 404（index.html を返さない）") {
            val root = webRoot().toString()
            withWeb(root) {
                val response = client.fetch("/api/v1/no-such-route")
                response.status shouldBe HttpStatusCode.NotFound
                response.readText() shouldNotContain "<title>beer-game</title>"
            }
        }

        test("[デモ] Given webRoot の設定 When API の既存の経路 Then 従来どおり API が答える（画面に奪われない）") {
            val root = webRoot().toString()
            withWeb(root) {
                val response = client.fetch("/api/v1/health")
                response.status shouldBe HttpStatusCode.OK
                response.readText() shouldNotContain "<title>beer-game</title>"
            }
        }

        test("[デモ] Given webRoot の設定 When ルートの外のファイルを `..` で要求 Then その内容は返さない") {
            val root = webRoot()
            Files.writeString(root.resolveSibling("${root.fileName}-secret.txt"), "SECRET")
            val secret = "${root.fileName}-secret.txt"
            withWeb(root.toString()) {
                for (path in listOf("/..%2f$secret", "/assets/..%2f..%2f$secret")) {
                    client.fetch(path).readText() shouldNotContain "SECRET"
                }
            }
        }

        test("[デモ] Given webRoot の設定なし（既定） When GET / Then 404（画面は配信しない）") {
            withWeb(null) {
                client.fetch("/").status shouldBe HttpStatusCode.NotFound
            }
        }
    })
