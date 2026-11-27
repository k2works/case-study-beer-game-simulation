package bgs.app

import bgs.adapter.http.{Emf, OperationIds}
import bgs.application.LogRecord
import munit.FunSuite

import java.time.Instant

/** メトリクス（EMF）と操作名（B13。AC6.1.3）。 */
class EmfSpec extends FunSuite:

  private val at = Instant.parse("2026-12-01T00:00:00Z")

  test("[AC6.1.3] 操作名は、契約の operationId。識別子・週・役割名は経路から落とす") {
    assertEquals(
      OperationIds.of("GET", "/api/v1/games/00000000-0000-0000-0000-000000000001/state"),
      "getGameState"
    )
    assertEquals(OperationIds.of("GET", "/api/v1/ready"), "getReady")
    assertEquals(
      OperationIds
        .of("POST", "/api/v1/sessions/00000000-0000-0000-0000-000000000001/weeks/3/commit"),
      "commitWeek"
    )
    assertEquals(
      OperationIds
        .of("PUT", "/api/v1/sessions/00000000-0000-0000-0000-000000000001/proxy-decisions/FACTORY"),
      "submitProxyDecision"
    )
    assertEquals(OperationIds.of("GET", "/nowhere"), "unknown")
  }

  test("[AC6.1.3] EMF の行は、応答時間・要求数・5xx のエラー率を、操作ごとに持つ") {
    val line =
      Emf.line(LogRecord("c-1", "GET /api/v1/games/{id}/state", 200, 12L, "getGameState"), at)
    val c = line.hcursor
    assertEquals(c.get[String]("Operation").toOption, Some("getGameState"))
    assertEquals(c.get[Long]("ResponseTime").toOption, Some(12L))
    assertEquals(c.get[Int]("RequestCount").toOption, Some(1))
    assertEquals(c.get[Int]("Http5xxRate").toOption, Some(0))
    val metrics = c.downField("_aws").downField("CloudWatchMetrics").downArray
    assertEquals(metrics.get[String]("Namespace").toOption, Some("BeerGame"))
    assertEquals(
      metrics
        .downField("Metrics")
        .values
        .map(_.flatMap(_.hcursor.get[String]("Name").toOption).toList),
      Some(List("ResponseTime", "RequestCount", "Http5xxRate"))
    )
    assertEquals(c.downField("_aws").get[Long]("Timestamp").toOption, Some(at.toEpochMilli))
  }

  test("[AC6.1.3] 5xx は、エラー率 1 として出る。4xx は 0") {
    assertEquals(
      Emf
        .line(LogRecord("c", "GET /api/v1/ready", 503, 5, "getReady"), at)
        .hcursor
        .get[Int]("Http5xxRate")
        .toOption,
      Some(1)
    )
    assertEquals(
      Emf
        .line(LogRecord("c", "GET /api/v1/games/{id}/state", 403, 5, "getGameState"), at)
        .hcursor
        .get[Int]("Http5xxRate")
        .toOption,
      Some(0)
    )
  }

  test("[AC6.1.3] EMF の行に、相関 ID・資格・表示名の項目は含まれない") {
    val text = Emf.line(LogRecord("secret-correlation", "GET /x", 200, 1, "getHealth"), at).noSpaces
    assert(!text.contains("secret-correlation"))
    List("token", "cookie", "displayName", "joinCode").foreach(k =>
      assert(!text.toLowerCase.contains(k.toLowerCase), k)
    )
  }
