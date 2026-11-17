package beergame.persistence

import io.kotest.core.spec.style.FunSpec
import io.kotest.matchers.shouldBe
import java.io.File

/**
 * 書く版のイベントの golden（全イベントの種類の `event_type`・`schema_version`・JSON）を、保存する形に直した文字列。
 * 1 件 1 行の JSON の配列。ファイルは `src/test/resources/golden/v<書く版>/events.json`（過去の版は、変更しない）。
 */
internal fun renderGolden(): String =
    GOLDEN.joinToString(",\n", "[\n", "\n]\n") { (_, event, _) ->
        val encoded = EventCodec.encode(event)
        """{"eventType":"${encoded.eventType}","schemaVersion":${encoded.schemaVersion},""" +
            """"payload":${encoded.payloadJson}}"""
    }

internal fun goldenFile(version: Int): File = File("src/test/resources/golden/v$version/events.json")

/**
 * golden のファイル（B12。N-1 互換の入力）。書く版の golden が、保存してあるファイルと一致することを守る。
 * 一致しなければ、書く版の形が変わっている（`schema_version` を上げる、または意図しない変更）。ファイルを書き換えて通してはならない。
 * 書き出しは、環境変数 `GOLDEN_EXPORT` に出力先を指定したときだけ行う（新しい版の golden を足すとき、N-1 互換の検査が使う）。
 */
class GoldenFixtureSpec :
    FunSpec({
        test("[B12/NF-O11] Given 書く版の全イベントの golden When 保存してあるファイルと比べる Then 一致する") {
            goldenFile(EventCodec.CURRENT_SCHEMA_VERSION).readText() shouldBe renderGolden()
        }

        test("[B12/NF-O11] Given 環境変数 GOLDEN_EXPORT When 指定されている Then 書く版の golden をそこへ書き出す") {
            System.getenv("GOLDEN_EXPORT")?.let { path ->
                File(path).also { it.absoluteFile.parentFile.mkdirs() }.writeText(renderGolden())
            }
        }
    })
