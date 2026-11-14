package beergame.http

import io.kotest.core.spec.style.FunSpec
import io.kotest.matchers.shouldBe

class DependencyDirectionSpec :
    FunSpec({
        test("adapter-http には Ktor があり、JDBC ドライバーは無い") {
            runCatching { Class.forName("io.ktor.server.application.Application") }.isSuccess shouldBe true
            runCatching { Class.forName("org.postgresql.Driver") }.isFailure shouldBe true
        }
    })
