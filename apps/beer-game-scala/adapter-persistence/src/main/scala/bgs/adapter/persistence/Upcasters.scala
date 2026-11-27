package bgs.adapter.persistence

import io.circe.Json
import io.circe.parser.parse

/** 保存済みのイベントの形（スキーマ版）を、現在の形へ上げる（アップキャスト）。B12。
  *
  * 現在のスキーマ版は [[Current]]（1）。**読む版 → 書く版の 2 段階リリース**の読む側の保護として、
  * 現在より新しい版のイベントは、読まずに止める（古いコードが新しい形を誤って解釈しない）。 版を上げるときは、`upcastFrom`
  * に、旧版から次の版への変換を足し、黄金のデータ（`golden-events`）も増やす。
  */
object Upcasters:

  /** いま書いているスキーマ版。`events.schema_version` に記録される。 */
  val Current: Int = 1

  /** 旧版（[[version]]）の JSON を、次の版へ上げる。現在は旧版が無いので、恒等の入口だけ。 */
  private def upcastFrom(version: Int, json: Json): Either[String, Json] =
    if version == Current then Right(json) else Left(s"未知のスキーマ版: $version")

  def upcast(eventType: String, schemaVersion: Int, payload: String): Either[String, Json] =
    for
      json <- parse(payload).left.map(e => s"$eventType の本文を読めない: ${e.message}")
      _ <- Either.cond(
        schemaVersion <= Current,
        (),
        s"$eventType のスキーマ版 $schemaVersion は、このコード（版 $Current まで）より新しい"
      )
      upgraded <- (schemaVersion to Current - 1).foldLeft[Either[String, Json]](Right(json)) {
        (acc, version) => acc.flatMap(upcastFrom(version, _))
      } match
        case Right(done) if schemaVersion == Current => Right(done)
        case other                                   => other
    yield upgraded
