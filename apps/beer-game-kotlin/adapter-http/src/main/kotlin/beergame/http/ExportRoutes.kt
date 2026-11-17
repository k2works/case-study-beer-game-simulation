package beergame.http

import arrow.core.Either
import arrow.core.left
import arrow.core.raise.either
import arrow.core.right
import beergame.application.export
import beergame.domain.EXPORT_SCHEMA_VERSION
import beergame.domain.ExportDocument
import beergame.domain.ExportFormat
import beergame.domain.GameId
import io.ktor.http.ContentType
import io.ktor.http.HttpStatusCode
import io.ktor.server.application.ApplicationCall
import io.ktor.server.response.header
import io.ktor.server.response.respondText
import io.ktor.server.routing.Route
import io.ktor.server.routing.get

/*
 * 結果の出力（B10。US4.3）。`GET /games/{gameId}/exports?format=csv|json`。進行役だけ、終了後だけ。
 * 本文は、全体を組み立てたあとに 1 回で返す（ストリーミングしない。AC4.3.3: 部分的な結果を完全な出力として示さない）。
 * 組み立てられなければ、本文は返さず、既存の失敗の写像（problem+json）になる。
 */

private const val CHECKSUM_HEADER = "X-Export-Checksum"
private const val SCHEMA_VERSION_HEADER = "X-Export-Schema-Version"

internal fun Route.exportRoutes(deps: HttpDeps) {
    get("/games/{gameId}/exports") {
        call.operation("getExport")
        val result =
            either<Problem, ExportDocument> {
                val id = call.gameIdParam("gameId").bind()
                val format = call.exportFormat().bind()
                deps.ports
                    .export(GameId(id), call.credential(), format)
                    .mapLeft { it.toProblem() }
                    .bind()
            }
        result.fold({ call.respondProblem(it) }, { call.respondExport(it) })
    }
}

/** `?format=csv|json`（必須）。省略・知らない形式は、422（`errors[].field` が `format`）。 */
private fun ApplicationCall.exportFormat(): Either<Problem, ExportFormat> =
    when (request.queryParameters["format"]) {
        "csv" -> ExportFormat.CSV.right()
        "json" -> ExportFormat.JSON.right()
        else -> validationProblem(listOf(FieldError("format", "形式は csv か json にしてください。"))).left()
    }

/** `suspend fun` でなく「suspend の関数型の値」で定義する（detekt 1.23.8 の RedundantSuspendModifier の誤判定を避ける。CallSupport.kt と同じ理由）。 */
private val respondExport: suspend ApplicationCall.(ExportDocument) -> Unit = { document ->
    response.header("Content-Disposition", "attachment; filename=\"${document.filename}\"")
    response.header(CHECKSUM_HEADER, "sha256-${document.checksum}")
    response.header(SCHEMA_VERSION_HEADER, EXPORT_SCHEMA_VERSION)
    respondText(document.body, ContentType.parse(document.contentType), HttpStatusCode.OK)
}
