package bgs.app

import bgs.adapter.http.Routes
import bgs.adapter.persistence.Migrations
import bgs.application.Env
import cats.effect.{IO, Resource}
import cats.syntax.all.*
import com.dimafeng.testcontainers.PostgreSQLContainer
import io.circe.Json
import io.circe.parser.parse
import munit.CatsEffectSuite
import org.http4s.*
import org.http4s.circe.*
import org.testcontainers.utility.DockerImageName
import org.typelevel.ci.CIString

import java.nio.charset.StandardCharsets
import java.nio.file.{Files, Paths}
import java.util.UUID
import scala.concurrent.duration.*

/** 実 PostgreSQL（Testcontainers。postgres:18.6）での性能の計測（B15。NF-P2・P9・P18・同時の負荷）。
  * 既定は小さな規模（動作の確認）。`BGS_MEASURE=1` で全規模（15 ゲーム・50 週）。結果は
  * `target/performance-sequential.txt`・`target/performance-concurrent.txt` に書く（標準出力は使わない）。
  * ネットワーク・ブラウザ・複数タスクを含まない（インプロセスの HTTP）。手元の Docker Desktop の値で、AWS の値ではない。
  */
class PerformanceMeasurementSpec extends CatsEffectSuite:

  /** `check` ジョブは Docker を要する統合テストを除外する。 */
  override def munitTests(): Seq[Test] = super.munitTests().map(_.tag(new munit.Tag("Integration")))

  override def munitIOTimeout: Duration = 40.minutes

  private val full = sys.env.get("BGS_MEASURE").contains("1")
  private val games = if full then 15 else 2
  private val weeks = if full then 50 else 6
  private val roles = List("FACTORY", "DISTRIBUTOR", "WHOLESALER", "RETAILER")

  private final case class Sample(operation: String, millis: Double, status: Int)

  private def pg: Resource[IO, Env] =
    for
      container <- Resource.make(IO.blocking {
        val c = PostgreSQLContainer.Def(DockerImageName.parse("postgres:18.6")).start()
        c
      })(c => IO.blocking(c.stop()))
      _ <- Resource.eval(
        Migrations.migratePostgres(container.jdbcUrl, container.username, container.password)
      )
      env <- Wiring.postgres(
        DatabaseConfig.Postgres(container.jdbcUrl, container.username, container.password),
        "perf-secret-perf-secret-perf-secret"
      )
    yield env

  private def call(
      app: HttpApp[IO],
      op: String,
      method: Method,
      path: String,
      body: Option[Json] = None,
      cookie: Option[String] = None,
      ifMatch: Option[Long] = None
  ): IO[(Sample, Json, Headers)] =
    val base = Request[IO](method, Uri.unsafeFromString(path))
    val withBody = body.fold(base)(b => base.withEntity(b)(using jsonEncoderOf[IO, Json]))
    val withCookie =
      cookie.fold(withBody)(c => withBody.putHeaders(Header.Raw(CIString("Cookie"), c)))
    val withMatch = ifMatch.fold(withCookie)(v =>
      withCookie.putHeaders(Header.Raw(CIString("If-Match"), v.toString))
    )
    val keyed =
      if method == Method.GET then withMatch
      else withMatch.putHeaders(Header.Raw(CIString("Idempotency-Key"), UUID.randomUUID.toString))
    app.run(keyed).flatMap(r => r.bodyText.compile.string.map(t => (r, t))).timed.map {
      (elapsed, rt) =>
        val (response, text) = rt
        (
          Sample(op, elapsed.toNanos / 1e6, response.status.code),
          parse(text).getOrElse(Json.Null),
          response.headers
        )
    }

  private def cookieOf(headers: Headers): Option[String] =
    headers
      .get(CIString("Set-Cookie"))
      .flatMap(_.toList.headOption)
      .map(_.value.takeWhile(_ != ';'))

  /** 1 ゲームを、作成から最終週の確定まで進める。各要求の計測を返す。 */
  private def playGame(app: HttpApp[IO], finalWeek: Int): IO[List[Sample]] =
    val demand = Json.fromValues(List.fill(finalWeek)(Json.fromInt(4)))
    val createBody = Json.obj(
      "kind" -> Json.fromString("KIT"),
      "finalWeek" -> Json.fromInt(finalWeek),
      "demand" -> demand
    )
    for
      created <- call(app, "createGame", Method.POST, "/api/v1/games", Some(createBody))
      (s0, _, h0) = created
      facilitator = cookieOf(h0)
      gameId = h0
        .get(CIString("Location"))
        .flatMap(_.toList.headOption)
        .map(_.value.split("/").reverse.drop(1).headOption.getOrElse(""))
        .getOrElse("")
      state <- call(
        app,
        "getGameState",
        Method.GET,
        s"/api/v1/games/$gameId/state",
        cookie = facilitator
      )
      code = state._2.hcursor.get[String]("joinCode").getOrElse("")
      players <- roles.zipWithIndex.traverse { (role, i) =>
        for
          j <- call(
            app,
            "joinGame",
            Method.POST,
            "/api/v1/participations/join",
            Some(
              Json.obj(
                "joinCode" -> Json.fromString(code),
                "displayName" -> Json.fromString(s"p$i")
              )
            )
          )
          cookie = cookieOf(j._3)
          st <- call(
            app,
            "getGameState",
            Method.GET,
            s"/api/v1/games/$gameId/state",
            cookie = cookie
          )
          pid = st._2.hcursor.get[String]("participantId").getOrElse("")
          a <- call(
            app,
            "assignRole",
            Method.PUT,
            s"/api/v1/games/$gameId/participants/$pid/role",
            Some(Json.obj("role" -> Json.fromString(role))),
            facilitator
          )
        yield (role, cookie, List(j._1, st._1, a._1))
      }
      start <- call(
        app,
        "startGame",
        Method.POST,
        s"/api/v1/games/$gameId/start",
        Some(Json.obj()),
        facilitator
      )
      weekSamples <- (1 to finalWeek).toList.flatTraverse { w =>
        for
          saves <- players.traverse { (_, cookie, _) =>
            call(
              app,
              "saveDecision",
              Method.PUT,
              s"/api/v1/sessions/$gameId/decisions",
              Some(Json.obj("week" -> Json.fromInt(w), "quantity" -> Json.fromInt(4))),
              cookie,
              Some(0L)
            )
          }
          basis = Json.fromFields(roles.map(_ -> Json.fromLong(1L)))
          commit <- call(
            app,
            "commitWeek",
            Method.POST,
            s"/api/v1/sessions/$gameId/weeks/$w/commit",
            Some(Json.obj("requestedWeek" -> Json.fromInt(w), "basis" -> basis)),
            facilitator
          )
          // 確定の直後に、状態を取得する（反映の確認。NF-P2）
          reflected <- call(
            app,
            "getSessionState",
            Method.GET,
            s"/api/v1/sessions/$gameId/state",
            cookie = facilitator
          )
        yield saves.map(_._1) ++ List(commit._1, reflected._1) ++
          List(
            Sample("commitToReflected", commit._1.millis + reflected._1.millis, reflected._1.status)
          )
      }
      csv <- call(
        app,
        "getExport(csv)",
        Method.GET,
        s"/api/v1/games/$gameId/exports?format=csv",
        cookie = facilitator
      )
      json <- call(
        app,
        "getExport(json)",
        Method.GET,
        s"/api/v1/games/$gameId/exports?format=json",
        cookie = facilitator
      )
      review <- call(
        app,
        "getReview",
        Method.GET,
        s"/api/v1/games/$gameId/review",
        cookie = facilitator
      )
    yield s0 :: state._1 :: players.flatMap(_._3) ++ (start._1 :: weekSamples) ++ List(
      csv._1,
      json._1,
      review._1
    )

  private def percentile(sorted: Vector[Double], p: Double): Double =
    if sorted.isEmpty then 0.0
    else sorted(math.min(sorted.size - 1, math.ceil(p * sorted.size).toInt - 1).max(0))

  private def summarize(title: String, samples: List[Sample]): String =
    val byOp = samples.groupBy(_.operation).toList.sortBy(_._1)
    val lines = byOp.map { (op, xs) =>
      val ms = xs.map(_.millis).toVector.sorted
      val bad = xs.count(s => s.status >= 400)
      f"  $op%-22s n=${xs.size}%5d  p50=${percentile(ms, 0.5)}%8.1f  p95=${percentile(ms, 0.95)}%8.1f  max=${ms.lastOption.getOrElse(0.0)}%8.1f ms  4xx/5xx=$bad%d"
    }
    s"[$title]\n" + lines.mkString("\n") + "\n"

  private def write(name: String, text: String): IO[Unit] =
    IO.blocking {
      val out = Paths.get(s"target/performance-$name.txt")
      val _ = Files.createDirectories(out.toAbsolutePath.getParent)
      val _ = Files.write(out, text.getBytes(StandardCharsets.UTF_8))
    }

  test("[NF-P2・P9・P18] 実 PostgreSQL で、1 ゲームを最終週まで進め、確定から反映・出力・再生の時間を測る") {
    pg.use { env =>
      val app = Routes.httpApp(env)
      for
        samples <- playGame(app, weeks)
        _ <- write(
          "sequential",
          s"規模: ${if full then "全規模" else "小規模"}（最終週 $weeks）\n" + summarize("1 ゲームの逐次", samples)
        )
        errors = samples.count(_.status >= 500)
        reflected = samples.filter(_.operation == "commitToReflected").map(_.millis).toVector.sorted
      yield
        assertEquals(errors, 0)
        // NFR は p95 4 秒（NF-P2）。環境差があるので、同じ値を上限にする
        assert(
          percentile(reflected, 0.95) < 4000.0,
          s"確定から反映が遅い: ${percentile(reflected, 0.95)} ms"
        )
    }
  }

  test("[同時の負荷] 複数のゲームを並行して最終週まで進め、p95 とエラー率を測る") {
    pg.use { env =>
      val app = Routes.httpApp(env)
      for
        t0 <- IO.monotonic
        all <- (1 to games).toList.parTraverse(_ => playGame(app, weeks))
        t1 <- IO.monotonic
        samples = all.flatten
        elapsed = (t1 - t0).toMillis
        _ <- write(
          "concurrent",
          s"規模: ${if full then "全規模" else "小規模"}（$games ゲーム並行・最終週 $weeks）  全体の所要: $elapsed ms\n" +
            summarize("同時の負荷", samples)
        )
        serverErrors = samples.count(_.status >= 500)
      yield assertEquals(serverErrors, 0)
    }
  }
