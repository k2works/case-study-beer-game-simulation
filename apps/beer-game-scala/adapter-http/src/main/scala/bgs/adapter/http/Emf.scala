package bgs.adapter.http

import bgs.application.LogRecord
import io.circe.Json

import java.time.Instant

/** CloudWatch の EMF（Embedded Metric Format）の 1 行（B13。AC6.1.3）。標準出力へ JSON の 1 行で出すと、CloudWatch
  * がメトリクスにする。 項目は、操作名・応答時間・要求数・5xx のエラー率・時刻だけ。**相関 ID・資格・表示名・非公開の値は含めない**（専用の型の入力しか取らない）。
  */
object Emf:

  val Namespace: String = "BeerGame"

  def line(record: LogRecord, at: Instant): Json =
    Json.obj(
      "_aws" -> Json.obj(
        "Timestamp" -> Json.fromLong(at.toEpochMilli),
        "CloudWatchMetrics" -> Json.arr(
          Json.obj(
            "Namespace" -> Json.fromString(Namespace),
            "Dimensions" -> Json.arr(Json.arr(Json.fromString("Operation"))),
            "Metrics" -> Json.arr(
              Json.obj(
                "Name" -> Json.fromString("ResponseTime"),
                "Unit" -> Json.fromString("Milliseconds")
              ),
              Json
                .obj("Name" -> Json.fromString("RequestCount"), "Unit" -> Json.fromString("Count")),
              Json.obj("Name" -> Json.fromString("Http5xxRate"), "Unit" -> Json.fromString("None"))
            )
          )
        )
      ),
      "Operation" -> Json.fromString(record.operationId),
      "ResponseTime" -> Json.fromLong(record.durationMs),
      "RequestCount" -> Json.fromInt(1),
      "Http5xxRate" -> Json.fromInt(if record.status >= 500 then 1 else 0)
    )
