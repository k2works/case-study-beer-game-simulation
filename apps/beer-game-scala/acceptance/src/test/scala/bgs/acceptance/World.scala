package bgs.acceptance

import bgs.app.Wiring
import bgs.adapter.http.Routes
import cats.effect.IO
import cats.effect.unsafe.implicits.global
import io.circe.Json
import io.circe.parser.parse
import org.http4s.*
import org.http4s.circe.*
import org.typelevel.ci.CIString

import java.util.UUID

/** HTTP の応答。 */
final case class Reply(status: Int, json: Json, headers: Headers):
  def cookie: Option[String] =
    headers
      .get(CIString("Set-Cookie"))
      .flatMap(_.toList.headOption)
      .map(_.value.takeWhile(_ != ';'))
  def location: Option[String] =
    headers.get(CIString("Location")).flatMap(_.toList.headOption).map(_.value)
  def code: Option[String] = json.hcursor.get[String]("code").toOption
  def text: String = json.noSpaces

/** 1 つのゲームの操作の入口（進行役の資格と参加者の資格を持つ）。 */
final class GameClient(val app: HttpApp[IO]):
  var facilitator: Option[String] = None
  var gameId: Option[String] = None

  /** 役割名（FACTORY など）→ 参加者の資格。 */
  var players: Map[String, String] = Map.empty
  var participants: Map[String, String] = Map.empty // 表示名 → participantId
  var participantCookies: Map[String, String] = Map.empty // 表示名 → 資格
  var lastCreateKey: String = ""
  var lastCreateBody: Json = Json.Null

  def call(
      method: Method,
      path: String,
      body: Option[Json],
      cookie: Option[String],
      key: Option[String]
  ): Reply =
    val base = Request[IO](method, Uri.unsafeFromString(path))
    val withBody = body.fold(base)(b => base.withEntity(b)(using jsonEncoderOf[IO, Json]))
    val withCookie =
      cookie.fold(withBody)(c => withBody.putHeaders(Header.Raw(CIString("Cookie"), c)))
    val withKey =
      key.fold(withCookie)(k => withCookie.putHeaders(Header.Raw(CIString("Idempotency-Key"), k)))
    app
      .run(withKey)
      .flatMap { response =>
        response.bodyText.compile.string.map { text =>
          Reply(response.status.code, parse(text).getOrElse(Json.Null), response.headers)
        }
      }
      .unsafeRunSync()

  def get(path: String, cookie: Option[String]): Reply = call(Method.GET, path, None, cookie, None)
  def post(path: String, body: Json, cookie: Option[String]): Reply =
    call(Method.POST, path, Some(body), cookie, Some(UUID.randomUUID.toString))
  def put(path: String, body: Json, cookie: Option[String], key: Option[String]): Reply =
    call(Method.PUT, path, Some(body), cookie, key.orElse(Some(UUID.randomUUID.toString)))

object GameClient:
  def fresh(): GameClient =
    val env = Wiring.inMemoryH2.unsafeRunSync()
    new GameClient(Routes.httpApp(env))

/** シナリオごとの状態。シナリオが終わると、新しいインスタンスに替わる。 */
final class World:
  var games: List[GameClient] = Nil
  var last: Reply = Reply(0, Json.Null, Headers.empty)
  var lastRole: String = ""

  def game: GameClient = games.headOption.getOrElse(sys.error("ゲームが作られていない"))
