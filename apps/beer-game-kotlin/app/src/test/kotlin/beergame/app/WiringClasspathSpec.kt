package beergame.app

import io.kotest.core.spec.style.FunSpec
import io.kotest.matchers.shouldBe

class WiringClasspathSpec :
    FunSpec({
        test("app の実行時のクラスパスに Ktor のエンジン、JDBC ドライバー、Logback が揃う") {
            listOf(
                "io.ktor.server.netty.Netty",
                "org.postgresql.Driver",
                "ch.qos.logback.classic.Logger",
            ).forEach { name ->
                runCatching { Class.forName(name) }.isSuccess shouldBe true
            }
        }
    })
