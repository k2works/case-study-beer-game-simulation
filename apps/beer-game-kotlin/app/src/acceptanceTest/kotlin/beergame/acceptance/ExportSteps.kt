package beergame.acceptance

import io.cucumber.java.en.Then
import io.cucumber.java.en.When
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.security.MessageDigest

private const val HTTP_OK = 200
private const val HTTP_UNPROCESSABLE = 422
private const val ROLE_COUNT = 4
private const val CSV_TYPE = "text/csv"
private const val JSON_TYPE = "application/json"

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

/** CSV の列名と、JSON の `records` の項目名の対応（数量と費用の列）。 */
private val VALUE_COLUMNS =
    mapOf(
        "orders" to "orders",
        "shipped" to "shipped",
        "ordered" to "ordered",
        "ending_inventory" to "endingInventory",
        "ending_backlog" to "endingBacklog",
        "weekly_cost_minor" to "weeklyCostMinor",
        "cumulative_cost_minor" to "cumulativeCostMinor",
    )

private fun sha256(text: String): String =
    MessageDigest.getInstance("SHA-256").digest(text.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }

/** 結果の出力（US4.3）のステップ定義。薄く保つ。 */
class ExportSteps {
    private val ctx get() = Scenario.current
    private var csv: ApiResponse? = null
    private var json: ApiResponse? = null

    @When("進行役が結果を CSV で出力する")
    fun facilitatorExportsCsv() {
        csv = ctx.api.export(ctx.game.id, "csv", ctx.game.facilitator)
        ctx.last = csv
        expect(csv?.status == HTTP_OK) { "出力できない: ${csv?.status} ${csv?.text}" }
    }

    @When("進行役が結果を JSON で出力する")
    fun facilitatorExportsJson() {
        json = ctx.api.export(ctx.game.id, "json", ctx.game.facilitator)
        ctx.last = json
        expect(json?.status == HTTP_OK) { "出力できない: ${json?.status} ${json?.text}" }
    }

    @When("進行役が結果を JSON でも出力する")
    fun facilitatorExportsJsonToo() = facilitatorExportsJson()

    @When("進行役が結果を CSV で出力しようとする")
    fun facilitatorTriesCsv() {
        ctx.last = ctx.api.export(ctx.game.id, "csv", ctx.game.facilitator)
    }

    @When("{word}の参加者が結果を CSV で出力しようとする")
    fun participantTriesCsv(label: String) {
        ctx.last = ctx.api.export(ctx.game.id, "csv", ctx.game.playerOf(Role.ofLabel(label)).cookie)
    }

    @When("資格の無い人が結果を CSV で出力しようとする")
    fun anonymousTriesCsv() {
        ctx.last = ctx.api.export(ctx.game.id, "csv", null)
    }

    @When("進行役が、形式を指定せずに結果を出力しようとする")
    fun facilitatorTriesWithoutFormat() {
        ctx.last = ctx.api.export(ctx.game.id, null, ctx.game.facilitator)
    }

    @When("進行役が、形式「{word}」で結果を出力しようとする")
    fun facilitatorTriesUnknownFormat(format: String) {
        ctx.last = ctx.api.export(ctx.game.id, format, ctx.game.facilitator)
    }

    @Then("出力は CSV として返り、ダウンロードの名前が付く")
    fun csvIsDownload() = isDownload(checkNotNull(csv), CSV_TYPE, ".csv")

    @Then("出力は JSON として返り、ダウンロードの名前が付く")
    fun jsonIsDownload() = isDownload(checkNotNull(json), JSON_TYPE, ".json")

    @Then("CSV に、設定の種別「キット準拠」と、4 役割のそれぞれについて {int} 週分の受注・出荷・発注・在庫・受注残・費用が含まれる")
    fun csvHasEverything(weeks: Int) {
        val (header, rows) = csvRows(checkNotNull(csv))
        expect(header == CSV_COLUMNS) { "列が違う: $header" }
        expect(rows.size == weeks * ROLE_COUNT) { "行が ${weeks * ROLE_COUNT} 件ではない: ${rows.size}" }
        expect(rows.all { it["settings_kind"] == "KIT" }) { "設定の種別が KIT ではない行がある" }
        expect(rows.all { it["game_id"] == ctx.game.id }) { "ゲームの ID が違う行がある" }
        Role.entries.forEach { role ->
            val ofRole = rows.filter { it["role"] == role.apiName }.map { it.getValue("week").toInt() }.sorted()
            expect(ofRole == (1..weeks).toList()) { "${role.label}の週が不足: $ofRole" }
        }
        expect(rows.all { row -> VALUE_COLUMNS.keys.all { row.getValue(it).toLongOrNull() != null } }) { "数値でない値がある" }
    }

    @Then("JSON に、設定の種別「キット準拠」と、4 役割のそれぞれについて {int} 週分の受注・出荷・発注・在庫・受注残・費用が含まれる")
    fun jsonHasEverything(weeks: Int) {
        val body = checkNotNull(json).json
        expect(body.text("gameId") == ctx.game.id) { "ゲームの ID が違う" }
        expect(body.obj("settings").text("kind") == "KIT") { "設定の種別が KIT ではない" }
        val records = body.array("records").map { it.jsonObject }
        expect(records.size == weeks * ROLE_COUNT) { "記録が ${weeks * ROLE_COUNT} 件ではない: ${records.size}" }
        Role.entries.forEach { role ->
            val ofRole = records.filter { it.text("role") == role.apiName }.map { it.number("week") }.sorted()
            expect(ofRole == (1..weeks).toList()) { "${role.label}の週が不足: $ofRole" }
        }
        expect(records.all { row -> VALUE_COLUMNS.values.all { it in row } }) { "項目が不足している記録がある" }
    }

    @Then("JSON に、設定の種別「カスタム」と、変更した項目「初期在庫」「配送の遅延」が含まれる")
    fun jsonIsCustom() {
        val settings = checkNotNull(json).json.obj("settings")
        expect(settings.text("kind") == "CUSTOM") { "種別が CUSTOM ではない: $settings" }
        val changes = settings.array("changes").map { it.jsonPrimitive.content }.toSet()
        val expected = setOf(FIELD_LABELS.getValue("初期在庫"), FIELD_LABELS.getValue("配送の遅延"))
        expect(changes == expected) { "変更した項目が違う: 期待 $expected、実際 $changes" }
    }

    @Then("2 つの形式の数量と費用が、週と役割ごとにすべて一致する")
    fun valuesMatch() {
        val (_, rows) = csvRows(checkNotNull(csv))
        val records = checkNotNull(json).json.array("records").map { it.jsonObject }
        expect(rows.size == records.size) { "件数が違う: CSV ${rows.size}、JSON ${records.size}" }
        rows.forEach { row ->
            val record = records.single { it.text("week") == row["week"] && it.text("role") == row["role"] }
            VALUE_COLUMNS.forEach { (column, field) ->
                expect(
                    record.text(field) == row[column],
                ) { "$column が違う: CSV ${row[column]}、JSON ${record.text(field)}" }
            }
        }
    }

    @Then("2 つの形式に、同じスキーマ版が記録される")
    fun sameSchemaVersion() {
        val (_, rows) = csvRows(checkNotNull(csv))
        val fromCsv = rows.map { it.getValue("schema_version") }.toSet()
        val fromJson = checkNotNull(json).json.text("schemaVersion")
        expect(fromCsv == setOf(fromJson)) { "スキーマ版が違う: CSV $fromCsv、JSON $fromJson" }
        listOf(csv, json).forEach {
            expect(checkNotNull(it).header("X-Export-Schema-Version") == fromJson) { "ヘッダーのスキーマ版が違う" }
        }
    }

    @Then("出力の本文の SHA-256 が、チェックサムのヘッダーと一致する")
    fun checksumMatches() {
        listOf(csv, json).map { checkNotNull(it) }.forEach {
            expect(it.header("X-Export-Checksum") == "sha256-${sha256(it.text)}") { "チェックサムが一致しない" }
        }
    }

    @Then("出力に、参加者の表示名と参加コードは含まれない")
    fun noPrivateValues() {
        listOf(csv, json).map { checkNotNull(it).text }.forEach { text ->
            ctx.game.participants.forEach { expect(it.name !in text) { "表示名が含まれている: ${it.name}" } }
            expect(ctx.game.joinCode !in text) { "参加コードが含まれている" }
        }
    }

    @Then("出力の本文は返らない")
    fun noBody() {
        val response = ctx.response()
        expect(response.status != HTTP_OK && response.header("Content-Type")?.contains("problem") == true) {
            "出力が返っている: ${response.status} ${response.header("Content-Type")}"
        }
        expect(CSV_COLUMNS.first() !in response.text) { "出力の列が含まれている" }
    }

    @Then("形式の誤りとして拒否される")
    fun formatRejected() {
        val response = ctx.response()
        expect(response.status == HTTP_UNPROCESSABLE) { "形式の誤りではない: ${response.status} ${response.text}" }
        expect(response.json.array("errors").any { it.jsonObject.text("field") == "format" }) {
            "format の誤りが示されていない: ${response.text}"
        }
    }

    private fun isDownload(
        response: ApiResponse,
        type: String,
        extension: String,
    ) {
        expect(
            response.header("Content-Type")?.startsWith(type) == true,
        ) { "種類が違う: ${response.header("Content-Type")}" }
        val disposition = response.header("Content-Disposition").orEmpty()
        expect(disposition.startsWith("attachment") && disposition.contains("beer-game-${ctx.game.id}$extension")) {
            "ダウンロードの名前が付いていない: $disposition"
        }
    }

    private fun csvRows(response: ApiResponse): Pair<List<String>, List<Map<String, String>>> {
        val lines = response.text.split("\r\n").filter { it.isNotEmpty() }
        val header = lines.first().split(",")
        return header to lines.drop(1).map { line -> header.zip(line.split(",")).toMap() }
    }
}
