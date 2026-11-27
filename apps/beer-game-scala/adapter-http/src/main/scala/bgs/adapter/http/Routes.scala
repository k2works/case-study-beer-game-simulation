package bgs.adapter.http

import bgs.application.*
import bgs.domain.*
import cats.data.Kleisli
import cats.effect.IO
import cats.syntax.all.*
import doobie.implicits.*
import io.circe.parser.parse
import io.circe.{Json, JsonObject}
import org.http4s.*
import org.http4s.dsl.Http4sDsl
import org.http4s.headers.`Content-Type`
import org.typelevel.ci.CIString

import java.util.UUID

/** HTTP の経路（API の契約: apps/beer-game-contracts/openapi.yaml）。認可・冪等・problem+json の写像はここに集める。 */
object Routes:
  def httpApp(env: Env): HttpApp[IO] = new Routes(env).app

private final class Routes(env: Env) extends Http4sDsl[IO]:

  private val SessionCookie = "bg_session"
  private val TabIdPattern = "^[A-Za-z0-9]{16,64}$"

  /** 応答の素。ここから `Response` と、冪等の記録を作る。 */
  private final case class Outcome(
      status: Status,
      payload: Json,
      location: Option[String],
      cookies: List[ResponseCookie],
      retryAfter: Option[Int],
      problem: Boolean
  )

  private final case class Ctx(correlation: String, caller: Caller)

  private object UuidVar:
    def unapply(raw: String): Option[UUID] = Either.catchNonFatal(UUID.fromString(raw)).toOption

  private object WeekVar:
    def unapply(raw: String): Option[Int] = raw.toIntOption

  // ---- 共通 ----

  private def cookieName(req: Request[IO]): String =
    req.headers
      .get(CIString("X-Tab-Id"))
      .flatMap(_.toList.headOption)
      .map(_.value)
      .filter(_.matches(TabIdPattern))
      .fold(SessionCookie)(tab => s"${SessionCookie}_$tab")

  private def context(req: Request[IO]): IO[Ctx] =
    for
      generated <- env.gen.uuid
      correlation = req.headers
        .get(CIString("x-correlation-id"))
        .flatMap(_.toList.headOption)
        .map(_.value)
        .filter(value => Either.catchNonFatal(UUID.fromString(value)).isRight)
        .getOrElse(generated.toString)
      // タブ名の Cookie を優先し、無ければ従来名（タブの識別子なしの呼び出し元が発行した資格）を使う（ADR-020）
      token = req.cookies
        .find(_.name == cookieName(req))
        .orElse(req.cookies.find(_.name == SessionCookie))
        .map(_.content)
      caller <- Api.authenticate(env)(token)
    yield Ctx(correlation, caller)

  private def render(outcome: Outcome, correlation: String): Response[IO] =
    val base = Response[IO](outcome.status)
      .withEntity(outcome.payload.noSpaces)
      .withContentType(
        `Content-Type`(
          if outcome.problem then MediaType.unsafeParse("application/problem+json")
          else MediaType.application.json
        )
      )
      .putHeaders(
        Header.Raw(CIString("x-correlation-id"), correlation),
        Header.Raw(CIString("X-Content-Type-Options"), "nosniff"),
        Header.Raw(CIString("Cache-Control"), "no-store")
      )
    val withLocation =
      outcome.location.fold(base)(location =>
        base.putHeaders(Header.Raw(CIString("Location"), location))
      )
    val withRetry = outcome.retryAfter.fold(withLocation)(seconds =>
      withLocation.putHeaders(Header.Raw(CIString("Retry-After"), seconds.toString))
    )
    outcome.cookies.foldLeft(withRetry)((response, cookie) => response.addCookie(cookie))

  private def ok(payload: Json): Outcome =
    Outcome(Status.Ok, payload, None, Nil, None, problem = false)

  private def problem(
      status: Status,
      code: String,
      correlation: String,
      detail: String,
      extra: List[(String, Json)],
      retryAfter: Option[Int]
  ): Outcome =
    Outcome(
      status,
      Json.fromFields(
        List(
          "type" -> Json.fromString(s"/problems/$code"),
          "title" -> Json.fromString(code),
          "status" -> Json.fromInt(status.code),
          "detail" -> Json.fromString(detail),
          "code" -> Json.fromString(code),
          "correlationId" -> Json.fromString(correlation)
        ) ++ extra
      ),
      None,
      Nil,
      retryAfter,
      problem = true
    )

  private def roleList(roles: List[Role]): (String, Json) =
    "missingRoles" -> Json.fromValues(roles.map(r => Json.fromString(JsonViews.roleName(r))))

  private def failureOutcome(failure: AppFailure, correlation: String): Outcome =
    def p(status: Status, code: String, detail: String, extra: List[(String, Json)]) =
      problem(status, code, correlation, detail, extra, None)
    failure match
      case AppFailure.Invalid(errors) =>
        p(
          Status.UnprocessableContent,
          "validation.invalid_input",
          "入力に誤りがあります。",
          List("errors" -> JsonViews.validationErrors(errors))
        )
      case AppFailure.Unauthorized =>
        p(Status.Forbidden, "app.unauthorized", "この操作の権限がありません。", Nil)
      case AppFailure.RetryExhausted | AppFailure.ConcurrencyConflict =>
        problem(
          Status.ServiceUnavailable,
          "app.retry_exhausted",
          correlation,
          "混み合っています。少し待ってからもう一度お試しください。",
          Nil,
          Some(1)
        )
      case AppFailure.RateLimited(retryAfter) =>
        problem(
          Status.TooManyRequests,
          "app.rate_limited",
          correlation,
          "試行が多すぎます。しばらく待ってからもう一度お試しください。",
          Nil,
          Some(retryAfter.toInt)
        )
      case AppFailure.Conflict(error, entries) =>
        val extra = error match
          case SessionError.DecisionConflict(role, _) =>
            List("role" -> Json.fromString(JsonViews.roleName(role))) ++
              entries.get(role).map(e => "latest" -> JsonViews.decisionEntry(e)).toList
          case SessionError.DecisionsChanged(week, _) =>
            List(
              "week" -> Json.fromInt(week.value),
              "current" -> Json.fromFields(
                Role.values.toList.flatMap(r =>
                  entries.get(r).map(e => JsonViews.roleName(r) -> JsonViews.decisionEntry(e))
                )
              )
            )
          case _ => Nil
        p(Status.Conflict, error.code, detailOf(error.code), extra)
      case AppFailure.Persistence(_) =>
        p(Status.InternalServerError, "app.internal", "内部の誤りが起きました。", Nil)
      case AppFailure.Domain(error) =>
        val extra = error match
          case GameError.StartConditionNotMet(missing)       => List(roleList(missing))
          case SessionError.IncompleteDecisions(missing)     => List(roleList(missing))
          case SessionError.WeekAdvanced(requested, current) =>
            List(
              "requestedWeek" -> Json.fromInt(requested.value),
              "currentWeek" -> Json.fromInt(current.value)
            )
          case SessionError.DecisionConflict(role, _) =>
            List("role" -> Json.fromString(JsonViews.roleName(role)))
          case SessionError.DecisionsChanged(week, _) => List("week" -> Json.fromInt(week.value))
          case _                                      => Nil
        error.category match
          case ErrorCategory.Forbidden =>
            if error.code == "game.invitation_invalid" then
              p(Status.Forbidden, error.code, "参加コードが無効です。", Nil)
            else p(Status.Forbidden, "app.unauthorized", "この操作の権限がありません。", Nil)
          case ErrorCategory.NotFound => p(Status.NotFound, error.code, "対象が見つかりません。", extra)
          case ErrorCategory.InvalidState | ErrorCategory.Conflict =>
            p(Status.Conflict, error.code, detailOf(error.code), extra)
          case ErrorCategory.RuleViolation =>
            p(Status.UnprocessableContent, error.code, detailOf(error.code), extra)

  private def detailOf(code: String): String = code match
    case "game.not_preparing"              => "参加の受付を終了しています。"
    case "session.week_advanced"           => "この週はすでに確定されています。"
    case "game.start_condition_not_met"    => "4 つの役割のそれぞれに、参加者が必要です。"
    case "session.incomplete_decisions"    => "4 つの役割の入力がそろっていません。"
    case "game.credential_already_revoked" => "資格はすでに失効しています。"
    case "game.credential_not_revoked"     => "失効していない資格は、再発行できません。"
    case "session.paused"                  => "停止中です。進行役の再開を待ってください。"
    case "session.not_paused"              => "停止中ではありません。"
    case "session.save_limit_reached"      => "この週の保存回数の上限に達しています。"
    case other                             => other

  private def badRequest(correlation: String, detail: String): Outcome =
    problem(Status.BadRequest, "validation.invalid_input", correlation, detail, Nil, None)

  private def shapeError(correlation: String, field: String, message: String): Outcome =
    problem(
      Status.UnprocessableContent,
      "validation.invalid_input",
      correlation,
      "入力に誤りがあります。",
      List(
        "errors" -> Json.arr(
          Json.obj("field" -> Json.fromString(field), "message" -> Json.fromString(message))
        )
      ),
      None
    )

  private def versionsOutcome(result: Either[AppFailure, Versions], correlation: String): Outcome =
    result.fold(failureOutcome(_, correlation), v => ok(JsonViews.commandResponse(v)))

  private def respond(req: Request[IO], ctx: Ctx, outcome: IO[Outcome]): IO[Response[IO]] =
    outcome.map { o =>
      val response = render(o, ctx.correlation)
      // HEAD の応答は、本文を付けない
      if req.method == Method.HEAD then response.withEmptyBody else response
    }

  /** 本文を JSON として読む。JSON として不正なら 400。 */
  private def withJson(req: Request[IO], ctx: Ctx)(
      run: (Json, String) => IO[Outcome]
  ): IO[Outcome] =
    req.bodyText.compile.string.flatMap { text =>
      if text.trim.isEmpty then run(Json.obj(), text)
      else
        parse(text) match
          case Left(_)     => IO.pure(badRequest(ctx.correlation, "JSON として読めません。"))
          case Right(json) => run(json, text)
    }

  /** 匿名の呼び出しを認める経路（作成・参加）用。 */
  private def idempotent(req: Request[IO], ctx: Ctx, bodyText: String)(
      run: IO[Outcome]
  ): IO[Outcome] = idempotentWith(req, ctx, bodyText, IO.pure(true))(run)

  /** 資格のある呼び出しだけが、保存済みの応答を受け取れる（ADR-004。認可を冪等記録の照合より先に置く）。 */
  private def idempotentAuth(req: Request[IO], ctx: Ctx, bodyText: String)(
      run: IO[Outcome]
  ): IO[Outcome] = idempotentWith(req, ctx, bodyText, IO.pure(ctx.caller != Caller.Anonymous))(run)

  /** 変更系は Idempotency-Key が必須。同じキーと同じ要求の再送には、最初の応答を返す。 [[authorized]] が偽なら、照合の前に 403。 */
  private def idempotentWith(
      req: Request[IO],
      ctx: Ctx,
      bodyText: String,
      authorized: IO[Boolean]
  )(
      run: IO[Outcome]
  ): IO[Outcome] =
    authorized.flatMap { allowed =>
      if allowed then idempotentCore(req, ctx, bodyText)(run)
      else IO.pure(failureOutcome(AppFailure.Unauthorized, ctx.correlation))
    }

  private def idempotentCore(req: Request[IO], ctx: Ctx, bodyText: String)(
      run: IO[Outcome]
  ): IO[Outcome] =
    req.headers.get(CIString("Idempotency-Key")).flatMap(_.toList.headOption).map(_.value) match
      case None =>
        IO.pure(shapeError(ctx.correlation, "Idempotency-Key", "Idempotency-Key ヘッダーが必要です。"))
      case Some(key) =>
        val scope = s"${req.method.name}:${req.uri.path.renderString}"
        val requestDigest = Api.digest(s"$scope\n$bodyText")
        env.ports.tx
          .run(
            env.peripheral
              .findIdempotent(scope, key)
              .map(r => Right[Nothing, Option[IdempotentRecord]](r))
          )
          .map(_.merge)
          .flatMap {
            case Some(record) if record.requestDigest == requestDigest =>
              IO.pure(replayed(record))
            case Some(_) =>
              IO.pure(
                problem(
                  Status.Conflict,
                  "app.idempotency_key_reused",
                  ctx.correlation,
                  "同じ Idempotency-Key で、別の内容の要求が送られました。",
                  Nil,
                  None
                )
              )
            case None =>
              run.flatMap { outcome =>
                if outcome.status.isSuccess then
                  env.ports.tx
                    .run(
                      env.peripheral
                        .storeIdempotent(
                          IdempotentRecord(
                            scope,
                            key,
                            requestDigest,
                            outcome.status.code,
                            Json
                              .obj(
                                "location" -> outcome.location.fold(Json.Null)(Json.fromString),
                                // 復帰コードは一度だけ示す。冪等記録には残さない
                                "payload" -> outcome.payload.mapObject(_.remove("recoveryCode"))
                              )
                              .noSpaces
                          )
                        )
                        .map(_ => Right[Nothing, Unit](()))
                    )
                    .as(outcome)
                else IO.pure(outcome)
              }
          }

  private def replayed(record: IdempotentRecord): Outcome =
    val stored = parse(record.body).getOrElse(Json.Null).hcursor
    Outcome(
      Status.fromInt(record.status).getOrElse(Status.Ok),
      stored.downField("payload").focus.getOrElse(Json.Null),
      stored.get[String]("location").toOption,
      Nil,
      None,
      problem = false
    )

  private def sessionCookies(req: Request[IO], token: String): List[ResponseCookie] =
    List(
      ResponseCookie(
        cookieName(req),
        token,
        maxAge = Some(env.sessionTtl.getSeconds),
        path = Some("/"),
        sameSite = Some(SameSite.Strict),
        httpOnly = true
      )
    )

  /** 接続元（ALB の `X-Forwarded-For` の先頭、無ければ接続の相手）。無ければ "local"（同一プロセスの呼び出し）。 */
  private def sourceOf(req: Request[IO]): String =
    req.headers
      .get(CIString("X-Forwarded-For"))
      .flatMap(_.toList.headOption)
      .map(_.value.takeWhile(_ != ',').trim)
      .filter(_.nonEmpty)
      .orElse(req.remoteAddr.map(_.toString))
      .getOrElse("local")

  /** 窓の上限に達していれば、429 を返す。達していなければ [[run]]。 */
  private def gated(req: Request[IO], ctx: Ctx, scope: String)(run: IO[Outcome]): IO[Outcome] =
    Api.attemptBlocked(env)(scope, sourceOf(req)).flatMap {
      case Some(retry) => IO.pure(failureOutcome(AppFailure.RateLimited(retry), ctx.correlation))
      case None        => run
    }

  /** 作成の本文を、入力へ読む。読めない項目（整数でない値・不明な役割名・不明な公開範囲・確定方式）は、項目ごとの誤りとして集める。 */
  private def createInput(json: Json, finalWeek: Int, demand: List[Int]): CreateGameInput =
    val c = json.hcursor
    val cond = c.downField("conditions")
    val present = cond.focus.exists(!_.isNull)
    def intField(name: String): (Option[Int], List[ValidationError]) =
      cond.downField(name).focus.filterNot(_.isNull) match
        case None        => (None, Nil)
        case Some(value) =>
          value.asNumber.flatMap(_.toInt) match
            case Some(n) => (Some(n), Nil)
            case None    =>
              (None, List(ValidationError.ConditionOutOfRange(name, "整数で指定してください")))
    val inventoryEntries =
      cond.downField("initialInventory").focus.flatMap(_.asObject).map(_.toList).getOrElse(Nil)
    val inventory = inventoryEntries.map { (key, value) =>
      (JsonViews.parseRole(key), value.asNumber.flatMap(_.toInt)) match
        case (Some(role), Some(n)) => Right(role -> n)
        case _                     =>
          Left(
            ValidationError.ConditionOutOfRange("initialInventory", "役割ごとの整数で指定してください")
          )
    }
    val (flow, e1) = intField("initialFlow")
    val (order, e2) = intField("orderDelayWeeks")
    val (shipment, e3) = intField("shipmentDelayWeeks")
    val (production, e4) = intField("productionDelayWeeks")
    val (holding, e5) = intField("holdingCostMinor")
    val (backlog, e6) = intField("backlogCostMinor")
    val disclosureRaw = cond.downField("disclosurePolicy").focus.filterNot(_.isNull)
    val disclosure = disclosureRaw.map(v => v.asString.flatMap(JsonViews.parseDisclosure))
    val e7 = disclosure.collect { case None =>
      ValidationError.ConditionOutOfRange("disclosurePolicy", "TEAM_TOTAL か NONE にしてください")
    }.toList
    val modeRaw = c.downField("commitMode").focus.filterNot(_.isNull)
    val mode = modeRaw.map(v => v.asString.flatMap(JsonViews.parseCommitMode))
    val e8 = mode.collect { case None =>
      ValidationError.ConditionOutOfRange("commitMode", "MANUAL か AUTO にしてください")
    }.toList
    CreateGameInput(
      finalWeek,
      demand,
      c.get[Int]("retentionDays").toOption,
      custom = c.get[String]("kind").contains("CUSTOM"),
      conditions = Some(
        CustomConditions(
          inventory.collect { case Right(entry) => entry }.toMap,
          flow,
          order,
          shipment,
          production,
          holding,
          backlog,
          disclosure.flatten
        )
      ).filter(_ => present),
      commitMode = mode.flatten.getOrElse(CommitMode.Manual),
      formErrors = inventory.collect { case Left(e) =>
        e
      } ++ e1 ++ e2 ++ e3 ++ e4 ++ e5 ++ e6 ++ e7 ++ e8
    )

  private def parseUuid(raw: String): Option[UUID] =
    Either.catchNonFatal(UUID.fromString(raw)).toOption

  private val RecoveryCookie = "bg_recovery"

  private def recoveryCookieName(req: Request[IO]): String =
    cookieName(req).replaceFirst(SessionCookie, RecoveryCookie)

  /** 復帰資格の Cookie（復帰の経路だけが読む。ブラウザを閉じても残す）。 */
  private def recoveryCookies(req: Request[IO], token: String): List[ResponseCookie] =
    List(
      ResponseCookie(
        recoveryCookieName(req),
        token,
        maxAge = Some(env.sessionTtl.getSeconds),
        path = Some("/api/v1/participations/recover"),
        sameSite = Some(SameSite.Strict),
        httpOnly = true
      )
    )

  private def recoveryTokenOf(req: Request[IO], body: Json): Option[String] =
    body.hcursor
      .get[String]("recoveryCode")
      .toOption
      .filter(_.nonEmpty)
      .orElse(
        req.cookies
          .find(_.name == recoveryCookieName(req))
          .orElse(req.cookies.find(_.name == RecoveryCookie))
          .map(_.content)
      )

  // ---- 経路 ----

  private val routes: HttpApp[IO] = HttpRoutes
    .of[IO] {
      case GET -> Root / "api" / "v1" / "health" =>
        IO.pure(render(ok(Json.obj("status" -> Json.fromString("ok"))), "-"))

      case GET -> Root / "api" / "v1" / "ready" =>
        context(Request[IO]()).flatMap { ctx =>
          env.ports.tx
            .run(sql"select 1".query[Int].unique.map(_ => Right[Nothing, Unit](())))
            .attempt
            .map {
              case Right(_) =>
                render(ok(Json.obj("status" -> Json.fromString("ok"))), ctx.correlation)
              case Left(_) =>
                render(
                  problem(
                    Status.ServiceUnavailable,
                    "app.not_ready",
                    ctx.correlation,
                    "準備ができていません。",
                    List("checks" -> Json.obj("database" -> Json.False, "notifier" -> Json.True)),
                    None
                  ),
                  ctx.correlation
                )
            }
        }

      case req @ POST -> Root / "api" / "v1" / "games" =>
        context(req).flatMap { ctx =>
          respond(
            req,
            ctx,
            withJson(req, ctx) { (json, text) =>
              idempotent(req, ctx, text) {
                val c = json.hcursor
                (c.get[Int]("finalWeek"), c.get[List[Int]]("demand")) match
                  case (Right(finalWeek), Right(demand)) =>
                    Api
                      .createGame(env)(
                        createInput(json, finalWeek, demand)
                      )
                      .map {
                        case Left(failure)  => failureOutcome(failure, ctx.correlation)
                        case Right(created) =>
                          Outcome(
                            Status.Created,
                            JsonViews
                              .commandResponse(created.versions)
                              .mapObject(
                                _.add("recoveryCode", Json.fromString(created.recoveryToken))
                              ),
                            Some(s"/api/v1/games/${created.gameId.value}/state"),
                            sessionCookies(req, created.facilitatorToken) ++
                              recoveryCookies(req, created.recoveryToken),
                            None,
                            problem = false
                          )
                      }
                  case (Left(_), _) =>
                    IO.pure(shapeError(ctx.correlation, "finalWeek", "最終週は整数で指定してください。"))
                  case (_, Left(_)) =>
                    IO.pure(shapeError(ctx.correlation, "demand", "需要系列は整数の配列で指定してください。"))
              }
            }
          )
        }

      case req @ POST -> Root / "api" / "v1" / "participations" / "join" =>
        context(req).flatMap { ctx =>
          respond(
            req,
            ctx,
            withJson(req, ctx) { (json, text) =>
              gated(req, ctx, "join") {
                idempotent(req, ctx, text) {
                  val c = json.hcursor
                  (c.get[String]("joinCode"), c.get[String]("displayName")) match
                    case (Right(code), Right(name)) =>
                      Api
                        .joinGame(env)(code, name)
                        .flatTap {
                          case Left(AppFailure.Domain(GameError.InvitationInvalid)) =>
                            Api.recordAttemptFailure(env)("join", sourceOf(req))
                          case _ => IO.unit
                        }
                        .map {
                          case Left(failure) => failureOutcome(failure, ctx.correlation)
                          case Right(joined) =>
                            Outcome(
                              Status.Ok,
                              Json.obj(
                                "versions" -> JsonViews.versions(joined.versions),
                                "gameId" -> Json.fromString(joined.gameId.value.toString)
                              ),
                              None,
                              sessionCookies(req, joined.participantToken) ++
                                recoveryCookies(req, joined.recoveryToken),
                              None,
                              problem = false
                            )
                        }
                    case _ =>
                      IO.pure(shapeError(ctx.correlation, "joinCode", "参加コードと表示名は文字列で指定してください。"))
                }
              }
            }
          )
        }

      case req @ GET -> Root / "api" / "v1" / "games" / UuidVar(gameUuid) / "lobby" =>
        context(req).flatMap { ctx =>
          respond(
            req,
            ctx,
            Api
              .lobbyView(env)(ctx.caller, GameId(gameUuid))
              .map(
                _.fold(failureOutcome(_, ctx.correlation), v => ok(JsonViews.lobby(v)))
              )
          )
        }

      case req @ GET -> Root / "api" / "v1" / "games" / UuidVar(gameUuid) / "state" =>
        context(req).flatMap { ctx =>
          respond(
            req,
            ctx,
            Api
              .gameStateView(env)(ctx.caller, GameId(gameUuid))
              .map(
                _.fold(failureOutcome(_, ctx.correlation), v => ok(JsonViews.gameState(v)))
              )
          )
        }

      case req @ PUT -> Root / "api" / "v1" / "games" / UuidVar(
            gameUuid
          ) / "participants" / UuidVar(participantUuid) / "role" =>
        context(req).flatMap { ctx =>
          respond(
            req,
            ctx,
            withJson(req, ctx) { (json, text) =>
              idempotentAuth(req, ctx, text) {
                json.hcursor.get[String]("role").toOption.flatMap(JsonViews.parseRole) match
                  case None =>
                    IO.pure(
                      shapeError(
                        ctx.correlation,
                        "role",
                        "役割は FACTORY・DISTRIBUTOR・WHOLESALER・RETAILER のいずれかで指定してください。"
                      )
                    )
                  case Some(role) =>
                    Api
                      .assignRole(env)(
                        ctx.caller,
                        GameId(gameUuid),
                        ParticipantId(participantUuid),
                        role
                      )
                      .map(versionsOutcome(_, ctx.correlation))
              }
            }
          )
        }

      case req @ POST -> Root / "api" / "v1" / "games" / UuidVar(gameUuid) / "start" =>
        context(req).flatMap { ctx =>
          respond(
            req,
            ctx,
            withJson(req, ctx) { (_, text) =>
              idempotentAuth(req, ctx, text) {
                Api
                  .startGame(env)(ctx.caller, GameId(gameUuid))
                  .map(versionsOutcome(_, ctx.correlation))
              }
            }
          )
        }

      case req @ PUT -> Root / "api" / "v1" / "sessions" / UuidVar(sessionUuid) / "decisions" =>
        context(req).flatMap { ctx =>
          respond(
            req,
            ctx,
            withJson(req, ctx) { (json, text) =>
              idempotentAuth(req, ctx, text) {
                val c = json.hcursor
                val expected = req.headers
                  .get(CIString("If-Match"))
                  .flatMap(_.toList.headOption)
                  .map(_.value.trim.stripPrefix("\"").stripSuffix("\""))
                val expectedVersion = expected.fold(Option(0L))(_.toLongOption)
                (c.get[Int]("week"), c.get[Int]("quantity"), expectedVersion) match
                  case (Right(week), Right(quantity), Some(version)) =>
                    Api
                      .saveDecision(env)(ctx.caller, GameId(sessionUuid), week, quantity, version)
                      .map(versionsOutcome(_, ctx.correlation))
                  case (Left(_), _, _) =>
                    IO.pure(shapeError(ctx.correlation, "week", "週は整数で指定してください。"))
                  case (_, Left(_), _) =>
                    IO.pure(shapeError(ctx.correlation, "quantity", "数量は整数で指定してください。"))
                  case (_, _, None) =>
                    IO.pure(shapeError(ctx.correlation, "If-Match", "If-Match は整数で指定してください。"))
              }
            }
          )
        }

      case req @ POST -> Root / "api" / "v1" / "sessions" / UuidVar(
            sessionUuid
          ) / "weeks" / WeekVar(week) / "commit" =>
        context(req).flatMap { ctx =>
          respond(
            req,
            ctx,
            withJson(req, ctx) { (json, text) =>
              idempotentAuth(req, ctx, text) {
                val c = json.hcursor
                val basis = c.downField("basis")
                val versions = Role.values.toList.traverse(role =>
                  basis.get[Long](JsonViews.roleName(role)).toOption.map(role -> _)
                )
                (c.get[Int]("requestedWeek"), versions) match
                  case (Right(requested), Some(pairs)) if requested == week =>
                    val byRole = pairs.toMap
                    Api
                      .commitWeek(env)(
                        ctx.caller,
                        GameId(sessionUuid),
                        requested,
                        RoleMap.of(role => byRole.getOrElse(role, 0L))
                      )
                      .map(versionsOutcome(_, ctx.correlation))
                  case (Right(_), Some(_)) =>
                    IO.pure(
                      shapeError(ctx.correlation, "requestedWeek", "経路の週と requestedWeek が違います。")
                    )
                  case _ =>
                    IO.pure(
                      shapeError(
                        ctx.correlation,
                        "basis",
                        "requestedWeek と、役割ごとの basis（版）を整数で指定してください。"
                      )
                    )
              }
            }
          )
        }

      case req @ POST -> Root / "api" / "v1" / "sessions" / UuidVar(sessionUuid) / action
          if action == "pause" || action == "resume" =>
        context(req).flatMap { ctx =>
          respond(
            req,
            ctx,
            withJson(req, ctx) { (_, text) =>
              idempotentAuth(req, ctx, text) {
                val run =
                  if action == "pause" then Api.pauseSession(env) else Api.resumeSession(env)
                run(ctx.caller, GameId(sessionUuid)).map(versionsOutcome(_, ctx.correlation))
              }
            }
          )
        }

      case req @ PUT -> Root / "api" / "v1" / "sessions" / UuidVar(
            sessionUuid
          ) / "proxy-decisions" / roleRaw =>
        context(req).flatMap { ctx =>
          respond(
            req,
            ctx,
            withJson(req, ctx) { (json, text) =>
              idempotentAuth(req, ctx, text) {
                val c = json.hcursor
                (
                  JsonViews.parseRole(roleRaw),
                  c.get[Int]("requestedWeek"),
                  c.get[Int]("quantity")
                ) match
                  case (Some(role), Right(week), Right(quantity)) =>
                    Api
                      .submitProxyDecision(env)(
                        ctx.caller,
                        GameId(sessionUuid),
                        role,
                        week,
                        quantity
                      )
                      .map(versionsOutcome(_, ctx.correlation))
                  case (None, _, _) =>
                    IO.pure(shapeError(ctx.correlation, "role", "役割は 4 つの値のいずれかで指定してください。"))
                  case _ =>
                    IO.pure(
                      shapeError(
                        ctx.correlation,
                        "requestedWeek",
                        "requestedWeek と quantity は整数で指定してください。"
                      )
                    )
              }
            }
          )
        }

      case req @ POST -> Root / "api" / "v1" / "participations" / "recover" =>
        context(req).flatMap { ctx =>
          respond(
            req,
            ctx,
            withJson(req, ctx) { (json, text) =>
              json.hcursor.get[String]("gameId").toOption.flatMap(parseUuid) match
                case None =>
                  IO.pure(shapeError(ctx.correlation, "gameId", "gameId は UUID で指定してください。"))
                case Some(gameUuid) =>
                  val token = recoveryTokenOf(req, json)
                  // 復帰資格の有効性が認可。照合の前に確かめる（失効した資格の再送に、保存済みの応答を返さない）
                  val valid = token.fold(IO.pure(false))(value =>
                    for
                      now <- env.gen.now
                      hashed <- Api.tokenDigest(env)(value)
                      found <- hashed.fold(IO.pure(false))(d =>
                        env.ports.tx
                          .run(
                            env.peripheral
                              .resolveRecovery(d, now)
                              .map(r => Right[Nothing, Boolean](r.exists(_._1 == GameId(gameUuid))))
                          )
                          .map(_.merge)
                      )
                    yield found
                  )
                  val checked = valid.flatTap(ok =>
                    if ok then IO.unit else Api.recordAttemptFailure(env)("recover", sourceOf(req))
                  )
                  gated(req, ctx, "recover") {
                    idempotentWith(req, ctx, text, checked) {
                      Api.recover(env)(GameId(gameUuid), token).map {
                        case Left(failure)    => failureOutcome(failure, ctx.correlation)
                        case Right(recovered) =>
                          Outcome(
                            Status.Ok,
                            JsonViews
                              .commandResponse(recovered.versions)
                              .mapObject(
                                _.add("gameId", Json.fromString(recovered.gameId.value.toString))
                                  .add(
                                    "kind",
                                    Json.fromString(
                                      if recovered.facilitator then "FACILITATOR" else "PARTICIPANT"
                                    )
                                  )
                                  .deepMerge(
                                    recovered.role.fold(JsonObject.empty)(r =>
                                      JsonObject("role" -> Json.fromString(JsonViews.roleName(r)))
                                    )
                                  )
                              ),
                            None,
                            sessionCookies(req, recovered.sessionToken),
                            None,
                            problem = false
                          )
                      }
                    }
                  }
            }
          )
        }

      case req @ POST -> Root / "api" / "v1" / "games" / UuidVar(gameUuid) / "credentials" / action
          if action == "revoke" || action == "reissue" =>
        context(req).flatMap { ctx =>
          respond(
            req,
            ctx,
            withJson(req, ctx) { (json, text) =>
              idempotentAuth(req, ctx, text) {
                val subject = json.hcursor.downField("subject")
                (
                  subject.get[String]("kind"),
                  subject.get[String]("id").toOption.flatMap(parseUuid)
                ) match
                  case (Right("PARTICIPANT"), Some(participantUuid)) =>
                    val participant = ParticipantId(participantUuid)
                    if action == "revoke" then
                      Api
                        .revokeCredential(env)(ctx.caller, GameId(gameUuid), participant)
                        .map(versionsOutcome(_, ctx.correlation))
                    else
                      Api.reissueCredential(env)(ctx.caller, GameId(gameUuid), participant).map {
                        case Left(failure)   => failureOutcome(failure, ctx.correlation)
                        case Right(reissued) =>
                          ok(
                            JsonViews
                              .commandResponse(reissued.versions)
                              .mapObject(
                                _.add("recoveryCode", Json.fromString(reissued.recoveryCode))
                                  .add("expiresAt", Json.fromString(reissued.expiresAt.toString))
                              )
                          )
                      }
                  case _ =>
                    IO.pure(
                      shapeError(
                        ctx.correlation,
                        "subject",
                        "subject は kind が PARTICIPANT で、id が UUID のオブジェクトで指定してください。"
                      )
                    )
              }
            }
          )
        }

      case req @ PUT -> Root / "api" / "v1" / "sessions" / UuidVar(sessionUuid) / "commit-mode" =>
        context(req).flatMap { ctx =>
          respond(
            req,
            ctx,
            withJson(req, ctx) { (json, text) =>
              idempotentAuth(req, ctx, text) {
                json.hcursor
                  .get[String]("commitMode")
                  .toOption
                  .flatMap(JsonViews.parseCommitMode) match
                  case Some(mode) =>
                    Api
                      .setCommitMode(env)(ctx.caller, GameId(sessionUuid), mode)
                      .map(versionsOutcome(_, ctx.correlation))
                  case None =>
                    IO.pure(shapeError(ctx.correlation, "commitMode", "MANUAL か AUTO にしてください。"))
              }
            }
          )
        }

      case req @ GET -> Root / "api" / "v1" / "sessions" / UuidVar(sessionUuid) / "state" =>
        context(req).flatMap { ctx =>
          val roleParam = req.params.get("role")
          roleParam.map(raw => JsonViews.parseRole(raw)) match
            case Some(None) =>
              IO.pure(
                render(
                  shapeError(ctx.correlation, "role", "役割は 4 つの値のいずれかで指定してください。"),
                  ctx.correlation
                )
              )
            case other =>
              respond(
                req,
                ctx,
                Api
                  .sessionStateView(env)(ctx.caller, GameId(sessionUuid), other.flatten)
                  .map(
                    _.fold(failureOutcome(_, ctx.correlation), v => ok(JsonViews.sessionState(v)))
                  )
              )
        }
    }
    .orNotFound

  private val UuidPattern =
    "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"

  /** 要求ごとに構造化ログを 1 件出す（AC6.1.1）。相関 ID・操作・結果の状態・所要時間だけを持つ。 資格・表示名・参加コード・非公開の値は含めない（操作は、経路の識別子を
    * `{id}` に落とす）。
    */
  val app: HttpApp[IO] = Kleisli { (req: Request[IO]) =>
    for
      start <- IO.monotonic
      response <- routes.run(req)
      end <- IO.monotonic
      operation = s"${req.method.name} ${req.uri.path.renderString.replaceAll(UuidPattern, "{id}")}"
      correlation = response.headers
        .get(CIString("x-correlation-id"))
        .flatMap(_.toList.headOption)
        .map(_.value)
        .getOrElse("-")
      _ <- env.log.write(
        LogRecord(correlation, operation, response.status.code, (end - start).toMillis)
      )
    yield response
  }
