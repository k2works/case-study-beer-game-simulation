package beergame.domain

import io.kotest.core.spec.style.FunSpec
import io.kotest.matchers.collections.shouldContainAll
import io.kotest.matchers.ints.shouldBeLessThanOrEqual
import io.kotest.matchers.shouldBe
import java.nio.file.Files

private const val CORE_FRONT_MATTER =
    "---\ntype: Design\ntitle: \"コアのハイライト（生成）\"\n" +
        "description: \"ドメインの中核（シミュレーション計算と進行）の主要な概念を、注釈 @CoreConcept から動的に選び出して示す案内。" +
        "新しく参加する開発者が、まず読むコードの入口になる。手で編集しない。\"\ntags: [design, generated]\nstatus: draft\n---"

/**
 * コアのハイライト（Living Documentation の Dynamic Curation。ガイド `docs/reference/ダイナミックキュレーション導入ガイド.md`）。
 * 注釈 [CoreConcept] を付けた少数の概念を、安定した基準（注釈）で選び出し、中核のコンテキストごとに示す。
 * 設計書の「中核」の区分を正本にして、(1) 中核のコンテキストが漏れなく示されること、(2) 補完・一般のものが混ざらないこと、
 * (3) 付ける数が上限を超えないこと、(4) コミット済みの生成物と一致することを、失敗にする。
 * 更新は `./gradlew :domain:generateLivingDocs`（`-Dbeergame.docs.update=true`）。
 */
class CoreHighlightSpec :
    FunSpec({
        val design by lazy { Files.readString(LivingDocumentation.designFile("domain-model.md")) }
        val contexts by lazy { CoreHighlight.coreContexts(design) }
        val elements by lazy { CoreHighlight.elements(LivingDocumentation.repoRoot()) }

        test("[コア] 設計書の「中核」のコンテキストは、シミュレーション計算と進行（プレイ）である") {
            contexts.map { it.name } shouldBe listOf("シミュレーション計算", "進行（プレイ）")
            contexts.forEach { it.reason.isNotBlank() shouldBe true }
        }

        test("[コア] 中核のコンテキストは、それぞれ 1 つ以上の @CoreConcept を持つ（核心が漏れていない）") {
            contexts.forEach { context ->
                elements.filter { it.context == context.name }.isNotEmpty() shouldBe true
            }
        }

        test("[コア] @CoreConcept の context は、設計書の「中核」のどれかである（補完・一般は載せない）") {
            elements.map { it.context }.toSet() shouldContainAll elements.map { it.context }
            elements.forEach { element -> contexts.map { it.name } shouldContainAll listOf(element.context) }
        }

        test("[コア] 付ける数は上限（10）以内で、名前は一意で、なぜ核心かの説明が空でなく、ソースの場所が見つかる") {
            elements.size shouldBeLessThanOrEqual CoreHighlight.MAX_CORE
            elements.map { it.name }.toSet().size shouldBe elements.size
            elements.forEach {
                it.description.isNotBlank() shouldBe true
                it.file.endsWith(".kt") shouldBe true
            }
        }

        test("[コア] 計算の核心は simulateWeek と Pipeline、進行の核心は decideSession・evolveSession・SessionState") {
            elements.filter { it.context == "シミュレーション計算" }.map { it.name } shouldContainAll
                listOf("simulateWeek", "Pipeline")
            elements.filter { it.context == "進行（プレイ）" }.map { it.name } shouldContainAll
                listOf("decideSession", "evolveSession", "SessionState")
        }

        test("[コア] 生成したハイライトが、コミット済みの docs/design/beer-game-kotlin/generated/core-highlight.md と一致する") {
            val generated = CoreHighlight.markdown(contexts, elements, LivingDocumentation.events())

            val committed =
                LivingDocumentation.committedBody(
                    LivingDocumentation.designFile("generated/core-highlight.md"),
                    generated,
                    CORE_FRONT_MATTER,
                )

            committed shouldBe generated
        }
    })
