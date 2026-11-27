package bgs.app

import bgs.adapter.http.ExportBuilder
import bgs.application.*
import bgs.domain.*
import munit.FunSuite

import java.util.UUID

/** 結果の出力（AC4.3.*）。CSV と JSON は同じ記録から作る。数式の解釈の防止と、チェックサムを確かめる。 */
class ExportBuilderSpec extends FunSuite:

  private val gameId = GameId(UUID.fromString("00000000-0000-0000-0000-000000000001"))

  private def row(role: Role, week: Int) =
    RoleResultView(
      role,
      week,
      orders = 4,
      order = 5,
      inventory = 12,
      backlog = 0,
      shipment = 4,
      cost = 600,
      cumulativeCost = 600L * week
    )

  private def view(kind: SettingsKind = SettingsKind.Kit, changed: List[SettingsField] = Nil) =
    ReviewView(
      gameId,
      finalWeek = 2,
      kind,
      changed,
      CommitMode.Manual,
      (1 to 2).toList.flatMap(w => Role.values.toList.map(row(_, w))),
      Versions(Some(1), Some(1))
    )

  test("[AC4.3.1] CSV は見出し + 1 週 × 1 役割の行で、CRLF 区切り。週の昇順、役割は上流から下流") {
    val lines = ExportBuilder.csv(view()).split("\r\n").toList
    assertEquals(lines.headOption, Some(ExportBuilder.CsvHeader.mkString(",")))
    assertEquals(lines.size, 1 + 2 * 4)
    assert(
      lines(1).startsWith(s"${ExportBuilder.SchemaVersion},${gameId.value},KIT,,MANUAL,1,FACTORY,")
    )
    assert(lines(1).contains(",1,FACTORY,"))
    assert(lines(4).contains(",1,RETAILER,"))
    assert(lines(5).contains(",2,FACTORY,"))
  }

  test("[AC4.3.2] CSV と JSON は、週と役割ごとに数量と費用が一致し、同じスキーマ版を持つ") {
    val v =
      view(SettingsKind.Custom, List(SettingsField.InitialInventory, SettingsField.ShipmentDelay))
    val csvRows = ExportBuilder.csv(v).split("\r\n").toList.drop(1).map(_.split(",").toList)
    val jsonRecords =
      ExportBuilder.json(v).hcursor.downField("records").values.map(_.toList).getOrElse(Nil)
    assertEquals(jsonRecords.size, csvRows.size)
    jsonRecords.zip(csvRows).foreach { (j, c) =>
      val h = j.hcursor
      assertEquals(c(5), h.get[Int]("week").toOption.map(_.toString).getOrElse(""))
      assertEquals(c(7), h.get[Long]("orders").toOption.map(_.toString).getOrElse(""))
      assertEquals(c(9), h.get[Int]("ordered").toOption.map(_.toString).getOrElse(""))
      assertEquals(c(12), h.get[Long]("weeklyCostMinor").toOption.map(_.toString).getOrElse(""))
      assertEquals(c(13), h.get[Long]("cumulativeCostMinor").toOption.map(_.toString).getOrElse(""))
      assertEquals(c(0), ExportBuilder.SchemaVersion)
    }
    assertEquals(
      ExportBuilder.json(v).hcursor.get[String]("schemaVersion").toOption,
      Some(ExportBuilder.SchemaVersion)
    )
    assertEquals(
      ExportBuilder.json(v).hcursor.downField("settings").get[List[String]]("changes").toOption,
      Some(List("INITIAL_INVENTORY", "SHIPMENT_DELAY"))
    )
  }

  test("[NF-S14] 出力に、表示名・参加コード・資格の項目を持たない") {
    val text = ExportBuilder.csv(view()) + ExportBuilder.json(view()).noSpaces
    List("displayName", "joinCode", "recoveryCode", "token").foreach(k =>
      assert(!text.contains(k), k)
    )
  }

  test("[CSV] 数式として解釈される先頭の文字には ' を付け、カンマ・引用符・改行は RFC 4180 で引用する") {
    assertEquals(ExportBuilder.textCell("=SUM(A1)"), "'=SUM(A1)")
    assertEquals(ExportBuilder.textCell("+1"), "'+1")
    assertEquals(ExportBuilder.textCell("-1"), "'-1")
    assertEquals(ExportBuilder.textCell("@x"), "'@x")
    assertEquals(ExportBuilder.textCell("\tx"), "'\tx")
    assertEquals(ExportBuilder.textCell("a,b"), "\"a,b\"")
    assertEquals(ExportBuilder.textCell("a\"b"), "\"a\"\"b\"")
    assertEquals(ExportBuilder.textCell("plain"), "plain")
    assertEquals(ExportBuilder.textCell(""), "")
  }

  test("[AC4.3.2] チェックサムは本文の SHA-256（sha256- と小文字の 16 進）で、本文が変わると変わる") {
    val a = ExportBuilder.checksum("abc")
    assertEquals(a, "sha256-ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
    assertNotEquals(a, ExportBuilder.checksum("abd"))
  }
