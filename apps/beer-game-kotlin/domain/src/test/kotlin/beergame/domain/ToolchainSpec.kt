package beergame.domain

import arrow.core.Either
import io.kotest.core.spec.style.FunSpec
import io.kotest.matchers.shouldBe

class ToolchainSpec :
    FunSpec({
        test("domain から Arrow の Either が使える") {
            Either.Right(1).map { it + 1 } shouldBe Either.Right(2)
        }

        test("domain の実行時のクラスパスに Ktor と JDBC ドライバーは無い") {
            listOf("io.ktor.server.application.Application", "org.postgresql.Driver", "org.h2.Driver").forEach { name ->
                runCatching { Class.forName(name) }.isFailure shouldBe true
            }
        }
    })
