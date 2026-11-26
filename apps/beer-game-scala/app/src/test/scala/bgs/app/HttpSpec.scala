package bgs.app

import bgs.adapter.http.Routes
import bgs.adapter.persistence.{DoobieEventStore, DoobiePeripheralStore, Migrations, Transactions}
import bgs.application.*
import bgs.domain.{GameEvent, GameId, ParticipantId, StreamVersion}
import cats.effect.IO
import cats.syntax.all.*
import doobie.Transactor
import io.circe.Json
import io.circe.parser.parse
import munit.CatsEffectSuite
import org.http4s.*
import org.http4s.circe.*
import org.http4s.implicits.*
import org.typelevel.ci.CIString

import java.time.Duration
import java.util.UUID

/** HTTP（in-process。実 H2 と実際のアダプターをつなぎ、`HttpApp` を直接呼ぶ）。API の契約（openapi.yaml）の B1 の範囲。 */
class HttpSpec extends CatsEffectSuite:

  private val roles = List("FACTORY", "DISTRIBUTOR", "WHOLESALER", "RETAILER")

  private def freshEnv: IO[Env] =
    val url =
      s"jdbc:h2:mem:${UUID.randomUUID.toString};MODE=PostgreSQL;DATABASE_TO_LOWER=TRUE;DB_CLOSE_DELAY=-1"
    Migrations.migrate(url, "sa", "").map { _ =>
      val xa = Transactor.fromDriverManager[IO]("org.h2.Driver", url, "sa", "", None)
      Env(
        Ports(DoobieEventStore.game, DoobieEventStore.session, Transactions.writeTx(xa), 20),
        DoobiePeripheralStore(),
        SystemGenerators.system,
        Duration.ofHours(24),
        LogSink.discard,
        cats.effect.Ref.unsafe[IO, KeyRing](KeyRing.initial("test-secret"))
      )
    }

  private def freshApp: IO[HttpApp[IO]] = freshEnv.map(Routes.httpApp)

  private final case class Reply(status: Int, json: Json, headers: Headers):
    def cookie: Option[String] =
      headers
        .get(CIString("Set-Cookie"))
        .flatMap(_.toList.headOption)
        .map(_.value.takeWhile(_ != ';'))
    def code: Option[String] = json.hcursor.get[String]("code").toOption
    def str(path: String*): Option[String] =
      path.foldLeft(json.hcursor: io.circe.ACursor)(_.downField(_)).as[String].toOption

  private def call(
      app: HttpApp[IO],
      method: Method,
      path: String,
      body: Option[Json] = None,
      cookie: Option[String] = None,
      key: Option[String] = None
  ): IO[Reply] =
    val base = Request[IO](method, Uri.unsafeFromString(path))
    val withBody = body.fold(base)(b => base.withEntity(b)(using jsonEncoderOf[IO, Json]))
    val withCookie =
      cookie.fold(withBody)(c => withBody.putHeaders(Header.Raw(CIString("Cookie"), c)))
    val withKey =
      key.fold(withCookie)(k => withCookie.putHeaders(Header.Raw(CIString("Idempotency-Key"), k)))
    app.run(withKey).flatMap { response =>
      response.bodyText.compile.string.map { text =>
        Reply(response.status.code, parse(text).getOrElse(Json.Null), response.headers)
      }
    }

  private def post(app: HttpApp[IO], path: String, body: Json, cookie: Option[String]) =
    call(app, Method.POST, path, Some(body), cookie, Some(UUID.randomUUID.toString))

  private def put(app: HttpApp[IO], path: String, body: Json, cookie: Option[String]) =
    call(app, Method.PUT, path, Some(body), cookie, Some(UUID.randomUUID.toString))

  private def kitBody(finalWeek: Int = 12): Json =
    Json.obj(
      "kind" -> Json.fromString("KIT"),
      "finalWeek" -> Json.fromInt(finalWeek),
      "demand" -> Json.fromValues(List.fill(finalWeek)(Json.fromInt(4)))
    )

  /** 作成して、進行役の Cookie と参加コードとゲーム ID を返す。 */
  private def create(app: HttpApp[IO]): IO[(String, String, String)] =
    for
      created <- post(app, "/api/v1/games", kitBody(), None)
      _ = assertEquals(created.status, 201)
      cookie = created.cookie.getOrElse(fail("Set-Cookie が無い"))
      gameId = created.headers
        .get(CIString("Location"))
        .flatMap(_.toList.headOption)
        .map(_.value)
        .getOrElse(fail("Location が無い"))
        .split("/")
        .reverse
        .drop(1)
        .headOption
        .getOrElse(fail("gameId"))
      state <- call(app, Method.GET, s"/api/v1/games/$gameId/state", cookie = Some(cookie))
    yield (cookie, gameId, state.str("joinCode").getOrElse(fail(s"joinCode が無い: ${state.json}")))

  private def join(app: HttpApp[IO], code: String, name: String): IO[(String, String)] =
    post(
      app,
      "/api/v1/participations/join",
      Json.obj("joinCode" -> Json.fromString(code), "displayName" -> Json.fromString(name)),
      None
    ).flatMap { r =>
      assertEquals(r.status, 200)
      val cookie = r.cookie.getOrElse(fail("Set-Cookie が無い"))
      val gameId = r.str("gameId").getOrElse(fail("gameId が無い"))
      call(app, Method.GET, s"/api/v1/games/$gameId/state", cookie = Some(cookie)).map { s =>
        (cookie, s.str("participantId").getOrElse(fail(s"participantId が無い: ${s.json}")))
      }
    }

  /** 4 人が参加して役割を割り当て、開始まで済ませる。参加者の Cookie を役割ごとに返す。 */
  private def started(app: HttpApp[IO]): IO[(String, String, Map[String, String])] =
    for
      (facilitator, gameId, code) <- create(app)
      players <- roles.zipWithIndex.traverse { (role, i) =>
        join(app, code, s"参加者$i").flatMap { (cookie, participantId) =>
          put(
            app,
            s"/api/v1/games/$gameId/participants/$participantId/role",
            Json.obj("role" -> Json.fromString(role)),
            Some(facilitator)
          )
            .map { r => assertEquals(r.status, 200, r.json.toString); role -> cookie }
        }
      }
      start <- post(app, s"/api/v1/games/$gameId/start", Json.obj(), Some(facilitator))
      _ = assertEquals(start.status, 200)
    yield (facilitator, gameId, players.toMap)

  test("[AC1.1.1] 作成すると 201 で、進行役の資格（Cookie）と Location を返し、game の版は 1、session は null") {
    freshApp.flatMap { app =>
      post(app, "/api/v1/games", kitBody(), None).map { r =>
        assertEquals(r.status, 201)
        assert(r.cookie.exists(_.startsWith("bg_session=")))
        assertEquals(r.json.hcursor.downField("versions").get[Long]("game").toOption, Some(1L))
        assertEquals(
          r.json.hcursor.downField("versions").downField("session").focus,
          Some(Json.Null)
        )
      }
    }
  }

  test("[AC1.1.1 冪等] 同じ Idempotency-Key で同じ要求を再送しても、ゲームは 1 つのまま") {
    freshApp.flatMap { app =>
      for
        a <- call(app, Method.POST, "/api/v1/games", Some(kitBody()), None, Some("key-1"))
        b <- call(app, Method.POST, "/api/v1/games", Some(kitBody()), None, Some("key-1"))
      yield
        assertEquals(a.status, 201)
        assertEquals(b.status, 201)
        assertEquals(
          a.headers.get(CIString("Location")).map(_.toList.map(_.value)),
          b.headers.get(CIString("Location")).map(_.toList.map(_.value))
        )
    }
  }

  test("[冪等] 同じキーで本文が違う要求は、409 app.idempotency_key_reused") {
    freshApp.flatMap { app =>
      for
        _ <- call(app, Method.POST, "/api/v1/games", Some(kitBody(12)), None, Some("key-2"))
        b <- call(app, Method.POST, "/api/v1/games", Some(kitBody(10)), None, Some("key-2"))
      yield
        assertEquals(b.status, 409)
        assertEquals(b.code, Some("app.idempotency_key_reused"))
    }
  }

  test("[AC1.1.2] 第 5 週の需要が 1001 なら、422 で、対象の週と修正内容を示す") {
    freshApp.flatMap { app =>
      val demand = List(4, 4, 4, 4, 1001, 4, 4, 4, 4, 4, 4, 4).map(Json.fromInt)
      post(
        app,
        "/api/v1/games",
        Json.obj(
          "kind" -> Json.fromString("KIT"),
          "finalWeek" -> Json.fromInt(12),
          "demand" -> Json.fromValues(demand)
        ),
        None
      ).map { r =>
        assertEquals(r.status, 422)
        assertEquals(r.code, Some("validation.invalid_input"))
        val errors = r.json.hcursor.downField("errors").values.map(_.toList).getOrElse(Nil)
        assertEquals(errors.flatMap(_.hcursor.get[Int]("week").toOption), List(5))
        assert(errors.exists(_.hcursor.get[String]("message").exists(_.contains("0 以上 1000 以下"))))
      }
    }
  }

  test("[AC1.2.2] 存在しない参加コードでは 403 game.invitation_invalid（理由は同じ応答）") {
    freshApp.flatMap { app =>
      post(
        app,
        "/api/v1/participations/join",
        Json.obj(
          "joinCode" -> Json.fromString("NOSUCHCODE"),
          "displayName" -> Json.fromString("田中")
        ),
        None
      ).map { r =>
        assertEquals(r.status, 403)
        assertEquals(r.code, Some("game.invitation_invalid"))
      }
    }
  }

  test("[AC1.2.1] 有効な参加コードで参加すると、資格（Cookie）が発行され、ロビーに現れる") {
    freshApp.flatMap { app =>
      for
        (facilitator, gameId, code) <- create(app)
        (_, participantId) <- join(app, code, "田中")
        lobby <- call(app, Method.GET, s"/api/v1/games/$gameId/lobby", cookie = Some(facilitator))
      yield
        assertEquals(lobby.status, 200)
        val participants =
          lobby.json.hcursor.downField("participants").values.map(_.toList).getOrElse(Nil)
        assertEquals(
          participants.flatMap(_.hcursor.get[String]("displayName").toOption),
          List("田中")
        )
        assertEquals(
          participants.flatMap(_.hcursor.get[String]("participantId").toOption),
          List(participantId)
        )
    }
  }

  test("[AC1.2.3] 4 役割のいずれかに参加者がいないまま開始すると、422 で不足している役割を示す") {
    freshApp.flatMap { app =>
      for
        (facilitator, gameId, code) <- create(app)
        three <- List("FACTORY", "WHOLESALER", "RETAILER").traverse { role =>
          join(app, code, role).flatMap((_, pid) =>
            put(
              app,
              s"/api/v1/games/$gameId/participants/$pid/role",
              Json.obj("role" -> Json.fromString(role)),
              Some(facilitator)
            )
          )
        }
        start <- post(app, s"/api/v1/games/$gameId/start", Json.obj(), Some(facilitator))
      yield
        assert(three.forall(_.status == 200))
        assertEquals(start.status, 422)
        assertEquals(start.code, Some("game.start_condition_not_met"))
        assertEquals(
          start.json.hcursor.get[List[String]]("missingRoles").toOption,
          Some(List("DISTRIBUTOR"))
        )
    }
  }

  test("[AC1.2.2] 開始後の参加は 409 game.not_preparing（受付終了）") {
    freshApp.flatMap { app =>
      for
        (facilitator, gameId, _) <- started(app)
        state <- call(app, Method.GET, s"/api/v1/games/$gameId/state", cookie = Some(facilitator))
        late <- post(
          app,
          "/api/v1/participations/join",
          Json.obj(
            "joinCode" -> Json.fromString(state.str("joinCode").getOrElse("")),
            "displayName" -> Json.fromString("山本")
          ),
          None
        )
      yield
        assertEquals(late.status, 409)
        assertEquals(late.code, Some("game.not_preparing"))
    }
  }

  test("[AC2.1.1・AC2.1.3] 自分の役割の状況だけを返し、小売店以外には顧客需要を含めない") {
    freshApp.flatMap { app =>
      for
        (_, gameId, players) <- started(app)
        wholesaler <- call(
          app,
          Method.GET,
          s"/api/v1/sessions/$gameId/state",
          cookie = players.get("WHOLESALER")
        )
        retailer <- call(
          app,
          Method.GET,
          s"/api/v1/sessions/$gameId/state",
          cookie = players.get("RETAILER")
        )
      yield
        assertEquals(wholesaler.status, 200)
        val status = wholesaler.json.hcursor.downField("roleStatus")
        assertEquals(status.get[Long]("inventory").toOption, Some(12L))
        assertEquals(status.get[Long]("orders").toOption, Some(4L))
        assertEquals(status.downField("customerDemand").focus, None)
        assertEquals(wholesaler.json.hcursor.downField("roles").focus, None)
        assertEquals(
          retailer.json.hcursor.downField("roleStatus").get[Long]("customerDemand").toOption,
          Some(4L)
        )
    }
  }

  test("[AC2.1.2] 他の役割の状況を取得しようとすると、403 で、値を返さない") {
    freshApp.flatMap { app =>
      for
        (_, gameId, players) <- started(app)
        other <- call(
          app,
          Method.GET,
          s"/api/v1/sessions/$gameId/state?role=RETAILER",
          cookie = players.get("WHOLESALER")
        )
      yield
        assertEquals(other.status, 403)
        assertEquals(other.json.hcursor.downField("roleStatus").focus, None)
    }
  }

  test("[AC2.2.1・AC2.3.1] 4 役割が保存して、進行役が確定すると、第 2 週になり、結果が記録される") {
    freshApp.flatMap { app =>
      for
        (facilitator, gameId, players) <- started(app)
        saves <- roles.traverse { role =>
          call(
            app,
            Method.PUT,
            s"/api/v1/sessions/$gameId/decisions",
            Some(Json.obj("week" -> Json.fromInt(1), "quantity" -> Json.fromInt(4))),
            players.get(role),
            Some(UUID.randomUUID.toString)
          )
        }
        before <- call(
          app,
          Method.GET,
          s"/api/v1/sessions/$gameId/state",
          cookie = Some(facilitator)
        )
        basis = before.json.hcursor
          .downField("roles")
          .keys
          .map(_.toList)
          .getOrElse(Nil)
          .map(r => r -> Json.fromInt(1))
        commit <- call(
          app,
          Method.POST,
          s"/api/v1/sessions/$gameId/weeks/1/commit",
          Some(Json.obj("requestedWeek" -> Json.fromInt(1), "basis" -> Json.fromFields(basis))),
          Some(facilitator),
          Some(UUID.randomUUID.toString)
        )
        after <- call(
          app,
          Method.GET,
          s"/api/v1/sessions/$gameId/state",
          cookie = Some(facilitator)
        )
      yield
        assert(saves.forall(_.status == 200), saves.map(_.json).toString)
        assertEquals(commit.status, 200, commit.json.toString)
        assertEquals(after.json.hcursor.get[Int]("week").toOption, Some(2))
        assertEquals(after.json.hcursor.downField("results").values.map(_.size), Some(4))
    }
  }

  test("[AC2.2.2] 範囲外（1001）の数量は 422 で保存されない") {
    freshApp.flatMap { app =>
      for
        (_, gameId, players) <- started(app)
        r <- call(
          app,
          Method.PUT,
          s"/api/v1/sessions/$gameId/decisions",
          Some(Json.obj("week" -> Json.fromInt(1), "quantity" -> Json.fromInt(1001))),
          players.get("RETAILER"),
          Some(UUID.randomUUID.toString)
        )
      yield
        assertEquals(r.status, 422)
        assertEquals(r.code, Some("validation.invalid_input"))
    }
  }

  test("[前提] 入力がそろっていない週の確定は、422 session.incomplete_decisions で不足の役割を示す") {
    freshApp.flatMap { app =>
      for
        (facilitator, gameId, players) <- started(app)
        _ <- List("RETAILER", "WHOLESALER", "DISTRIBUTOR").traverse { role =>
          call(
            app,
            Method.PUT,
            s"/api/v1/sessions/$gameId/decisions",
            Some(Json.obj("week" -> Json.fromInt(1), "quantity" -> Json.fromInt(4))),
            players.get(role),
            Some(UUID.randomUUID.toString)
          )
        }
        before <- call(
          app,
          Method.GET,
          s"/api/v1/sessions/$gameId/state",
          cookie = Some(facilitator)
        )
        basis = roles.map(r =>
          r -> Json.fromLong(
            before.json.hcursor
              .downField("roles")
              .downField(r)
              .get[Long]("decisionVersion")
              .getOrElse(0L)
          )
        )
        commit <- call(
          app,
          Method.POST,
          s"/api/v1/sessions/$gameId/weeks/1/commit",
          Some(Json.obj("requestedWeek" -> Json.fromInt(1), "basis" -> Json.fromFields(basis))),
          Some(facilitator),
          Some(UUID.randomUUID.toString)
        )
      yield
        assertEquals(commit.status, 422)
        assertEquals(commit.code, Some("session.incomplete_decisions"))
        assertEquals(
          commit.json.hcursor.get[List[String]]("missingRoles").toOption,
          Some(List("FACTORY"))
        )
    }
  }

  test("[AC2.3.2] 確定済みの週を別の要求で確定しようとすると、409 session.week_advanced") {
    freshApp.flatMap { app =>
      for
        (facilitator, gameId, players) <- started(app)
        _ <- roles.traverse { role =>
          call(
            app,
            Method.PUT,
            s"/api/v1/sessions/$gameId/decisions",
            Some(Json.obj("week" -> Json.fromInt(1), "quantity" -> Json.fromInt(4))),
            players.get(role),
            Some(UUID.randomUUID.toString)
          )
        }
        basis = Json.fromFields(roles.map(_ -> Json.fromInt(1)))
        body = Json.obj("requestedWeek" -> Json.fromInt(1), "basis" -> basis)
        first <- call(
          app,
          Method.POST,
          s"/api/v1/sessions/$gameId/weeks/1/commit",
          Some(body),
          Some(facilitator),
          Some("commit-1")
        )
        replay <- call(
          app,
          Method.POST,
          s"/api/v1/sessions/$gameId/weeks/1/commit",
          Some(body),
          Some(facilitator),
          Some("commit-1")
        )
        again <- call(
          app,
          Method.POST,
          s"/api/v1/sessions/$gameId/weeks/1/commit",
          Some(body),
          Some(facilitator),
          Some("commit-2")
        )
      yield
        assertEquals(first.status, 200)
        assertEquals(replay.status, 200) // 同じ要求の再送は、最初の応答をそのまま返す
        assertEquals(again.status, 409)
        assertEquals(again.code, Some("session.week_advanced"))
    }
  }

  test("[N-H7] 不正な遷移で止まったゲームは、状態の取得は 200、書き込みは 500。他のゲームは動く") {
    freshEnv.flatMap { env =>
      val app = Routes.httpApp(env)
      for
        (facilitator, gameId, code) <- create(app)
        (otherFacilitator, otherGameId, otherCode) <- create(app)
        // decide が作らない列（同じ参加者の二重の参加）を、イベントストアへ直接足して、ゲームを止める
        (_, participantId) <- join(app, code, "田中")
        read <- env.ports.tx.run(
          env.ports.gameStore
            .read(GameId(UUID.fromString(gameId)))
            .map(r => Right[AppFailure, StreamRead[GameEvent]](r))
        )
        _ <- env.ports.tx.run(
          env.ports.gameStore.append(
            GameId(UUID.fromString(gameId)),
            read.map(_.version).getOrElse(StreamVersion.Zero),
            List(
              GameEvent.ParticipantJoined(
                ParticipantId(UUID.fromString(participantId)),
                java.time.Instant.now()
              )
            ),
            java.time.Instant.now()
          )
        )
        state <- call(app, Method.GET, s"/api/v1/games/$gameId/state", cookie = Some(facilitator))
        lobby <- call(app, Method.GET, s"/api/v1/games/$gameId/lobby", cookie = Some(facilitator))
        write <- post(
          app,
          "/api/v1/participations/join",
          Json.obj("joinCode" -> Json.fromString(code), "displayName" -> Json.fromString("鈴木")),
          None
        )
        other <- post(
          app,
          "/api/v1/participations/join",
          Json
            .obj("joinCode" -> Json.fromString(otherCode), "displayName" -> Json.fromString("佐藤")),
          None
        )
      yield
        assertEquals(state.status, 200)
        assertEquals(lobby.status, 200)
        assertEquals(write.status, 500)
        assertEquals(write.code, Some("app.internal"))
        assert(write.json.hcursor.get[String]("correlationId").isRight)
        assertEquals(other.status, 200)
        assert(otherFacilitator.nonEmpty && otherGameId.nonEmpty)
    }
  }

  test("[認可] 資格が無い・別のゲームの資格では、状態を取得できず 403 app.unauthorized") {
    freshApp.flatMap { app =>
      for
        (_, gameId, _) <- started(app)
        (otherFacilitator, _, _) <- create(app)
        none <- call(app, Method.GET, s"/api/v1/games/$gameId/state")
        other <- call(
          app,
          Method.GET,
          s"/api/v1/games/$gameId/state",
          cookie = Some(otherFacilitator)
        )
      yield
        assertEquals((none.status, none.code), (403, Some("app.unauthorized")))
        assertEquals((other.status, other.code), (403, Some("app.unauthorized")))
    }
  }

  test("[AC6.1.4] /health は 200、/ready は 200（データベースに接続できる）") {
    freshApp.flatMap { app =>
      for
        health <- call(app, Method.GET, "/api/v1/health")
        ready <- call(app, Method.GET, "/api/v1/ready")
      yield
        assertEquals(health.status, 200)
        assertEquals(ready.status, 200)
    }
  }

  test("[problem+json] エラーは application/problem+json で、相関 ID を持つ") {
    freshApp.flatMap { app =>
      val request = Request[IO](Method.POST, uri"/api/v1/participations/join")
        .withEntity(
          Json.obj("joinCode" -> Json.fromString("X"), "displayName" -> Json.fromString("a"))
        )(using jsonEncoderOf[IO, Json])
        .putHeaders(Header.Raw(CIString("Idempotency-Key"), "k"))
      app.run(request).flatMap { response =>
        response.as[Json].map { json =>
          assertEquals(
            response.contentType.map(c => s"${c.mediaType.mainType}/${c.mediaType.subType}"),
            Some("application/problem+json")
          )
          assert(json.hcursor.get[String]("correlationId").isRight)
          assertEquals(
            json.hcursor.get[String]("type").toOption,
            Some("/problems/game.invitation_invalid")
          )
        }
      }
    }
  }

  // ---- B4: 停止・再開・代理入力、資格の失効・再発行・復帰、役割の入れ替え ----

  private def sessionPath(gameId: String, suffix: String) = s"/api/v1/sessions/$gameId$suffix"

  test("[AC3.1.1〜3.1.3] 停止中は保存を session.paused で拒否し、代理入力は受け付け、再開で保存できる") {
    freshApp.flatMap { app =>
      for
        (facilitator, gameId, players) <- started(app)
        retailer = players.getOrElse("RETAILER", fail("小売店が無い"))
        paused <- post(app, sessionPath(gameId, "/pause"), Json.obj(), Some(facilitator))
        again <- post(app, sessionPath(gameId, "/pause"), Json.obj(), Some(facilitator))
        saved <- put(
          app,
          sessionPath(gameId, "/decisions"),
          Json.obj("week" -> Json.fromInt(1), "quantity" -> Json.fromInt(4)),
          Some(retailer)
        )
        proxy <- put(
          app,
          sessionPath(gameId, "/proxy-decisions/FACTORY"),
          Json.obj("requestedWeek" -> Json.fromInt(1), "quantity" -> Json.fromInt(6)),
          Some(facilitator)
        )
        state <- call(app, Method.GET, sessionPath(gameId, "/state"), cookie = Some(facilitator))
        resumed <- post(app, sessionPath(gameId, "/resume"), Json.obj(), Some(facilitator))
        notPaused <- post(app, sessionPath(gameId, "/resume"), Json.obj(), Some(facilitator))
        badRole <- put(
          app,
          sessionPath(gameId, "/proxy-decisions/NOBODY"),
          Json.obj("requestedWeek" -> Json.fromInt(1), "quantity" -> Json.fromInt(6)),
          Some(facilitator)
        )
        badBody <- put(
          app,
          sessionPath(gameId, "/proxy-decisions/FACTORY"),
          Json.obj(),
          Some(facilitator)
        )
      yield
        assertEquals(paused.status, 200)
        assertEquals((again.status, again.code), (409, Some("session.paused")))
        assertEquals((saved.status, saved.code), (409, Some("session.paused")))
        assertEquals(proxy.status, 200)
        assertEquals(state.str("status"), Some("PAUSED"))
        assertEquals(resumed.status, 200)
        assertEquals((notPaused.status, notPaused.code), (409, Some("session.not_paused")))
        assert(badRole.status >= 400)
        assert(badBody.status >= 400)
    }
  }

  test("[AC3.2.* 復帰] 進行役の復帰コードで復帰でき、不明・別ゲーム・形式不正は区別せず拒否される") {
    freshApp.flatMap { app =>
      for
        created <- post(app, "/api/v1/games", kitBody(), None)
        code = created.str("recoveryCode").getOrElse(fail("recoveryCode が無い"))
        gameId = created.headers
          .get(CIString("Location"))
          .flatMap(_.toList.headOption)
          .map(_.value.split("/").reverse.drop(1).headOption.getOrElse(""))
          .getOrElse("")
        recovered <- post(
          app,
          "/api/v1/participations/recover",
          Json.obj("gameId" -> Json.fromString(gameId), "recoveryCode" -> Json.fromString(code)),
          None
        )
        unknown <- post(
          app,
          "/api/v1/participations/recover",
          Json
            .obj("gameId" -> Json.fromString(gameId), "recoveryCode" -> Json.fromString("v1.nope")),
          None
        )
        noCode <- post(
          app,
          "/api/v1/participations/recover",
          Json.obj("gameId" -> Json.fromString(gameId)),
          None
        )
        badGame <- post(
          app,
          "/api/v1/participations/recover",
          Json.obj("gameId" -> Json.fromString("not-a-uuid")),
          None
        )
      yield
        assertEquals(recovered.status, 200)
        assertEquals(recovered.str("kind"), Some("FACILITATOR"))
        assert(recovered.cookie.exists(_.startsWith("bg_session=")))
        assertEquals(unknown.status, 403)
        assertEquals(noCode.status, 403)
        assert(badGame.status >= 400)
    }
  }

  test("[AC3.2.5] 失効 → 再発行 → 復帰。失効済みの再失効・未失効の再発行は 409。不正な本文は拒否") {
    freshApp.flatMap { app =>
      for
        (facilitator, gameId, code) <- create(app)
        (participant, participantId) <- join(app, code, "田中")
        subject = Json.obj(
          "subject" -> Json.obj(
            "kind" -> Json.fromString("PARTICIPANT"),
            "id" -> Json.fromString(participantId)
          )
        )
        notRevoked <- post(
          app,
          s"/api/v1/games/$gameId/credentials/reissue",
          subject,
          Some(facilitator)
        )
        revoked <- post(
          app,
          s"/api/v1/games/$gameId/credentials/revoke",
          subject,
          Some(facilitator)
        )
        twice <- post(app, s"/api/v1/games/$gameId/credentials/revoke", subject, Some(facilitator))
        stale <- call(app, Method.GET, s"/api/v1/games/$gameId/state", cookie = Some(participant))
        reissued <- post(
          app,
          s"/api/v1/games/$gameId/credentials/reissue",
          subject,
          Some(facilitator)
        )
        back <- post(
          app,
          "/api/v1/participations/recover",
          Json.obj(
            "gameId" -> Json.fromString(gameId),
            "recoveryCode" -> Json.fromString(reissued.str("recoveryCode").getOrElse(""))
          ),
          None
        )
        badSubject <- post(
          app,
          s"/api/v1/games/$gameId/credentials/revoke",
          Json.obj(),
          Some(facilitator)
        )
      yield
        assertEquals(
          (notRevoked.status, notRevoked.code),
          (409, Some("game.credential_not_revoked"))
        )
        assertEquals(revoked.status, 200)
        assertEquals((twice.status, twice.code), (409, Some("game.credential_already_revoked")))
        assertEquals(stale.status, 403)
        assertEquals(reissued.status, 200)
        assertEquals(back.status, 200)
        assertEquals(back.str("kind"), Some("PARTICIPANT"))
        assert(badSubject.status >= 400)
    }
  }

  test("[AC3.2.5] 開始後に、役割なしの参加者を入れ替えると、旧担当者の資格は失効し、新担当者が保存できる") {
    freshApp.flatMap { app =>
      for
        (facilitator, gameId, code) <- create(app)
        joined <- roles.zipWithIndex.traverse { (role, i) =>
          join(app, code, s"参加者$i").flatMap { (cookie, id) =>
            put(
              app,
              s"/api/v1/games/$gameId/participants/$id/role",
              Json.obj("role" -> Json.fromString(role)),
              Some(facilitator)
            ).map(_ => role -> cookie)
          }
        }
        players = joined.toMap
        (newCookie, newId) <- join(app, code, "佐藤")
        _ <- post(app, s"/api/v1/games/$gameId/start", Json.obj(), Some(facilitator))
        replaced <- put(
          app,
          s"/api/v1/games/$gameId/participants/$newId/role",
          Json.obj("role" -> Json.fromString("RETAILER")),
          Some(facilitator)
        )
        old <- call(
          app,
          Method.GET,
          s"/api/v1/games/$gameId/state",
          cookie = players.get("RETAILER")
        )
        saved <- put(
          app,
          sessionPath(gameId, "/decisions"),
          Json.obj("week" -> Json.fromInt(1), "quantity" -> Json.fromInt(5)),
          Some(newCookie)
        )
      yield
        assertEquals(replaced.status, 200)
        assertEquals(old.status, 403)
        assertEquals(saved.status, 200)
    }
  }

  test("[AC2.2.3・2.1.4] 同じ版からの 2 回目の保存は競合し、最新の入力・保存者・時刻を返す。共同担当の一覧も返る") {
    freshApp.flatMap { app =>
      for
        (facilitator, gameId, code) <- create(app)
        joined <- roles.zipWithIndex.traverse { (role, i) =>
          join(app, code, s"参加者$i").flatMap { (cookie, id) =>
            put(
              app,
              s"/api/v1/games/$gameId/participants/$id/role",
              Json.obj("role" -> Json.fromString(role)),
              Some(facilitator)
            ).map(_ => role -> cookie)
          }
        }
        players = joined.toMap
        retailer = players.getOrElse("RETAILER", fail("小売店が無い"))
        (coCookie, coId) <- join(app, code, "鈴木")
        _ <- put(
          app,
          s"/api/v1/games/$gameId/participants/$coId/role",
          Json.obj("role" -> Json.fromString("RETAILER")),
          Some(facilitator)
        )
        _ <- post(app, s"/api/v1/games/$gameId/start", Json.obj(), Some(facilitator))
        body = (q: Int) => Json.obj("week" -> Json.fromInt(1), "quantity" -> Json.fromInt(q))
        first <- put(app, sessionPath(gameId, "/decisions"), body(5), Some(retailer))
        second <- put(app, sessionPath(gameId, "/decisions"), body(77), Some(coCookie))
        coState <- call(app, Method.GET, sessionPath(gameId, "/state"), cookie = Some(coCookie))
        basis = Json.fromFields(roles.map(_ -> Json.fromLong(0L)))
        stale <- post(
          app,
          sessionPath(gameId, "/weeks/1/commit"),
          Json.obj("requestedWeek" -> Json.fromInt(1), "basis" -> basis),
          Some(facilitator)
        )
      yield
        assertEquals(first.status, 200)
        assertEquals((second.status, second.code), (409, Some("session.decision_conflict")))
        assertEquals(second.json.hcursor.downField("latest").get[Int]("quantity").toOption, Some(5))
        assert(second.json.hcursor.downField("latest").get[String]("savedAt").isRight)
        val coHolders = coState.json.hcursor.downField("coHolders").values.map(_.size)
        assertEquals(coHolders, Some(2))
        assert(coState.json.hcursor.downField("roleStatus").get[String]("decisionSavedAt").isRight)
        assertEquals(stale.status, 409)
    }
  }
