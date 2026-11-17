package beergame.persistence

import io.kotest.assertions.fail
import io.kotest.core.spec.style.FunSpec
import io.kotest.matchers.collections.shouldNotBeEmpty
import io.kotest.matchers.shouldBe
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.io.File

/** golden のファイル 1 つの、全イベントを読み、読めなかったものの一覧（`event_type`・版・理由）を返す。 */
private fun unreadable(file: File): List<String> {
    val entries: JsonArray = Json.parseToJsonElement(file.readText()).jsonArray
    return entries.mapNotNull { element ->
        val entry: JsonObject = element.jsonObject
        val eventType = entry.getValue("eventType").jsonPrimitive.content
        val version = entry.getValue("schemaVersion").jsonPrimitive.int
        EventCodec
            .decode(eventType, version, entry.getValue("payload").toString())
            .leftOrNull()
            ?.let { "${file.parentFile.name}/${file.name} $eventType v$version: $it" }
    }
}

/** 環境変数 `N1_GOLDEN_FILES`（区切りは [File.pathSeparator]）が示す、他の版が書いた golden のファイル。 */
private fun foreignGolden(): List<File> =
    System
        .getenv("N1_GOLDEN_FILES")
        ?.split(File.pathSeparator)
        ?.filter { it.isNotBlank() }
        ?.map(::File)
        .orEmpty()

private fun ownGolden(): List<File> =
    File("src/test/resources/golden")
        .listFiles { f -> f.isDirectory && f.name.matches(Regex("v[0-9]+")) }
        ?.sortedBy { it.name }
        ?.map { File(it, "events.json") }
        ?.filter { it.exists() }
        .orEmpty()

/**
 * N-1 互換（B12。NF-O11、運用の障害パターン 16）。この版の**読み取り側**（`EventCodec.decode` と、そのアップキャスト）が、
 * (1) 保存してある過去の版の golden と、(2) 環境変数 `N1_GOLDEN_FILES` が示す、別の版が書く golden を、すべて読めること。
 * 直前のリリースのタグで本試験を実行する（`scripts/n1-compat.sh`）と、「旧イメージが新しいイベントを読めない」障害を事前に検出できる。
 * 旧いタグで動くように、`EventCodec.decode` の公開の入口だけを使う。
 */
class N1CompatibilitySpec :
    FunSpec({
        test("[B12/NF-O11] Given 保存してある全ての版の golden When この版で読む Then すべてのイベントを復号できる") {
            val own = ownGolden()
            val foreign = foreignGolden()
            if (own.isEmpty() && foreign.isEmpty()) fail("読む golden が 1 つも無い")

            (own + foreign)
                .flatMap {
                    unreadable(
                        it,
                    )
                }.also { if (it.isNotEmpty()) println(it.joinToString("\n")) } shouldBe
                emptyList()
        }

        test("[B12/NF-O11] Given 保存してある golden When 読む Then 全イベントの種類を含む（空ではない）") {
            (ownGolden() + foreignGolden()).forEach { file ->
                Json
                    .parseToJsonElement(file.readText())
                    .jsonArray
                    .toList()
                    .shouldNotBeEmpty()
            }
        }
    })
