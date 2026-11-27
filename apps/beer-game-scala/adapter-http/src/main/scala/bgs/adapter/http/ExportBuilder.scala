package bgs.adapter.http

import bgs.application.ReviewView
import io.circe.Json

import java.nio.charset.StandardCharsets
import java.security.MessageDigest

/** 結果の出力（CSV・JSON）の組み立て。同じ記録（[[ReviewView]]）から作るので、数量と費用が一致する（AC4.3.2）。
  * 表示名・資格・参加コードは、型に持たない（NF-S14）。
  */
object ExportBuilder:

  /** 出力の形の版。CSV の各行の `schema_version`、JSON の `schemaVersion`、`X-Export-Schema-Version` に記録する。 */
  val SchemaVersion: String = "beer-game-scala.export.v1"

  val CsvHeader: List[String] = List(
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
    "cumulative_cost_minor"
  )

  /** 表計算で数式として解釈される先頭の文字。文字列の列では、先頭に `'` を付けて無効にする。 */
  private val FormulaPrefixes: Set[Char] = Set('=', '+', '-', '@', '\t', '\r')

  /** CSV の文字列の列（RFC 4180）。数式の接頭辞を無効にし、`,`・`"`・改行を含むなら引用する。 */
  def textCell(value: String): String =
    val safe = if value.headOption.exists(FormulaPrefixes.contains) then s"'$value" else value
    if safe.exists(c => c == ',' || c == '"' || c == '\n' || c == '\r') then
      "\"" + safe.replace("\"", "\"\"") + "\""
    else safe

  private def settingsKind(view: ReviewView): String = JsonViews.kindName(view.settingsKind)

  private def changes(view: ReviewView): List[String] =
    view.changedSettings.flatMap(f => JsonViews.fieldName(f).asString)

  /** 見出しの行と、1 週 × 1 役割ごとの行（週の昇順、役割は上流から下流）。CRLF 区切り。 */
  def csv(view: ReviewView): String =
    val head = CsvHeader.mkString(",")
    val rows = view.results.map { r =>
      List(
        textCell(SchemaVersion),
        textCell(view.gameId.value.toString),
        textCell(settingsKind(view)),
        textCell(changes(view).mkString(";")),
        textCell(JsonViews.commitModeName(view.commitMode)),
        r.week.toString,
        textCell(JsonViews.roleName(r.role)),
        r.orders.toString,
        r.shipment.toString,
        r.order.toString,
        r.inventory.toString,
        r.backlog.toString,
        r.cost.toString,
        r.cumulativeCost.toString
      ).mkString(",")
    }
    (head :: rows).mkString("", "\r\n", "\r\n")

  def json(view: ReviewView): Json =
    Json.obj(
      "schemaVersion" -> Json.fromString(SchemaVersion),
      "gameId" -> Json.fromString(view.gameId.value.toString),
      "finalWeek" -> Json.fromInt(view.finalWeek),
      "settings" -> Json.obj(
        "kind" -> Json.fromString(settingsKind(view)),
        "changes" -> Json.fromValues(changes(view).map(Json.fromString)),
        "commitMode" -> Json.fromString(JsonViews.commitModeName(view.commitMode))
      ),
      "records" -> Json.fromValues(view.results.map { r =>
        Json.obj(
          "week" -> Json.fromInt(r.week),
          "role" -> Json.fromString(JsonViews.roleName(r.role)),
          "orders" -> Json.fromLong(r.orders),
          "shipped" -> Json.fromLong(r.shipment),
          "ordered" -> Json.fromInt(r.order),
          "endingInventory" -> Json.fromLong(r.inventory),
          "endingBacklog" -> Json.fromLong(r.backlog),
          "weeklyCostMinor" -> Json.fromLong(r.cost),
          "cumulativeCostMinor" -> Json.fromLong(r.cumulativeCost)
        )
      })
    )

  /** 本文（UTF-8 のバイト列）の SHA-256。`sha256-` と小文字の 16 進。 */
  def checksum(body: String): String =
    "sha256-" + MessageDigest
      .getInstance("SHA-256")
      .digest(body.getBytes(StandardCharsets.UTF_8))
      .map(b => f"${b & 0xff}%02x")
      .mkString
