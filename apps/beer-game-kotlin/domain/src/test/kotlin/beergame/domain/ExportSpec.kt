package beergame.domain

import io.kotest.core.spec.style.FunSpec
import io.kotest.matchers.shouldBe
import io.kotest.property.Arb
import io.kotest.property.arbitrary.int
import io.kotest.property.arbitrary.list
import io.kotest.property.arbitrary.long
import io.kotest.property.arbitrary.map
import io.kotest.property.arbitrary.string
import io.kotest.property.checkAll
import java.security.MessageDigest
import java.util.UUID
import kotlin.system.measureTimeMillis

private const val ITERATIONS = 200
private const val LONG_RUN_WEEKS = 50
private const val LONG_RUN_LIMIT_MILLIS = 5_000L

private val GAME = GameId(UUID.fromString("11111111-2222-3333-4444-555555555555"))

private fun settings(
    finalWeek: Int,
    kind: String = "KIT",
    changes: List<String> = emptyList(),
) = ExportSettings(GAME, finalWeek, kind, changes, "MANUAL")

private fun row(
    week: Int,
    role: Role,
    n: Int = week * 10 + role.ordinal,
) = ExportRow(week, role, n, n + 1, n + 2, n + 3, n + 4, n * 100L, n * 1000L)

private fun fullGame(weeks: Int): List<ExportRow> = (1..weeks).flatMap { week -> Role.entries.map { row(week, it) } }

/** RFC 4180 の CSV を、行と列に戻す（試験の側の読み手。出力の書き手と独立に作る）。 */
private fun parseCsv(text: String): List<List<String>> {
    val records = mutableListOf<List<String>>()
    var fields = mutableListOf<String>()
    val field = StringBuilder()
    var quoted = false
    var i = 0
    while (i < text.length) {
        val c = text[i]
        when {
            quoted && c == '"' && text.getOrNull(i + 1) == '"' -> {
                field.append('"')
                i++
            }

            quoted && c == '"' -> {
                quoted = false
            }

            quoted -> {
                field.append(c)
            }

            c == '"' -> {
                quoted = true
            }

            c == ',' -> {
                fields.add(field.toString())
                field.clear()
            }

            c == '\r' && text.getOrNull(i + 1) == '\n' -> {
                fields.add(field.toString())
                field.clear()
                records.add(fields)
                fields = mutableListOf()
                i++
            }

            else -> {
                field.append(c)
            }
        }
        i++
    }
    return records
}

private val RECORD =
    Regex(
        "\\{\"week\":(-?\\d+),\"role\":\"(\\w+)\",\"orders\":(-?\\d+),\"shipped\":(-?\\d+),\"ordered\":(-?\\d+)," +
            "\"endingInventory\":(-?\\d+),\"endingBacklog\":(-?\\d+)," +
            "\"weeklyCostMinor\":(-?\\d+),\"cumulativeCostMinor\":(-?\\d+)\\}",
    )

private val rowArb: Arb<ExportRow> =
    Arb.list(Arb.int(0..100_000), 7..7).map { v ->
        ExportRow(v[0] % 50 + 1, Role.entries[v[1] % 4], v[2], v[3], v[4], v[5], v[6], v[2] * 7L, v[3] * 9L)
    }

class ExportSpec :
    FunSpec({
        test("[B10/AC4.3.1] ゴールデン: 1 週分の CSV と JSON の本文が、列・並び・区切りまで決まった形で作られる") {
            val export =
                buildExport(
                    settings(1, "CUSTOM", listOf("INITIAL_INVENTORY", "SHIPMENT_DELAY")),
                    fullGame(1).shuffled(),
                )
            val prefix =
                "beer-game-kotlin.export.v1,11111111-2222-3333-4444-555555555555," +
                    "CUSTOM,INITIAL_INVENTORY;SHIPMENT_DELAY,MANUAL"

            export.csv.body shouldBe
                "schema_version,game_id,settings_kind,settings_changes,commit_mode,week,role,orders,shipped,ordered," +
                "ending_inventory,ending_backlog,weekly_cost_minor,cumulative_cost_minor\r\n" +
                "$prefix,1,FACTORY,10,11,12,13,14,1000,10000\r\n" +
                "$prefix,1,DISTRIBUTOR,11,12,13,14,15,1100,11000\r\n" +
                "$prefix,1,WHOLESALER,12,13,14,15,16,1200,12000\r\n" +
                "$prefix,1,RETAILER,13,14,15,16,17,1300,13000\r\n"
            export.json.body shouldBe
                "{\"schemaVersion\":\"beer-game-kotlin.export.v1\"," +
                "\"gameId\":\"11111111-2222-3333-4444-555555555555\",\"finalWeek\":1," +
                "\"settings\":{\"kind\":\"CUSTOM\",\"changes\":[\"INITIAL_INVENTORY\",\"SHIPMENT_DELAY\"]," +
                "\"commitMode\":\"MANUAL\"},\"records\":[" +
                "{\"week\":1,\"role\":\"FACTORY\",\"orders\":10,\"shipped\":11,\"ordered\":12," +
                "\"endingInventory\":13,\"endingBacklog\":14,\"weeklyCostMinor\":1000,\"cumulativeCostMinor\":10000}," +
                "{\"week\":1,\"role\":\"DISTRIBUTOR\",\"orders\":11,\"shipped\":12,\"ordered\":13," +
                "\"endingInventory\":14,\"endingBacklog\":15,\"weeklyCostMinor\":1100,\"cumulativeCostMinor\":11000}," +
                "{\"week\":1,\"role\":\"WHOLESALER\",\"orders\":12,\"shipped\":13,\"ordered\":14," +
                "\"endingInventory\":15,\"endingBacklog\":16,\"weeklyCostMinor\":1200,\"cumulativeCostMinor\":12000}," +
                "{\"week\":1,\"role\":\"RETAILER\",\"orders\":13,\"shipped\":14,\"ordered\":15," +
                "\"endingInventory\":16,\"endingBacklog\":17,\"weeklyCostMinor\":1300,\"cumulativeCostMinor\":13000}]}"
            export.csv.filename shouldBe "beer-game-11111111-2222-3333-4444-555555555555.csv"
            export.json.filename shouldBe "beer-game-11111111-2222-3333-4444-555555555555.json"
            export.csv.contentType shouldBe "text/csv; charset=utf-8"
            export.json.contentType shouldBe "application/json; charset=utf-8"
            export.schemaVersion shouldBe EXPORT_SCHEMA_VERSION
        }

        test("[B10/AC4.3.2] チェックサムは、本文の UTF-8 のバイト列の SHA-256（小文字の 16 進）で、形式ごとに違う") {
            val export = buildExport(settings(1), fullGame(1))

            ExportFormat.entries.forEach { format ->
                val document = export.document(format)
                val expected =
                    MessageDigest
                        .getInstance(
                            "SHA-256",
                        ).digest(document.body.toByteArray(Charsets.UTF_8))
                        .joinToString("") {
                            "%02x".format(it)
                        }
                document.checksum shouldBe expected
                document.format shouldBe format
            }
            (export.csv.checksum == export.json.checksum) shouldBe false
        }

        test("[B10/AC4.3.2] 性質: 任意の記録から作った CSV と JSON は、週・役割ごとの数量と費用がすべて一致する") {
            checkAll(ITERATIONS, Arb.list(rowArb, 0..30)) { rows ->
                val export = buildExport(settings(3), rows)

                val csvRows = parseCsv(export.csv.body).drop(1)
                val jsonRecords = RECORD.findAll(export.json.body).map { it.groupValues.drop(1) }.toList()
                csvRows.size shouldBe rows.size
                jsonRecords.size shouldBe rows.size
                csvRows.zip(jsonRecords).forEach { (csv, json) ->
                    // CSV の 5 列目以降（week, role, 7 つの値）と、JSON の記録の項目の順は同じ
                    csv.drop(5) shouldBe json
                    csv[0] shouldBe EXPORT_SCHEMA_VERSION
                }
                csvRows.map { it[5].toInt() to Role.valueOf(it[6]) } shouldBe
                    export.rows.map { it.week to it.role }
            }
        }

        test("[B10/AC4.3.2] 性質: 記録は、週の昇順・役割の順（上流から下流）に並ぶ") {
            checkAll(ITERATIONS, Arb.list(rowArb, 0..30)) { rows ->
                val ordered = buildExport(settings(3), rows).rows

                ordered shouldBe ordered.sortedWith(compareBy({ it.week }, { it.role.ordinal }))
            }
        }

        test("[B10/AC4.3.1] CSV: 文字列の値の先頭が数式の記号なら、先頭に ' を付けて数式として解釈させない（元の値は失われない）") {
            listOf("=cmd|' /C calc'!A0", "+1", "-1", "@SUM(A1)", "\tx", "\rx").forEach { hostile ->
                val csv = buildExport(settings(1, "CUSTOM", listOf(hostile)), fullGame(1)).csv.body

                val cell = parseCsv(csv)[1][3]
                cell shouldBe "'$hostile"
            }
        }

        test("[B10/AC4.3.1] CSV: RFC 4180。カンマ・引用符・改行を含む値は引用符で囲み、引用符は二重にする（読み戻して一致する）") {
            checkAll(ITERATIONS, Arb.string(0..12)) { text ->
                val parsed = parseCsv(buildExport(settings(1, "CUSTOM", listOf(text)), fullGame(1)).csv.body)[1][3]

                val first = text.firstOrNull()
                val expected = if (first != null && first in "=+-@\t\r") "'$text" else text
                parsed shouldBe expected
            }
            val quoted = buildExport(settings(1, "CUSTOM", listOf("a,b\"c\nd")), fullGame(1)).csv.body
            quoted.contains("\"a,b\"\"c\nd\"") shouldBe true
        }

        test("[B10/AC4.3.1] JSON: 引用符・円記号・改行・タブ・制御文字を逃がす") {
            val body = buildExport(settings(1, "CUSTOM", listOf("a\"b\\c\nd\re\tf\u0001")), fullGame(1)).json.body

            body.contains("\"changes\":[\"a\\\"b\\\\c\\nd\\re\\tf\\u0001\"]") shouldBe true
        }

        test("[B10/AC4.3.3] 全週・全役割の記録がそろっていれば complete。欠け・重複・余分があれば complete ではない") {
            buildExport(settings(3), fullGame(3)).complete shouldBe true
            buildExport(settings(3), fullGame(3).drop(1)).complete shouldBe false
            buildExport(settings(3), fullGame(3) + row(1, Role.FACTORY)).complete shouldBe false
            buildExport(settings(3), fullGame(2)).complete shouldBe false
            buildExport(settings(3), fullGame(3).dropLast(1) + row(4, Role.RETAILER)).complete shouldBe false
        }

        test("[B10/NF-P9] 50 週 × 4 役割（200 行）の出力は、ミリ秒〜秒のオーダーで作れる") {
            val weeks = fullGame(LONG_RUN_WEEKS)
            val elapsed = measureTimeMillis { buildExport(settings(LONG_RUN_WEEKS), weeks) }

            (elapsed < LONG_RUN_LIMIT_MILLIS) shouldBe true
            buildExport(settings(LONG_RUN_WEEKS), weeks).complete shouldBe true
        }

        test("[B10/AC4.3.2] 費用は 64 ビットの整数で、そのまま書かれる") {
            checkAll(ITERATIONS, Arb.long(0L..Long.MAX_VALUE)) { cost ->
                val rows = listOf(row(1, Role.FACTORY).copy(weeklyCostMinor = cost, cumulativeCostMinor = cost))
                val export = buildExport(settings(1), rows)

                parseCsv(export.csv.body)[1].takeLast(2) shouldBe listOf(cost.toString(), cost.toString())
                export.json.body.contains("\"weeklyCostMinor\":$cost,\"cumulativeCostMinor\":$cost") shouldBe true
            }
        }
    })
