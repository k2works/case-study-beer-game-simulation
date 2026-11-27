package bgs.app

import bgs.application.Alarms
import munit.FunSuite

import java.nio.charset.StandardCharsets
import java.nio.file.{Files, Path, Paths}

/** アラームの閾値の表（`Alarms`）と、Terraform の定義（`infra/modules/observability/alarms.tf`）が食い違わないことを確かめる（B14）。
  * 食い違いは、ここで落ちる。HCL の書式（キーの並び）を変えるときは、この試験の読み取りも直す。
  */
class AlarmTerraformSpec extends FunSuite:

  private val file: Path =
    List(
      "../infra/modules/observability/alarms.tf",
      "infra/modules/observability/alarms.tf",
      "apps/beer-game-scala/infra/modules/observability/alarms.tf"
    )
      .map(Paths.get(_))
      .find(Files.exists(_))
      .getOrElse(Paths.get("infra/modules/observability/alarms.tf"))

  private final case class Defined(
      metric: String,
      comparison: String,
      threshold: Double,
      period: Int,
      periods: Int,
      severity: String
  )

  /** `"name" = merge(local.x, { ... })` のブロックから、主要な項目を読む。 */
  private def definitions: Map[String, Defined] =
    val text = new String(Files.readAllBytes(file), StandardCharsets.UTF_8)
    val block = "(?s)\"([a-z0-9-]+)\"\\s*=\\s*merge\\(local\\.\\w+,\\s*\\{(.*?)\\n    \\}\\)".r
    def field(body: String, key: String): Option[String] =
      s"(?m)^\\s*$key\\s*=\\s*\"?([^\"\\n]+?)\"?\\s*$$".r.findFirstMatchIn(body).map(_.group(1))
    block
      .findAllMatchIn(text)
      .flatMap { m =>
        val body = m.group(2)
        for
          metric <- field(body, "metric_name")
          comparison <- field(body, "comparison")
          threshold <- field(body, "threshold").flatMap(_.toDoubleOption)
          period <- field(body, "period").flatMap(_.toIntOption)
          periods <- field(body, "evaluation_periods").flatMap(_.toIntOption)
          severity <- field(body, "severity")
        yield m.group(1) -> Defined(metric, comparison, threshold, period, periods, severity)
      }
      .toMap

  private def comparison(c: Alarms.Comparison): String = c match
    case Alarms.Comparison.LessThan       => "LessThanThreshold"
    case Alarms.Comparison.GreaterOrEqual => "GreaterThanOrEqualToThreshold"

  test("[B14] 定義ファイルが読め、閾値の表の全アラームが Terraform にある") {
    val defined = definitions
    assert(defined.nonEmpty, s"アラームの定義を読めない: $file")
    Alarms.all.foreach(a => assert(defined.contains(a.name), s"${a.name} が Terraform に無い"))
  }

  test("[B14] 名前・指標・比較・閾値・期間・評価の回数・重大度が、閾値の表と一致する") {
    val defined = definitions
    Alarms.all.foreach { a =>
      val d = defined.getOrElse(a.name, fail(s"${a.name} が無い"))
      val expected = Defined(
        a.metric match
          case "SyntheticSuccess" => "SuccessPercent" // CloudWatch Synthetics の標準の指標
          case other              => other
        ,
        comparison(a.comparison),
        a.threshold match
          case 1.0 if a.metric == "SyntheticSuccess" => 100.0
          case other                                 => other
        ,
        a.periodSeconds,
        a.datapoints,
        a.severity.toString.toLowerCase
      )
      assertEquals(d, expected, s"${a.name} が食い違う")
    }
  }
