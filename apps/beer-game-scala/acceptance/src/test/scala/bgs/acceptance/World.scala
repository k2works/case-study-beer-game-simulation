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
final case class Reply(status: Int, json: Json, headers: Headers, body: String):
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
  def header(name: String): Option[String] =
    headers.get(CIString(name)).flatMap(_.toList.headOption).map(_.value)
  def text: String = if json == Json.Null then body else json.noSpaces

/** 1 つのゲームの操作の入口（進行役の資格と参加者の資格を持つ）。 */
final class GameClient(
    val app: HttpApp[IO],
    val env: bgs.application.Env,
    val logs: java.util.concurrent.ConcurrentLinkedQueue[LogRecord],
    val databaseDown: java.util.concurrent.atomic.AtomicBoolean,
    /** 試験用の時計の進み（保持期限の試験。B11）。 */
    val clockOffset: java.util.concurrent.atomic.AtomicReference[java.time.Duration],
    /** 削除の処理を、あと何回失敗させるか。 */
    val deletionFailures: java.util.concurrent.atomic.AtomicInteger,
    /** 再試行をやめたと通知されたゲーム。 */
    val abandoned: java.util.concurrent.ConcurrentLinkedQueue[bgs.domain.GameId]
):
  /** 同じサーバー（DB・時計・障害）を共有する、別のゲームの操作の入口。 */
  def sibling(): GameClient =
    new GameClient(app, env, logs, databaseDown, clockOffset, deletionFailures, abandoned)

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
          Reply(response.status.code, parse(text).getOrElse(Json.Null), response.headers, text)
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
    val offset = new java.util.concurrent.atomic.AtomicReference(java.time.Duration.ZERO)
    val failures = new java.util.concurrent.atomic.AtomicInteger(0)
    val base =
      Wiring.inMemoryH2(LogSink(record => IO.delay(logs.add(record)).void), wrap).unsafeRunSync()
    // 時計を進められるようにし、削除の処理を指定の回数だけ失敗させる（保持と削除の試験）
    val env = base.copy(
      // 保持期限（数日〜）まで時計を進めても、ブラウザセッションが期限切れにならないようにする（本番は 24 時間。失効後は復帰コードで戻る）
      sessionTtl = java.time.Duration.ofDays(365),
      gen = base.gen.copy(now = IO.delay(java.time.Instant.now.plus(offset.get))),
      peripheral = base.peripheral.copy(deleteGame =
        (id, now) =>
          if failures.getAndUpdate(n => math.max(0, n - 1)) > 0 then
            doobie.free.connection.raiseError(new java.sql.SQLException("削除の失敗"))
          else base.peripheral.deleteGame(id, now)
      )
    )
    new GameClient(
      Routes.httpApp(env),
      env,
      logs,
      down,
      offset,
      failures,
      new java.util.concurrent.ConcurrentLinkedQueue[bgs.domain.GameId]()
    )

/** シナリオごとの状態。シナリオが終わると、新しいインスタンスに替わる。 */
final class World:
  var games: List[GameClient] = Nil
  var last: Reply = Reply(0, Json.Null, Headers.empty, "")
  var lastRole: String = ""

  def game: GameClient = games.headOption.getOrElse(sys.error("ゲームが作られていない"))
