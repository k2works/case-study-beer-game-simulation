package beergame.http

import io.ktor.server.application.Application
import io.ktor.server.application.install
import io.ktor.server.routing.route
import io.ktor.server.routing.routing

/**
 * Ktor のアプリケーションに、API（`/api/v1`）を組み立てる。順序: 相関 ID・ヘッダー・ログ → エラー処理 → 守り → 経路。
 * 経路は contracts/openapi.yaml のとおり。SSE・出力・保持は B1 の範囲外。観察者は B9。
 */
fun Application.beerGameModule(deps: HttpDeps) {
    install(Observability) { this.deps = deps }
    installErrorHandling(deps)
    installGuards(deps)
    routing {
        route(API_BASE) {
            operationalRoutes(deps)
            commandRoutes(deps)
            observerRoutes(deps)
            queryRoutes(deps)
            exportRoutes(deps)
            retentionRoutes(deps)
        }
        deps.settings.webRoot?.let { webRoutes(it) }
    }
}
