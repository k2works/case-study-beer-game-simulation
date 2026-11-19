package beergame.persistence

import io.kotest.core.spec.style.FunSpec
import io.kotest.matchers.shouldBe

class DependencyDirectionSpec :
    FunSpec({
        test("adapter-persistence の実行時のクラスパスに JDBC ドライバー（PostgreSQL と H2）がある") {
            listOf("org.postgresql.Driver", "org.h2.Driver").forEach { name ->
                runCatching { Class.forName(name) }.isSuccess shouldBe true
            }
        }

        test("adapter-persistence の実行時のクラスパスに Ktor は無い") {
            runCatching { Class.forName("io.ktor.server.application.Application") }.isFailure shouldBe true
        }
    })
