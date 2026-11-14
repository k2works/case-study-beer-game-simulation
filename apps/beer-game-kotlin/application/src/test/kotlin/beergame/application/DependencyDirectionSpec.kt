package beergame.application

import arrow.core.Either
import io.kotest.core.spec.style.FunSpec
import io.kotest.matchers.shouldBe

class DependencyDirectionSpec :
    FunSpec({
        test("application から domain 経由で Arrow が見える") {
            Either.Left("e").isLeft() shouldBe true
        }

        test("application の実行時のクラスパスに Ktor と JDBC ドライバーは無い") {
            listOf("io.ktor.server.application.Application", "org.postgresql.Driver", "org.h2.Driver").forEach { name ->
                runCatching { Class.forName(name) }.isFailure shouldBe true
            }
        }
    })
