package beergame.http

import io.ktor.http.HttpStatusCode
import io.ktor.server.http.content.LocalFileContent
import io.ktor.server.response.respond
import io.ktor.server.routing.Route
import io.ktor.server.routing.get
import java.nio.file.Files
import java.nio.file.Path

private const val INDEX = "index.html"

/**
 * 画面（web のビルド成果物）を、API と同じ URL から配信する（デモ環境用。[HttpSettings.webRoot] を設定したときだけ）。
 * 存在するファイルはそのまま返し、無い経路（`/games/…/lobby` など、画面の経路を直接開いたとき）は `index.html` を返す。経路は画面側で決める。
 * API の経路（`/api/…`）は対象外にし、存在しない API の経路に `index.html` を返さない（404 のまま）。
 * ルートの外（`..`）は読まない。
 */
internal fun Route.webRoutes(root: String) {
    val base = Path.of(root).toAbsolutePath().normalize()
    get("{path...}") {
        val segments = call.parameters.getAll("path").orEmpty()
        val requested = base.resolve(segments.joinToString("/")).normalize()
        val existing = requested.takeIf { it.startsWith(base) && Files.isRegularFile(it) }
        val file =
            when {
                existing != null -> existing
                isApiPath(segments) || hasExtension(segments) -> null
                else -> base.resolve(INDEX).takeIf(Files::isRegularFile)
            }
        if (file != null) {
            call.respond(LocalFileContent(file.toFile()))
        } else {
            call.respond(HttpStatusCode.NotFound)
        }
    }
}

private fun isApiPath(segments: List<String>): Boolean = segments.firstOrNull() == "api"

/** 拡張子のある経路（`/assets/missing.js` など）は、画面の経路でなくファイルの要求。無ければ 404 にして、読み込みの失敗を隠さない。 */
private fun hasExtension(segments: List<String>): Boolean = segments.lastOrNull()?.contains('.') == true
