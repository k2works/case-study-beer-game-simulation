package beergame.domain

import io.kotest.core.spec.style.FunSpec
import io.kotest.matchers.collections.shouldContainAll
import io.kotest.matchers.collections.shouldNotBeEmpty
import io.kotest.matchers.shouldBe
import java.nio.file.Files

private val B5_EVENTS =
    listOf(
        "SessionPaused",
        "SessionResumed",
        "ProxyDecisionSubmitted",
        "CredentialRevoked",
        "CredentialReissued",
        "ParticipationRecovered",
        "ParticipantReplaced",
        "RoleHolderReplaced",
    )

private fun frontMatter(
    title: String,
    description: String,
): String =
    "---\ntype: Design\ntitle: \"$title\"\ndescription: \"$description\"\ntags: [design, generated]\nstatus: draft\n---"

/**
 * Living Documentation（B5 Step 8.4）。注釈とソースから用語集とイベント一覧を生成し、(1) 注釈の漏れ、(2) 設計書の ID の不一致、
 * (3) コミット済みの生成物との差を、失敗にする。更新は `./gradlew :domain:generateLivingDocs`（`-Dbeergame.docs.update=true`）。
 */
class LivingDocumentationSpec :
    FunSpec({
        test("[8.4] すべてのイベントに @EventSpec があり、ID はストリームの接頭辞で始まり、一意である") {
            val events = LivingDocumentation.events()

            events.map { it.id }.toSet().size shouldBe events.size
            events.forEach { e ->
                val prefix = if (e.stream == StreamType.GAME) "EV-G" else "EV-S"
                e.id.startsWith(prefix) shouldBe true
                e.trigger.isNotBlank() shouldBe true
            }
        }

        test("[8.4] イベントの ID と名前が、設計書（ドメインモデルの EV-G*・EV-S*）の表と一致する") {
            val design =
                LivingDocumentation.designEvents(
                    Files.readString(LivingDocumentation.designFile("domain-model.md")),
                )

            val mismatches =
                LivingDocumentation
                    .events()
                    .filter {
                        design[it.id] != it.name
                    }.map { "${it.id} ${it.name}（設計書: ${design[it.id]}）" }

            mismatches shouldBe emptyList()
        }

        test("[8.4] B5 で足したイベント 8 種類が、イベント一覧に載り、購読する投影が読み取れる") {
            val events = LivingDocumentation.events()

            events.map { it.name } shouldContainAll B5_EVENTS
            // 一時停止・再開・代理入力は、セッションの概要（SessionOverview）を更新する。資格のイベントはロビーを購読しない
            events.first { it.name == "SessionPaused" }.projections shouldBe listOf("sessionOverview")
            events.first { it.name == "ProxyDecisionSubmitted" }.projections shouldContainAll
                listOf("sessionOverview", "currentDecisions")
            events.first { it.name == "CredentialRevoked" }.projections shouldBe emptyList()
        }

        test("[8.4] 購読する投影の走査は、投影ごとのイベントを読み取る") {
            val source =
                """
                |    val first =
                |        Projection { e ->
                |            when (val p = e.payload) {
                |                is GameEvent.A -> listOf()
                |                is SessionEvent.B -> listOf()
                |            }
                |        }
                |    val second =
                |        Projection { e ->
                |            when (e.payload) {
                |                is GameEvent.A -> listOf()
                |            }
                |        }
                """.trimMargin()

            LivingDocumentation.projectionSubscriptions(source) shouldBe
                mapOf("A" to listOf("first", "second"), "B" to listOf("first"))
        }

        test("[8.4] 用語は一意で、定義と出典が書かれている") {
            val terms = LivingDocumentation.terms()

            terms.shouldNotBeEmpty()
            terms.map { it.name }.toSet().size shouldBe terms.size
            terms.forEach { (it.definition.isNotBlank() && it.source.isNotBlank()) shouldBe true }
        }

        test("[8.4] 生成したイベント一覧が、コミット済みの docs/design/beer-game-kotlin/generated/events.md と一致する") {
            val events = LivingDocumentation.events()
            val design =
                LivingDocumentation.designEvents(
                    Files.readString(LivingDocumentation.designFile("domain-model.md")),
                )
            val designOnly = design.filterValues { name -> events.none { it.name == name } }.toSortedMap()
            val generated = LivingDocumentation.eventsMarkdown(events, designOnly)

            val committed =
                LivingDocumentation.committedBody(
                    LivingDocumentation.designFile("generated/events.md"),
                    generated,
                    frontMatter("イベント一覧（生成）", "ドメインイベントの一覧。コードの注釈とソースから生成した。手で編集しない。"),
                )

            committed shouldBe generated
        }

        test("[8.4] 生成した用語集が、コミット済みの docs/design/beer-game-kotlin/generated/glossary.md と一致する") {
            val generated = LivingDocumentation.glossaryMarkdown(LivingDocumentation.terms())

            val committed =
                LivingDocumentation.committedBody(
                    LivingDocumentation.designFile("generated/glossary.md"),
                    generated,
                    frontMatter("用語集（生成）", "ユビキタス言語の用語集。コードの注釈 @Term から生成した。手で編集しない。"),
                )

            committed shouldBe generated
        }
    })
