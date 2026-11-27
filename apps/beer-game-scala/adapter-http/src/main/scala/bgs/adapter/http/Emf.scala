package bgs.adapter.http

import bgs.application.LogRecord
import io.circe.Json

import java.time.Instant

/** CloudWatch の EMF（Embedded Metric Format）の 1 行（B13。AC6.1.3）。標準出力へ JSON の 1 行で出すと、CloudWatch
  * がメトリクスにする。 項目は、操作名・応答時間・要求数・5xx のエラー率・時刻だけ。**相関 ID・資格・表示名・非公開の値は含めない**（専用の型の入力しか取らない）。
  */
object Emf:

  val Namespace: String = "BeerGame"

  /** 要求ごとの EMF の 1 行。次元は `Environment`（環境。アラームの対象）と `Operation`（操作ごと）。環境だけの系列（全操作の合計）も出る。 */
  def line(record: LogRecord, at: Instant, environment: String): Json =
    Json.obj(
      "_aws" -> Json.obj(
        "Timestamp" -> Json.fromLong(at.toEpochMilli),
        "CloudWatchMetrics" -> Json.arr(
          Json.obj(
            "Namespace" -> Json.fromString(Namespace),
            "Dimensions" -> Json.arr(
              Json.arr(Json.fromString("Environment"), Json.fromString("Operation")),
              Json.arr(Json.fromString("Environment"))
            ),
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
      "Environment" -> Json.fromString(environment),
      "Operation" -> Json.fromString(record.operationId),
      "ResponseTime" -> Json.fromLong(record.durationMs),
      "RequestCount" -> Json.fromInt(1),
      "Http5xxRate" -> Json.fromInt(if record.status >= 500 then 1 else 0)
    )

  /** 定期のタスク（retention・verify）の結果の指標の EMF の 1 行（次元は `Environment` だけ）。心拍（出ていること）も、アラームの対象。 */
  def gauge(name: String, value: Long, at: Instant, environment: String): Json =
    Json.obj(
      "_aws" -> Json.obj(
        "Timestamp" -> Json.fromLong(at.toEpochMilli),
        "CloudWatchMetrics" -> Json.arr(
          Json.obj(
            "Namespace" -> Json.fromString(Namespace),
            "Dimensions" -> Json.arr(Json.arr(Json.fromString("Environment"))),
            "Metrics" -> Json.arr(
              Json.obj("Name" -> Json.fromString(name), "Unit" -> Json.fromString("Count"))
            )
          )
        )
      ),
      "Environment" -> Json.fromString(environment),
      name -> Json.fromLong(value)
    )
