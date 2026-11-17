package beergame.domain

import java.security.MessageDigest

/*
 * 結果の出力（B10。US4.3）。**投影にせず**、問い合わせの時に、全域の純粋関数 [buildExport] で作る（設計 D11）。
 * `Either` を返さない。入力の欠け（終了済みなのに週・役割の記録がそろわない）は、[ExportPackage.complete] が false になるだけで、
 * それを失敗にして本文を返さない判断は、呼び出す側（application）が持つ（AC4.3.3: 部分的な結果を完全な出力として示さない）。
 * CSV と JSON は、同じ [ExportRow] から作るので、数量と費用が必ず一致する（AC4.3.2）。
 */

/** 出力の形の版。形を変えたら上げる。CSV の各行の列と、JSON の `schemaVersion` に記録する。 */
const val EXPORT_SCHEMA_VERSION = "beer-game-kotlin.export.v1"

private const val ROLE_COUNT = 4

/** 出力の形式。 */
enum class ExportFormat { CSV, JSON }

/** 出力に含める設定の概要。表示名・資格・参加コードを含まない（NF-S14）。[kind] は `KIT`・`CUSTOM`、[changes] は変更した項目の名前。 */
data class ExportSettings(
    val gameId: GameId,
    val finalWeek: Int,
    val kind: String,
    val changes: List<String>,
    val commitMode: String,
)

/** 1 週 × 1 役割の記録（`week_role_results` の 1 行）。[ordered] が、その週に確定した発注量（意思決定）。 */
data class ExportRow(
    val week: Int,
    val role: Role,
    val orders: Int,
    val shipped: Int,
    val ordered: Int,
    val endingInventory: Int,
    val endingBacklog: Int,
    val weeklyCostMinor: Long,
    val cumulativeCostMinor: Long,
)

/** 1 形式の出力。[checksum] は、[body] を UTF-8 で符号化したバイト列の SHA-256（小文字の 16 進）。 */
data class ExportDocument(
    val format: ExportFormat,
    val contentType: String,
    val filename: String,
    val body: String,
    val checksum: String,
)

/** 出力のパッケージ。両形式の本文・チェックサム・スキーマ版を、要求時に算出して持つ。 */
data class ExportPackage(
    val schemaVersion: String,
    val settings: ExportSettings,
    val rows: List<ExportRow>,
    val csv: ExportDocument,
    val json: ExportDocument,
) {
    /** 最終週までの全週・全役割の記録が、1 件ずつそろっている。 */
    val complete: Boolean =
        rows.size == settings.finalWeek * ROLE_COUNT &&
            rows.map { it.week to it.role }.toSet() ==
            (1..settings.finalWeek).flatMap { week -> Role.entries.map { week to it } }.toSet()

    fun document(format: ExportFormat): ExportDocument =
        when (format) {
            ExportFormat.CSV -> csv
            ExportFormat.JSON -> json
        }
}

private val CSV_COLUMNS =
    listOf(
        "schema_version",
        "game_id",
        "settings_kind",
        "settings_changes",
        "commit_mode",
        "week",
        "role",
        "orders",
        "shipped",
        "ordered",
        "ending_inventory",
        "ending_backlog",
        "weekly_cost_minor",
        "cumulative_cost_minor",
    )

/** 表計算が数式として解釈しうる先頭の文字（OWASP の CSV Injection）。 */
private const val FORMULA_TRIGGERS = "=+-@\t\r"

/** 値を引用符で囲む必要のある文字（RFC 4180）。 */
private const val CSV_SPECIALS = ",\"\r\n"

/**
 * 出力を、設定と全週・全役割の記録から作る（全域・純粋）。記録は、週の昇順・役割の順（上流から下流）に並べる。
 * チェックサムは、本文のバイト列から算出する。
 */
fun buildExport(
    settings: ExportSettings,
    results: List<ExportRow>,
): ExportPackage {
    val rows = results.sortedWith(compareBy({ it.week }, { it.role.ordinal }))
    val name = "beer-game-${settings.gameId.value}"
    return ExportPackage(
        schemaVersion = EXPORT_SCHEMA_VERSION,
        settings = settings,
        rows = rows,
        csv = document(ExportFormat.CSV, "text/csv; charset=utf-8", "$name.csv", csvOf(settings, rows)),
        json = document(ExportFormat.JSON, "application/json; charset=utf-8", "$name.json", jsonOf(settings, rows)),
    )
}

private fun document(
    format: ExportFormat,
    contentType: String,
    filename: String,
    body: String,
): ExportDocument = ExportDocument(format, contentType, filename, body, sha256Hex(body))

/** 本文を UTF-8 で符号化したバイト列の SHA-256（小文字の 16 進）。 */
private fun sha256Hex(text: String): String =
    MessageDigest
        .getInstance("SHA-256")
        .digest(text.toByteArray(Charsets.UTF_8))
        .joinToString("") { "%02x".format(it) }

/** RFC 4180。区切りは CRLF、末尾にも CRLF。文字列の列だけ [csvText] を通す（数値の列は、数値から書く）。 */
private fun csvOf(
    settings: ExportSettings,
    rows: List<ExportRow>,
): String =
    (listOf(CSV_COLUMNS.joinToString(",")) + rows.map { row -> csvLine(settings, row) })
        .joinToString(separator = "\r\n", postfix = "\r\n")

private fun csvLine(
    settings: ExportSettings,
    row: ExportRow,
): String =
    listOf(
        csvText(EXPORT_SCHEMA_VERSION),
        csvText(settings.gameId.value.toString()),
        csvText(settings.kind),
        csvText(settings.changes.joinToString(";")),
        csvText(settings.commitMode),
        row.week.toString(),
        csvText(row.role.name),
        row.orders.toString(),
        row.shipped.toString(),
        row.ordered.toString(),
        row.endingInventory.toString(),
        row.endingBacklog.toString(),
        row.weeklyCostMinor.toString(),
        row.cumulativeCostMinor.toString(),
    ).joinToString(",")

/** 数式として解釈されうる先頭の文字には `'` を付け、`,`・`"`・改行を含む値は `"` で囲む（`"` は二重にする）。 */
private fun csvText(value: String): String {
    val first = value.firstOrNull()
    val safe = if (first != null && first in FORMULA_TRIGGERS) "'$value" else value
    return if (safe.any { it in CSV_SPECIALS }) {
        "\"${safe.replace("\"", "\"\"")}\""
    } else {
        safe
    }
}

private fun jsonOf(
    settings: ExportSettings,
    rows: List<ExportRow>,
): String {
    val changes = settings.changes.joinToString(",") { jsonText(it) }
    val records = rows.joinToString(",") { jsonRecord(it) }
    return "{\"schemaVersion\":${jsonText(EXPORT_SCHEMA_VERSION)}," +
        "\"gameId\":${jsonText(settings.gameId.value.toString())}," +
        "\"finalWeek\":${settings.finalWeek}," +
        "\"settings\":{\"kind\":${jsonText(settings.kind)},\"changes\":[$changes]," +
        "\"commitMode\":${jsonText(settings.commitMode)}}," +
        "\"records\":[$records]}"
}

private fun jsonRecord(row: ExportRow): String =
    "{\"week\":${row.week},\"role\":${jsonText(row.role.name)}," +
        "\"orders\":${row.orders},\"shipped\":${row.shipped},\"ordered\":${row.ordered}," +
        "\"endingInventory\":${row.endingInventory},\"endingBacklog\":${row.endingBacklog}," +
        "\"weeklyCostMinor\":${row.weeklyCostMinor},\"cumulativeCostMinor\":${row.cumulativeCostMinor}}"

/** JSON の文字列（RFC 8259。`"`・`\`・制御文字を逃がす）。 */
private fun jsonText(value: String): String =
    buildString {
        append('"')
        value.forEach { c ->
            when {
                c == '"' -> append("\\\"")
                c == '\\' -> append("\\\\")
                c == '\n' -> append("\\n")
                c == '\r' -> append("\\r")
                c == '\t' -> append("\\t")
                c < ' ' -> append("\\u%04x".format(c.code))
                else -> append(c)
            }
        }
        append('"')
    }
