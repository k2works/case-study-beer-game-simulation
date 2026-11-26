package bgs.acceptance

import bgs.app.Wiring
import bgs.adapter.http.Routes
import bgs.application.{LogRecord, LogSink, Tx}
import cats.effect.IO
import doobie.ConnectionIO
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

  /** Set-Cookie のうち、名前が [[name]] で始まるものの `name=value`。 */
  def cookieNamed(name: String): Option[String] =
    headers
      .get(CIString("Set-Cookie"))
      .toList
      .flatMap(_.toList)
      .map(_.value.takeWhile(_ != ';'))
      .find(_.startsWith(s"$name="))
  def location: Option[String] =
    headers.get(CIString("Location")).flatMap(_.toList.headOption).map(_.value)
  def code: Option[String] = json.hcursor.get[String]("code").toOption
  def text: String = json.noSpaces

/** 1 つのゲームの操作の入口（進行役の資格と参加者の資格を持つ）。 */
final class GameClient(
    val app: HttpApp[IO],
    val env: bgs.application.Env,
    val logs: java.util.concurrent.ConcurrentLinkedQueue[LogRecord],
    val databaseDown: java.util.concurrent.atomic.AtomicBoolean
):
  var facilitator: Option[String] = None
  var gameId: Option[String] = None

  /** 役割名（FACTORY など）→ 参加者の資格。 */
  var players: Map[String, String] = Map.empty
  var participants: Map[String, String] = Map.empty // 表示名 → participantId
  var participantCookies: Map[String, String] = Map.empty // 表示名 → 資格
  var participantRecoveries: Map[String, String] = Map.empty // 表示名 → 復帰資格の Cookie
  var recoveries: Map[String, String] = Map.empty // 役割名（または FACILITATOR）→ 復帰資格の Cookie
  var recoveryCode: String = "" // 進行役が作成時に控えた復帰コード
  var lastCreateKey: String = ""
  var lastCreateBody: Json = Json.Null

  def call(
      method: Method,
      path: String,
      body: Option[Json],
      cookie: Option[String],
      key: Option[String]
  ): Reply = callWith(method, path, body, cookie, key, Nil)

  def callWith(
      method: Method,
      path: String,
      body: Option[Json],
      cookie: Option[String],
      key: Option[String],
      extra: List[Header.ToRaw]
  ): Reply =
    val base = Request[IO](method, Uri.unsafeFromString(path)).putHeaders(extra*)
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
    val logs = new java.util.concurrent.ConcurrentLinkedQueue[LogRecord]()
    val down = new java.util.concurrent.atomic.AtomicBoolean(false)
    // データベースに接続できない状態を模擬する（書き込み・読み取りの実行が失敗する）
    val wrap: Tx => Tx = underlying =>
      new Tx:
        def run[E, A](program: ConnectionIO[Either[E, A]]): IO[Either[E, A]] =
          IO.delay(down.get).flatMap { isDown =>
            if isDown then IO.raiseError(new java.sql.SQLException("接続できない"))
            else underlying.run(program)
          }
    val env =
      Wiring.inMemoryH2(LogSink(record => IO.delay(logs.add(record)).void), wrap).unsafeRunSync()
    new GameClient(Routes.httpApp(env), env, logs, down)

/** シナリオごとの状態。シナリオが終わると、新しいインスタンスに替わる。 */
final class World:
  var games: List[GameClient] = Nil
  var last: Reply = Reply(0, Json.Null, Headers.empty)
  var lastRole: String = ""

  def game: GameClient = games.headOption.getOrElse(sys.error("ゲームが作られていない"))
