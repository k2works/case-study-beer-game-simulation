package beergame.domain

import io.kotest.core.spec.style.FunSpec
import io.kotest.matchers.collections.shouldContain
import io.kotest.matchers.shouldBe
import io.kotest.matchers.string.shouldContain
import java.nio.file.Files

private const val TOUR_FRONT_MATTER =
    "---\ntype: Design\ntitle: \"ウォーキングスケルトンのガイドツアー（生成）\"\n" +
        "description: \"最初の縦の切片（1 ゲーム・4 役割・1 週）を、画面からイベントと投影まで、層ごとにたどる案内。" +
        "コードの走査から生成する。手で編集しない。\"\ntags: [design, generated]\nstatus: draft\n---"

/**
 * ウォーキングスケルトンのガイドツアー（Living Documentation）。各停留所の層ごとの場所をコードの走査から導き、
 * 見つからなければ（コードが変わってツアーが古くなったら）失敗にする。コミット済みの生成物との差も失敗にする。
 * 更新は `./gradlew :domain:generateLivingDocs`（`-Dbeergame.docs.update=true`）。
 */
class WalkingSkeletonTourSpec :
    FunSpec({
        val resolved by lazy {
            WalkingSkeletonTour.resolve(
                LivingDocumentation.repoRoot(),
                LivingDocumentation.events(),
            )
        }

        test("[ツアー] 操作の順は、作成・参加・割り当て・開始・入力・確定・状態の表示の 7 つ") {
            WalkingSkeletonTour.stops.map { it.operationId } shouldBe
                listOf(
                    "createGame",
                    "joinGame",
                    "assignRole",
                    "startGame",
                    "saveDecision",
                    "commitWeek",
                    "getSessionState",
                )
        }

        test("[ツアー] すべての停留所の、API・ルート・アプリケーション・コマンド・画面・受入が、コードの中に見つかる") {
            resolved.forEach { stop ->
                stop.http.isNotBlank() shouldBe true
                stop.routeFile shouldContain "adapter-http"
                stop.applicationFile shouldContain "application"
                stop.acceptanceFiles.isNotEmpty() shouldBe true
            }
        }

        test("[ツアー] コマンドの停留所は、そのコマンドが作るイベントを持ち、問い合わせの停留所は持たない") {
            resolved.forEach { stop ->
                val isCommand = stop.stop.backend.commandDeclaration != null
                (stop.events.isNotEmpty()) shouldBe isCommand
            }
            // 準備中の割り当ては、割り当て（EV-G03）と、付け替えの解除の側（EV-G04）。開始後の入れ替え（EV-G12）は、ツアーの外
            resolved.first { it.stop.operationId == "assignRole" }.events.map { it.id } shouldBe
                listOf("EV-G03", "EV-G04")
            resolved.first { it.stop.operationId == "startGame" }.events.map { it.name } shouldContain "GameStarted"
            resolved.first { it.stop.operationId == "commitWeek" }.events.map { it.name } shouldContain "WeekCommitted"
        }

        test("[ツアー] 生成したツアーが、コミット済みの docs/design/beer-game-kotlin/generated/walking-skeleton-tour.md と一致する") {
            val generated = WalkingSkeletonTour.markdown(resolved)

            val committed =
                LivingDocumentation.committedBody(
                    LivingDocumentation.designFile("generated/walking-skeleton-tour.md"),
                    generated,
                    TOUR_FRONT_MATTER,
                )

            committed shouldBe generated
            Files.exists(LivingDocumentation.designFile("generated/walking-skeleton-tour.md")) shouldBe true
        }
    })
