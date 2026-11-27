package bgs.acceptance

import io.circe.Json
import cats.effect.unsafe.implicits.global
import io.circe.parser.parse
import io.cucumber.scala.{EN, ScalaDsl}
import org.typelevel.ci.CIString

import scala.jdk.CollectionConverters.*

/** 共有の日本語 Gherkin（apps/beer-game-features/）のステップ定義。薄く保ち、業務の規則は持たない。
  * HTTP（in-process）を呼び、応答を確かめる。アプリケーション・永続化は、実際のものを使う（H2）。
  */
class Steps extends ScalaDsl with EN:

  private val world = new World

  private val roleNames: Map[String, String] = Map(
    "工場" -> "FACTORY",
    "一次卸" -> "DISTRIBUTOR",
    "二次卸" -> "WHOLESALER",
    "小売店" -> "RETAILER"
  )
  private val allRoles = List("FACTORY", "DISTRIBUTOR", "WHOLESALER", "RETAILER")

  private def role(label: String): String =
    roleNames.getOrElse(label, sys.error(s"未知の役割: $label"))

  private def demandBody(finalWeek: Int, overrides: Map[Int, Int]): Json =
    Json.obj(
      "kind" -> Json.fromString("KIT"),
      "finalWeek" -> Json.fromInt(finalWeek),
      "demand" -> Json.fromValues(
        (1 to finalWeek).map(w => Json.fromInt(overrides.getOrElse(w, 4)))
      )
    )

  // ---- 操作 ----

  private def createGame(client: GameClient): Reply =
    val body = demandBody(12, Map.empty)
    val key = java.util.UUID.randomUUID.toString
    client.lastCreateKey = key
    client.lastCreateBody = body
    val reply = client.call(org.http4s.Method.POST, "/api/v1/games", Some(body), None, Some(key))
    if reply.status == 201 then
      client.facilitator = reply.cookie
      client.recoveries = client.recoveries.updated(
        "FACILITATOR",
        reply.cookieNamed("bg_recovery").getOrElse("")
      )
      client.recoveryCode = reply.json.hcursor.get[String]("recoveryCode").getOrElse("")
      client.gameId = reply.location.map(_.split("/").reverse.drop(1).headOption.getOrElse(""))
    reply

  private def gamePath(client: GameClient, suffix: String): String =
    s"/api/v1/games/${client.gameId.getOrElse(sys.error("ゲームが無い"))}$suffix"

  private def sessionPath(client: GameClient, suffix: String): String =
    s"/api/v1/sessions/${client.gameId.getOrElse(sys.error("ゲームが無い"))}$suffix"

  private def joinCodeOf(client: GameClient): String =
    client
      .get(gamePath(client, "/state"), client.facilitator)
      .json
      .hcursor
      .get[String]("joinCode")
      .getOrElse(sys.error("参加コードが取れない"))

  private def joinWith(client: GameClient, code: String, name: String): Reply =
    val reply = client.post(
      "/api/v1/participations/join",
      Json.obj("joinCode" -> Json.fromString(code), "displayName" -> Json.fromString(name)),
      None
    )
    if reply.status == 200 then
      val cookie = reply.cookie
      val gameId = reply.json.hcursor.get[String]("gameId").getOrElse("")
      val state = client.get(s"/api/v1/games/$gameId/state", cookie)
      client.participants = client.participants.updated(
        name,
        state.json.hcursor.get[String]("participantId").getOrElse(sys.error("participantId が無い"))
      )
      client.participantCookies = client.participantCookies.updated(name, cookie.getOrElse(""))
      client.participantRecoveries = client.participantRecoveries
        .updated(name, reply.cookieNamed("bg_recovery").getOrElse(""))
    reply

  private def assignRole(client: GameClient, name: String, apiRole: String): Reply =
    val reply = client.put(
      gamePath(
        client,
        s"/participants/${client.participants.getOrElse(name, sys.error(s"未参加: $name"))}/role"
      ),
      Json.obj("role" -> Json.fromString(apiRole)),
      client.facilitator,
      None
    )
    if reply.status == 200 then
      // 共同担当の 2 人目以降は、役割の代表（最初の担当者）の資格を上書きしない。入れ替えは、別のステップで差し替える
      if !client.players.contains(apiRole) then
        client.players =
          client.players.updated(apiRole, client.participantCookies.getOrElse(name, ""))
        client.recoveries =
          client.recoveries.updated(apiRole, client.participantRecoveries.getOrElse(name, ""))
    reply

  private def assignedPlayers(client: GameClient, labels: List[String]): Unit =
    val code = joinCodeOf(client)
    labels.foreach { label =>
      val name = s"参加者の$label"
      val joined = joinWith(client, code, name)
      require(joined.status == 200, s"参加できない: ${joined.text}")
      val assigned = assignRole(client, name, role(label))
      require(assigned.status == 200, s"割り当てられない: ${assigned.text}")
    }

  private def startGame(client: GameClient): Reply =
    client.post(gamePath(client, "/start"), Json.obj(), client.facilitator)

  private def decisionVersions(client: GameClient): Json =
    val roles = client
      .get(sessionPath(client, "/state"), client.facilitator)
      .json
      .hcursor
      .downField("roles")
    Json.fromFields(
      allRoles.map(r =>
        r -> Json.fromLong(roles.downField(r).get[Long]("decisionVersion").getOrElse(0L))
      )
    )

  private def save(client: GameClient, apiRole: String, quantity: Json): Reply =
    client.put(
      sessionPath(client, "/decisions"),
      Json.obj("week" -> Json.fromInt(1), "quantity" -> quantity),
      client.players.get(apiRole),
      None
    )

  private def commit(client: GameClient, week: Int, key: String): Reply =
    client.call(
      org.http4s.Method.POST,
      sessionPath(client, s"/weeks/$week/commit"),
      Some(Json.obj("requestedWeek" -> Json.fromInt(week), "basis" -> decisionVersions(client))),
      client.facilitator,
      Some(key)
    )

  private def stateAs(client: GameClient, apiRole: String, query: String): Reply =
    client.get(sessionPath(client, s"/state$query"), client.players.get(apiRole))

  private def setupStarted(client: GameClient): Unit =
    require(createGame(client).status == 201, "作成できない")
    assignedPlayers(client, List("小売店", "二次卸", "一次卸", "工場"))
    require(startGame(client).status == 200, "開始できない")

  private def inputAll(client: GameClient, inputs: Map[String, Int]): Unit =
    inputs.foreach { (apiRole, quantity) =>
      val reply = save(client, apiRole, Json.fromInt(quantity))
      require(reply.status == 200, s"保存できない: ${reply.text}")
    }

  private def weekOf(client: GameClient): Int =
    client
      .get(sessionPath(client, "/state"), client.facilitator)
      .json
      .hcursor
      .get[Int]("week")
      .getOrElse(sys.error("週が取れない"))

  private def resultsOf(client: GameClient): List[Json] =
    client
      .get(sessionPath(client, "/state"), client.facilitator)
      .json
      .hcursor
      .downField("results")
      .values
      .map(_.toList)
      .getOrElse(Nil)

  // ---- ゲームの作成（US1.1） ----

  Given("""^進行役がゲームを作成していない$""") { () => world.games = List(GameClient.fresh()) }

  When("""^進行役が、有効なキット準拠の設定でゲームを作成する$""") { () =>
    world.last = createGame(world.game)
  }

  Then("""^参加コードの付いた、準備中のゲームが作成される$""") { () =>
    require(world.last.status == 201, s"作成されていない: ${world.last.text}")
    val state = world.game.get(gamePath(world.game, "/state"), world.game.facilitator).json.hcursor
    require(state.get[String]("joinCode").exists(_.nonEmpty), "参加コードが無い")
    require(state.get[String]("status").contains("PREPARING"), "準備中でない")
  }

  Then("""^作成を同じ要求でもう一度送っても、ゲームは 1 つのままである$""") { () =>
    val client = world.game
    val again = client.call(
      org.http4s.Method.POST,
      "/api/v1/games",
      Some(client.lastCreateBody),
      None,
      Some(client.lastCreateKey)
    )
    require(again.status == 201, s"再送が成功していない: ${again.text}")
    require(again.location == world.last.location, "再送で別のゲームになった")
  }

  When("""^進行役が、最終週 (\d+) で第 (\d+) 週の需要が (\d+) の設定でゲームを作成しようとする$""") {
    (finalWeek: Int, week: Int, demand: Int) =>
      world.games = List(GameClient.fresh())
      world.last = world.game.post(
        "/api/v1/games",
        demandBody(finalWeek, Map(week -> demand)),
        None
      )
  }

  Then("""^ゲームは作成されない$""") { () =>
    require(world.last.status == 422, s"作成が拒否されていない: ${world.last.status}")
    require(world.last.cookie.isEmpty, "資格が発行された")
  }

  Then("""^誤りの対象は第 (\d+) 週であり、需要は 0 以上 1000 以下の整数にするという修正内容が示される$""") { (week: Int) =>
    val errors = world.last.json.hcursor.downField("errors").values.map(_.toList).getOrElse(Nil)
    require(
      errors.flatMap(_.hcursor.get[Int]("week").toOption) == List(week),
      s"対象の週が違う: ${world.last.text}"
    )
    require(
      errors.exists(_.hcursor.get[String]("message").exists(m => m.contains("0 以上 1000 以下"))),
      "修正内容が無い"
    )
  }

  // ---- 参加と割り当て（US1.2） ----

  Given("""^進行役が、キット準拠のゲームを作成している$""") { () =>
    world.games = List(GameClient.fresh())
    require(createGame(world.game).status == 201, "作成できない")
  }

  Given("""^4 人の参加者が、小売店、二次卸、一次卸、工場にそれぞれ割り当てられている$""") { () =>
    assignedPlayers(world.game, List("小売店", "二次卸", "一次卸", "工場"))
  }

  Given("""^3 人の参加者が、小売店、二次卸、工場にそれぞれ割り当てられている$""") { () =>
    assignedPlayers(world.game, List("小売店", "二次卸", "工場"))
  }

  Given("""^進行役がゲームを開始している$""") { () =>
    require(startGame(world.game).status == 200, "開始できない")
  }

  When("""^参加者が、有効な参加コードと表示名「(.+)」で参加する$""") { (name: String) =>
    world.last = joinWith(world.game, joinCodeOf(world.game), name)
  }

  Then("""^参加者はロビーに参加している$""") { () =>
    require(world.last.status == 200, s"参加できていない: ${world.last.text}")
    val lobby = world.game.get(gamePath(world.game, "/lobby"), world.game.facilitator)
    require(lobby.status == 200, "ロビーが取れない")
    val names = lobby.json.hcursor
      .downField("participants")
      .values
      .map(_.toList)
      .getOrElse(Nil)
      .flatMap(_.hcursor.get[String]("displayName").toOption)
    require(names.nonEmpty, "ロビーに参加者がいない")
  }

  Then("""^参加者の復帰資格が保存されている$""") { () =>
    val cookie = world.last.cookie
    require(cookie.exists(_.nonEmpty), "資格が発行されていない")
    val state = world.game.get(gamePath(world.game, "/state"), cookie)
    require(state.status == 200, "発行された資格で、状態が取れない")
  }

  When("""^参加者が、存在しない参加コードと表示名「(.+)」で参加しようとする$""") { (name: String) =>
    world.last = joinWith(world.game, "NOSUCHCODE", name)
  }

  When("""^新しい参加者が、そのゲームの参加コードと表示名「(.+)」で参加しようとする$""") { (name: String) =>
    world.last = joinWith(world.game, joinCodeOf(world.game), name)
  }

  Then("""^参加者は参加できない$""") { () =>
    require(world.last.status >= 400, s"参加できてしまった: ${world.last.status}")
    require(world.last.cookie.isEmpty, "資格が発行された")
  }

  Then("""^参加コードが無効であるという理由が示される$""") { () =>
    require(world.last.code.contains("game.invitation_invalid"), s"理由が違う: ${world.last.text}")
  }

  Then("""^参加の受付が終了しているという理由が示される$""") { () =>
    require(world.last.code.contains("game.not_preparing"), s"理由が違う: ${world.last.text}")
  }

  When("""^進行役がゲームを開始しようとする$""") { () => world.last = startGame(world.game) }

  Then("""^ゲームは開始されない$""") { () =>
    require(world.last.status == 422, s"開始が拒否されていない: ${world.last.status}")
  }

  Then("""^不足している役割として(.+)が示される$""") { (label: String) =>
    val missing = world.last.json.hcursor.get[List[String]]("missingRoles").getOrElse(Nil)
    require(missing == List(role(label)), s"不足している役割が違う: $missing")
  }

  Given("""^参加者「(.+)」が(小売店|二次卸)に割り当てられている$""") { (name: String, label: String) =>
    val client = world.game
    require(joinWith(client, joinCodeOf(client), name).status == 200, "参加できない")
    require(assignRole(client, name, role(label)).status == 200, "割り当てられない")
  }

  When("""^進行役が、(.+)を(.+)に割り当てる$""") { (name: String, label: String) =>
    world.last = assignRole(world.game, name, role(label))
  }

  private def lobbyRoles(client: GameClient): Map[String, Option[String]] =
    client
      .get(gamePath(client, "/lobby"), client.facilitator)
      .json
      .hcursor
      .downField("participants")
      .values
      .map(_.toList)
      .getOrElse(Nil)
      .map { p =>
        p.hcursor.get[String]("participantId").getOrElse("") -> p.hcursor
          .get[String]("role")
          .toOption
      }
      .toMap

  Then("""^(.+)は(小売店|二次卸)に割り当てられている$""") { (name: String, label: String) =>
    val client = world.game
    require(
      lobbyRoles(client).get(client.participants.getOrElse(name, "")).flatten.contains(role(label)),
      "割り当てられていない"
    )
  }

  Then("""^(.+)は小売店には割り当てられていない$""") { (name: String) =>
    val client = world.game
    require(
      !lobbyRoles(client).get(client.participants.getOrElse(name, "")).flatten.contains("RETAILER"),
      "小売店に残っている"
    )
  }

  Then("""^小売店から二次卸へ移したことが示される$""") { () =>
    // 付け替えは、割り当ての応答が成功で、役割が小売店から二次卸へ変わったこと（ロビーの投影）で示される
    require(world.last.status == 200, s"付け替えが成功していない: ${world.last.text}")
  }

  // ---- 週次状況（US2.1） ----

  When("""^(.+)の参加者が、自分の役割の状況を取得する$""") { (label: String) =>
    world.lastRole = role(label)
    world.last = stateAs(world.game, role(label), "")
  }

  Then("""^(.+)の在庫、受注残、入荷、受注が返る$""") { (label: String) =>
    val status = world.last.json.hcursor.downField("roleStatus")
    require(world.last.status == 200, s"取得できない: ${world.last.text}")
    require(
      List("inventory", "backlog", "arrivals", "orders").forall(f => status.get[Long](f).isRight),
      s"項目が足りない: ${world.last.text}"
    )
    require(world.last.json.hcursor.get[String]("role").contains(role(label)), "別の役割の状況")
  }

  Then("""^他の役割の値は含まれない$""") { () =>
    require(world.last.json.hcursor.downField("roles").focus.isEmpty, "全役割の値が含まれている")
    require(world.last.json.hcursor.downField("results").focus.isEmpty, "結果が含まれている")
  }

  When("""^(.+)の参加者が、(.+)の状況を取得しようとする$""") { (own: String, other: String) =>
    world.last = stateAs(world.game, role(own), s"?role=${role(other)}")
  }

  Then("""^権限エラーが返る$""") { () =>
    require(world.last.status == 403, s"権限エラーでない: ${world.last.status}")
  }

  Then("""^(.+)の値は返らない$""") { (_: String) =>
    require(world.last.json.hcursor.downField("roleStatus").focus.isEmpty, "値が返っている")
    require(world.last.json.hcursor.downField("roles").focus.isEmpty, "値が返っている")
  }

  Then("""^当週の顧客需要は含まれない$""") { () =>
    require(
      world.last.json.hcursor.downField("roleStatus").downField("customerDemand").focus.isEmpty,
      "顧客需要が含まれている"
    )
  }

  Then("""^将来の週の需要は含まれない$""") { () =>
    val text = world.last.text
    require(!text.contains("\"demand\""), "需要の系列が含まれている")
    require(!text.toLowerCase.contains("future"), "将来の需要が含まれている")
  }

  Then("""^当週の顧客需要が含まれる$""") { () =>
    require(
      world.last.json.hcursor.downField("roleStatus").get[Long]("customerDemand").isRight,
      "顧客需要が含まれていない"
    )
  }

  // ---- 入力（US2.2） ----

  When("""^(.+)の参加者が、当週の数量として (\d+) を保存する$""") { (label: String, quantity: Int) =>
    world.lastRole = role(label)
    world.last = save(world.game, role(label), Json.fromInt(quantity))
  }

  Then("""^当週の(.+)の入力として (\d+) が保存される$""") { (label: String, quantity: Int) =>
    require(world.last.status == 200, s"保存できていない: ${world.last.text}")
    val state = stateAs(world.game, role(label), "")
    require(
      state.json.hcursor.downField("roleStatus").get[Int]("decision").contains(quantity),
      s"保存された値が違う: ${state.text}"
    )
  }

  Then("""^その入力は(発注|生産要請)として扱われる$""") { (kind: String) =>
    // 流通役は発注、生産役（工場）は生産要請（AC2.2.1）。種類は役割から決まる
    val expected = if world.lastRole == "FACTORY" then "生産要請" else "発注"
    require(kind == expected, s"種類が違う: $kind")
  }

  private def quantityJson(raw: String): Json =
    if raw.trim.isEmpty then Json.fromString("") else parse(raw).getOrElse(Json.fromString(raw))

  When("""^(.+)の参加者が、当週の数量として「(.*)」を保存しようとする$""") { (label: String, raw: String) =>
    world.lastRole = role(label)
    world.last = save(world.game, role(label), quantityJson(raw))
  }

  Then("""^数量は保存されない$""") { () =>
    require(world.last.status == 422, s"拒否されていない: ${world.last.status}")
  }

  Then("""^数量の修正方法が示される$""") { () =>
    val errors = world.last.json.hcursor.downField("errors").values.map(_.toList).getOrElse(Nil)
    require(errors.exists(_.hcursor.get[String]("message").exists(_.nonEmpty)), "修正方法が無い")
  }

  Then("""^数量の保存は(受け付けられる|拒否される)$""") { (outcome: String) =>
    val accepted = world.last.status == 200
    require(accepted == (outcome == "受け付けられる"), s"結果が違う: ${world.last.status}")
  }

  // ---- 観測（US6.1。D2: AC6.1.1・6.1.2・6.1.4） ----

  Given("""^参加者が表示名「(.+)」でゲームに参加している$""") { (name: String) =>
    world.games = List(GameClient.fresh())
    require(createGame(world.game).status == 201, "作成できない")
    require(joinWith(world.game, joinCodeOf(world.game), name).status == 200, "参加できない")
  }

  When("""^状況を取得する要求を処理する$""") { () =>
    val client = world.game
    val cookie = client.participantCookies.values.headOption
    world.last = client.get(gamePath(client, "/state"), cookie)
  }

  private def lastLog(client: GameClient): bgs.application.LogRecord =
    client.logs.asScala.toList.lastOption.getOrElse(sys.error("ログが出ていない"))

  Then("""^相関 ID、操作、結果、所要時間を含む構造化ログが出力される$""") { () =>
    val record = lastLog(world.game)
    require(record.correlationId.nonEmpty && record.correlationId != "-", "相関 ID が無い")
    require(record.operation.startsWith("GET "), s"操作が違う: ${record.operation}")
    require(record.status == 200, s"結果が違う: ${record.status}")
    require(record.durationMs >= 0L, "所要時間が無い")
    require(
      world.last.headers
        .get(CIString("x-correlation-id"))
        .exists(_.head.value == record.correlationId),
      "応答の相関 ID と違う"
    )
  }

  Then("""^そのログに、資格、表示名「(.+)」、非公開の値は含まれない$""") { (name: String) =>
    val client = world.game
    val text = client.logs.asScala.toList.map(_.toString).mkString("\n")
    val token =
      client.participantCookies.values.headOption.getOrElse("").dropWhile(_ != '=').drop(1)
    require(token.nonEmpty && !text.contains(token), "資格がログに含まれている")
    require(!text.contains(name), "表示名がログに含まれている")
    require(!text.contains(joinCodeOf(client)), "参加コードがログに含まれている")
  }

  Given("""^アプリケーションが準備できている$""") { () =>
    world.games = List(GameClient.fresh())
    require(world.game.get("/api/v1/ready", None).status == 200, "準備できていない")
  }

  When("""^データベースに接続できなくなる$""") { () => world.game.databaseDown.set(true) }

  Then("""^準備のヘルスチェックは準備できていないことを示す$""") { () =>
    val ready = world.game.get("/api/v1/ready", None)
    require(
      ready.status == 503 && ready.code.contains("app.not_ready"),
      s"準備できていないことを示していない: ${ready.text}"
    )
  }

  Then("""^生存のヘルスチェックは成功のままである$""") { () =>
    require(world.game.get("/api/v1/health", None).status == 200, "生存が失敗している")
  }

  // ---- 週の確定（US2.3） ----

  private def inputsOf(r: Int, w: Int, d: Int, f: Int): Map[String, Int] =
    Map("RETAILER" -> r, "WHOLESALER" -> w, "DISTRIBUTOR" -> d, "FACTORY" -> f)

  Given("""^第 1 週の入力が、小売店 (\d+)、二次卸 (\d+)、一次卸 (\d+)、工場 (\d+) でそろっている$""") {
    (r: Int, w: Int, d: Int, f: Int) => inputAll(world.game, inputsOf(r, w, d, f))
  }

  Given("""^第 1 週の入力が、小売店 (\d+)、二次卸 (\d+)、一次卸 (\d+) であり、工場は未入力である$""") { (r: Int, w: Int, d: Int) =>
    inputAll(world.game, inputsOf(r, w, d, 0) - "FACTORY")
  }

  private var commitKey = ""

  When("""^進行役が第 1 週を確定する$""") { () =>
    commitKey = java.util.UUID.randomUUID.toString
    world.last = commit(world.game, 1, commitKey)
  }

  Given("""^進行役が第 1 週を確定している$""") { () =>
    commitKey = java.util.UUID.randomUUID.toString
    world.last = commit(world.game, 1, commitKey)
    require(world.last.status == 200, s"確定できない: ${world.last.text}")
  }

  Then("""^現在の週は第 2 週になる$""") { () => require(weekOf(world.game) == 2, "第 2 週でない") }

  Then("""^現在の週は第 (\d+) 週のままである$""") { (week: Int) =>
    require(weekOf(world.game) == week, s"第 $week 週でない")
  }

  Then("""^第 1 週の結果が、4 役割のそれぞれについて記録される$""") { () =>
    require(resultsOf(world.game).size == 4, "結果が 4 役割分でない")
  }

  Then("""^第 1 週の結果は 1 回分だけである$""") { () =>
    require(resultsOf(world.game).size == 4, s"結果が 1 回分（4 件）でない: ${resultsOf(world.game).size}")
  }

  Then("""^各役割の参加者が見る状況は、第 2 週のものになる$""") { () =>
    val retailer = stateAs(world.game, "RETAILER", "")
    require(retailer.json.hcursor.get[Int]("week").contains(2), "参加者が見る週が第 2 週でない")
  }

  When("""^進行役が、同じ確定の要求をもう一度送る$""") { () =>
    world.last = world.game.call(
      org.http4s.Method.POST,
      sessionPath(world.game, "/weeks/1/commit"),
      Some(Json.obj("requestedWeek" -> Json.fromInt(1), "basis" -> decisionVersionsAtWeek1())),
      world.game.facilitator,
      Some(commitKey)
    )
  }

  /** 確定の前に見ていた版（各役割 1）。同じ要求の再送は、同じ本文で送る。 */
  private def decisionVersionsAtWeek1(): Json =
    Json.fromFields(allRoles.map(_ -> Json.fromInt(1)))

  When("""^進行役が、新しい要求で第 1 週をもう一度確定しようとする$""") { () =>
    world.last = world.game.call(
      org.http4s.Method.POST,
      sessionPath(world.game, "/weeks/1/commit"),
      Some(Json.obj("requestedWeek" -> Json.fromInt(1), "basis" -> decisionVersionsAtWeek1())),
      world.game.facilitator,
      Some(java.util.UUID.randomUUID.toString)
    )
  }

  Then("""^第 1 週はすでに確定されているという理由で拒否される$""") { () =>
    require(world.last.code.contains("session.week_advanced"), s"理由が違う: ${world.last.text}")
  }

  Given("""^同じ設定の 2 つのゲームが、どちらも開始されている$""") { () =>
    world.games = List(GameClient.fresh(), GameClient.fresh())
    world.games.foreach(setupStarted)
  }

  Given("""^どちらのゲームも、第 1 週の入力が、小売店 (\d+)、二次卸 (\d+)、一次卸 (\d+)、工場 (\d+) でそろっている$""") {
    (r: Int, w: Int, d: Int, f: Int) => world.games.foreach(inputAll(_, inputsOf(r, w, d, f)))
  }

  When("""^どちらのゲームも第 1 週を確定する$""") { () =>
    world.games.foreach { g =>
      require(commit(g, 1, java.util.UUID.randomUUID.toString).status == 200, "確定できない")
    }
  }

  Then("""^2 つのゲームの全役割の状態と費用が一致する$""") { () =>
    val views = world.games.map { g =>
      val roles =
        g.get(sessionPath(g, "/state"), g.facilitator).json.hcursor.downField("roles").focus
      val results = resultsOf(g)
      (roles, results)
    }
    require(views.distinct.size == 1, "2 つのゲームの状態・費用が一致しない")
  }

  When("""^進行役が第 1 週の結果を取得する$""") { () =>
    world.last = world.game.get(sessionPath(world.game, "/state"), world.game.facilitator)
  }

  Then("""^4 役割のそれぞれについて、注文、在庫、受注残、出荷、費用が含まれる$""") { () =>
    val results = resultsOf(world.game)
    require(results.size == 4, "4 役割分の結果が無い")
    require(
      results.forall(r =>
        List("order", "inventory", "backlog", "shipment", "cost").forall(f =>
          r.hcursor.get[Long](f).isRight
        )
      ),
      "項目が足りない"
    )
  }

  When("""^進行役が第 1 週を確定しようとする$""") { () =>
    world.last = commit(world.game, 1, java.util.UUID.randomUUID.toString)
  }

  Then("""^週は確定されない$""") { () =>
    require(world.last.status == 422, s"確定が拒否されていない: ${world.last.status}")
    require(weekOf(world.game) == 1, "週が進んだ")
  }

  Then("""^入力が不足している役割として(.+)が示される$""") { (label: String) =>
    val missing = world.last.json.hcursor.get[List[String]]("missingRoles").getOrElse(Nil)
    require(missing == List(role(label)), s"不足している役割が違う: $missing")
  }

  // ---- 進行の継続（US3.1。B4: AC3.1.1〜3.1.3） ----

  /** 役割の、現在の意思決定の版（進行役の状態から）。 */
  def versionOf(client: GameClient, apiRole: String): Long =
    client
      .get(sessionPath(client, "/state"), client.facilitator)
      .json
      .hcursor
      .downField("roles")
      .downField(apiRole)
      .get[Long]("decisionVersion")
      .getOrElse(0L)

  /** 現在の版を根拠に、指定の週の数量を保存する（競合しない通常の保存）。 */
  private def saveAt(client: GameClient, apiRole: String, week: Int, quantity: Int): Reply =
    client.callWith(
      org.http4s.Method.PUT,
      sessionPath(client, "/decisions"),
      Some(Json.obj("week" -> Json.fromInt(week), "quantity" -> Json.fromInt(quantity))),
      client.players.get(apiRole),
      Some(java.util.UUID.randomUUID.toString),
      List(org.http4s.Header.Raw(CIString("If-Match"), versionOf(client, apiRole).toString))
    )

  private def decisionOf(client: GameClient, apiRole: String): Option[Int] =
    client
      .get(sessionPath(client, "/state"), client.facilitator)
      .json
      .hcursor
      .downField("roles")
      .downField(apiRole)
      .get[Int]("decision")
      .toOption

  private def proxy(client: GameClient, apiRole: String, week: Int, quantity: Int): Reply =
    client.put(
      sessionPath(client, s"/proxy-decisions/$apiRole"),
      Json.obj("requestedWeek" -> Json.fromInt(week), "quantity" -> Json.fromInt(quantity)),
      client.facilitator,
      None
    )

  private def sessionStatus(client: GameClient): String =
    client
      .get(sessionPath(client, "/state"), client.facilitator)
      .json
      .hcursor
      .get[String]("status")
      .getOrElse("")

  private def control(client: GameClient, action: String, cookie: Option[String]): Reply =
    client.post(sessionPath(client, s"/$action"), Json.obj(), cookie)

  Given("""^進行役がセッションを一時停止している$""") { () =>
    world.last = control(world.game, "pause", world.game.facilitator)
    require(world.last.status == 200, s"停止できない: ${world.last.text}")
  }

  When("""^進行役がセッションを一時停止する$""") { () =>
    world.last = control(world.game, "pause", world.game.facilitator)
  }

  When("""^工場の参加者が、セッションを一時停止しようとする$""") { () =>
    world.last = control(world.game, "pause", world.game.players.get("FACTORY"))
  }

  Given("""^進行役がセッションを再開している$""") { () =>
    world.last = control(world.game, "resume", world.game.facilitator)
    require(world.last.status == 200, s"再開できない: ${world.last.text}")
  }

  When("""^進行役がセッションを再開する$""") { () =>
    world.last = control(world.game, "resume", world.game.facilitator)
  }

  Then("""^停止中であるという理由で拒否される$""") { () =>
    require(world.last.status == 409, s"409 でない: ${world.last.status}")
    require(world.last.code.contains("session.paused"), s"理由が違う: ${world.last.text}")
  }

  Then("""^セッションの状態は(停止中|進行中)である$""") { (label: String) =>
    val expected = if label == "停止中" then "PAUSED" else "ACTIVE"
    require(sessionStatus(world.game) == expected, s"状態が違う: ${sessionStatus(world.game)}")
  }

  Then("""^当週の(.+)の入力は (\d+) のまま残っている$""") { (label: String, quantity: Int) =>
    require(decisionOf(world.game, role(label)).contains(quantity), s"入力が違う: $label")
  }

  Then("""^当週の(.+)の入力は保存されていない$""") { (label: String) =>
    require(decisionOf(world.game, role(label)).isEmpty, s"保存されている: $label")
  }

  Given("""^(.+)の参加者が、第 (\d+) 週の数量として (\d+) を保存している$""") {
    (label: String, week: Int, quantity: Int) =>
      val reply = saveAt(world.game, role(label), week, quantity)
      require(reply.status == 200, s"保存できない: ${reply.text}")
  }

  Then("""^(.+)の参加者が、第 (\d+) 週の数量として (\d+) を保存できる$""") {
    (label: String, week: Int, quantity: Int) =>
      val reply = saveAt(world.game, role(label), week, quantity)
      require(reply.status == 200, s"保存できない: ${reply.text}")
  }

  When("""^進行役が、(.+)の代理入力として (\d+) を入力する$""") { (label: String, quantity: Int) =>
    world.last = proxy(world.game, role(label), 1, quantity)
  }

  Given("""^進行役が、(.+)の代理入力として (\d+) を入力している$""") { (label: String, quantity: Int) =>
    world.last = proxy(world.game, role(label), 1, quantity)
    require(world.last.status == 200, s"代理入力できない: ${world.last.text}")
  }

  When("""^(.+)の参加者が、(.+)の代理入力として (\d+) を入力しようとする$""") {
    (_: String, label: String, quantity: Int) =>
      world.last = client403(world.game, role(label), quantity)
  }

  private def client403(client: GameClient, apiRole: String, quantity: Int): Reply =
    client.put(
      sessionPath(client, s"/proxy-decisions/$apiRole"),
      Json.obj("requestedWeek" -> Json.fromInt(1), "quantity" -> Json.fromInt(quantity)),
      client.players.get(apiRole),
      None
    )

  When("""^進行役が、第 (\d+) 週の画面を見たまま、(.+)の代理入力として (\d+) を入力しようとする$""") {
    (week: Int, label: String, quantity: Int) =>
      world.last = proxy(world.game, role(label), week, quantity)
  }

  Then("""^(.+)の代理入力 (\d+) が受け付けられる$""") { (label: String, quantity: Int) =>
    require(world.last.status == 200, s"受け付けられていない: ${world.last.text}")
    require(decisionOf(world.game, role(label)).contains(quantity), "値が違う")
  }

  Then("""^第 (\d+) 週の結果はまだ記録されていない$""") { (_: Int) =>
    require(resultsOf(world.game).isEmpty, "結果が記録されている")
  }

  Then("""^第 (\d+) 週はすでに確定されているという理由で、代理入力は拒否される$""") { (_: Int) =>
    require(world.last.code.contains("session.week_advanced"), s"理由が違う: ${world.last.text}")
  }

  private def auditedEvents(client: GameClient): List[bgs.domain.SessionEvent] =
    val id = bgs.domain.GameId(java.util.UUID.fromString(client.gameId.getOrElse("")))
    client.env.ports.tx
      .run[Nothing, List[bgs.domain.SessionEvent]](
        client.env.ports.sessionStore.read(id).map(r => Right(r.events))
      )
      .unsafeRunSync()
      .getOrElse(Nil)

  Then("""^監査履歴に、操作者が進行役、役割が(.+)、値が (\d+) の代理入力が残っている$""") { (label: String, quantity: Int) =>
    require(
      auditedEvents(world.game).exists {
        case bgs.domain.SessionEvent
              .DecisionSaved(_, r, q, _, bgs.domain.Editor.ByFacilitator(_), _) =>
          r.toString.equalsIgnoreCase(role(label)) && q.value == quantity
        case _ => false
      },
      "監査履歴に代理入力が無い"
    )
  }

  Then("""^その代理入力の時刻が記録されている$""") { () =>
    // 時刻（occurred_at）は NOT NULL の列で、追記の入力に必ず含まれる（V001）。イベントが読めることをもって確かめる
    require(auditedEvents(world.game).nonEmpty, "イベントが読めない")
  }

  private def saveTimes(client: GameClient, times: Int): Unit =
    (1 to times).foreach { n =>
      val reply = saveAt(client, "RETAILER", 1, n)
      require(reply.status == 200, s"$n 回目の保存ができない: ${reply.text}")
    }

  Given("""^小売店の参加者が、当週の数量を (\d+) 回保存している$""") { (times: Int) =>
    saveTimes(world.game, times)
  }

  When("""^小売店の参加者が、当週の数量をもう 1 回保存しようとする$""") { () =>
    world.last = saveAt(world.game, "RETAILER", 1, 9)
  }

  Then("""^保存回数の上限に達しているという理由で拒否される$""") { () =>
    require(world.last.code.contains("session.save_limit_reached"), s"理由が違う: ${world.last.text}")
  }

  // ---- 復帰（US3.2。B4: AC3.2.1〜3.2.4） ----

  private def recoverReply(
      client: GameClient,
      cookie: Option[String],
      code: Option[String]
  ): Reply =
    val gameId = client.gameId.getOrElse(sys.error("ゲームが無い"))
    val body = Json.fromFields(
      List("gameId" -> Json.fromString(gameId)) ++
        code.map(c => "recoveryCode" -> Json.fromString(c))
    )
    client.post("/api/v1/participations/recover", body, cookie)

  private def recoverAs(label: String): Reply =
    val reply = recoverReply(world.game, world.game.recoveries.get(label), None)
    reply.cookieNamed("bg_session").foreach { c =>
      if label == "FACILITATOR" then world.game.facilitator = Some(c)
      else world.game.players = world.game.players.updated(label, c)
    }
    reply

  Given("""^(.+)の参加者のブラウザセッションが失われている$""") { (label: String) =>
    world.game.players = world.game.players - role(label)
  }

  Given("""^進行役のブラウザセッションが失われている$""") { () => world.game.facilitator = None }

  Given("""^進行役のブラウザセッションと復帰資格が失われている$""") { () =>
    world.game.facilitator = None
    world.game.recoveries = world.game.recoveries - "FACILITATOR"
  }

  When("""^(.+)の参加者が、復帰資格で再接続(する|しようとする)$""") { (label: String, _: String) =>
    world.lastRole = role(label)
    world.last = recoverAs(role(label))
  }

  When("""^進行役が、復帰資格で再接続する$""") { () => world.last = recoverAs("FACILITATOR") }

  When("""^進行役が、作成時に控えた復帰コードで再接続する$""") { () =>
    world.last = recoverReply(world.game, None, Some(world.game.recoveryCode))
    world.last.cookieNamed("bg_session").foreach(c => world.game.facilitator = Some(c))
  }

  Then("""^同じゲームの(.+)として復帰する$""") { (label: String) =>
    require(world.last.status == 200, s"復帰できない: ${world.last.text}")
    val c = world.last.json.hcursor
    require(c.get[String]("gameId").contains(world.game.gameId.getOrElse("")), "ゲームが違う")
    require(c.get[String]("kind").contains("PARTICIPANT"), "参加者でない")
    require(c.get[String]("role").contains(role(label)), s"役割が違う: ${world.last.text}")
  }

  Then("""^最新の状況に、保存済みの入力 (\d+) が含まれる$""") { (quantity: Int) =>
    val state = stateAs(world.game, world.lastRole, "")
    require(
      state.json.hcursor.downField("roleStatus").get[Int]("decision").contains(quantity),
      s"入力が違う: ${state.text}"
    )
  }

  /** Cookie（`名前=値`）の値の、鍵付きダイジェスト。 */
  private def tokenDigestOf(client: GameClient, cookie: Option[String]): String =
    bgs.application.Api
      .tokenDigest(client.env)(cookie.getOrElse("").dropWhile(_ != '=').drop(1))
      .unsafeRunSync()
      .getOrElse("")

  private def forceRecovery(label: String, sql: String => doobie.ConnectionIO[Int]): Unit =
    val digest = tokenDigestOf(world.game, world.game.recoveries.get(label))
    world.game.env.ports.tx
      .run[Nothing, Int](sql(digest).map(Right(_)))
      .unsafeRunSync()
      .fold(_ => (), updated => require(updated > 0, "復帰資格の行が更新されない"))

  Given("""^(.+)の参加者の復帰資格が「(不明|失効|期限切れ)」になっている$""") { (label: String, state: String) =>
    import doobie.implicits.*
    val apiRole = role(label)
    world.lastRole = apiRole
    state match
      case "不明" =>
        world.game.recoveries = world.game.recoveries.updated(apiRole, "bg_recovery=unknown-token")
      case "失効" =>
        val reply = revokeAs(world.game, world.game.participants.getOrElse(s"参加者の$label", ""))
        require(reply.status == 200, s"失効できない: ${reply.text}")
      case _ =>
        forceRecovery(
          apiRole,
          d =>
            sql"update recovery_credentials set expires_at = timestamp '2000-01-01 00:00:00+00' where token_digest = $d".update.run
        )
  }

  Then("""^復帰は拒否される$""") { () =>
    require(world.last.status == 403, s"拒否されていない: ${world.last.status}")
  }

  Then("""^拒否の応答は、不明な復帰資格のときと同じである$""") { () =>
    val unknown = recoverReply(world.game, Some("bg_recovery=unknown-other"), None)
    def shape(r: Reply) = r.json.hcursor.downField("correlationId").delete.top.map(_.noSpaces)
    require(shape(unknown) == shape(world.last), s"応答が違う: ${unknown.text} / ${world.last.text}")
  }

  Then("""^新しいブラウザセッションは発行されない$""") { () =>
    require(world.last.cookieNamed("bg_session").isEmpty, "ブラウザセッションが発行された")
  }

  Given("""^(.+)の参加者が、2 つのタブで第 (\d+) 週の画面を開いている$""") { (_: String, _: Int) =>
    () // 2 つのタブは、同じ資格（Cookie）を使う。古い画面の保存は、版（requestedWeek）で拒否される
  }

  When("""^(.+)の参加者の古いタブが、第 (\d+) 週の数量として (\d+) を保存しようとする$""") {
    (label: String, week: Int, quantity: Int) =>
      world.last = saveAt(world.game, role(label), week, quantity)
      world.lastRole = role(label)
  }

  Then("""^古いタブの保存は、第 (\d+) 週はすでに確定されているという理由で拒否される$""") { (_: Int) =>
    require(world.last.code.contains("session.week_advanced"), s"理由が違う: ${world.last.text}")
  }

  Then("""^(.+)の参加者のもう一方のタブは、最新の状況として第 (\d+) 週を表示する$""") { (label: String, week: Int) =>
    val state = stateAs(world.game, role(label), "")
    require(state.json.hcursor.get[Int]("week").contains(week), s"週が違う: ${state.text}")
  }

  When("""^進行役が、画面を再読み込みする$""") { () =>
    world.last = world.game.get(sessionPath(world.game, "/state"), world.game.facilitator)
  }

  Then("""^同じゲームの進行コンソールが表示される$""") { () =>
    require(world.last.status == 200, s"表示できない: ${world.last.text}")
    val c = world.last.json.hcursor
    val sameGame = c.get[String]("gameId").orElse(c.get[String]("sessionId"))
    require(sameGame.contains(world.game.gameId.getOrElse("")), "ゲームが違う")
    require(c.get[String]("kind").forall(_ == "FACILITATOR"), "進行役でない")
  }

  private def revokeAs(client: GameClient, participantId: String): Reply =
    client.post(
      gamePath(client, "/credentials/revoke"),
      Json.obj(
        "subject" -> Json.obj(
          "kind" -> Json.fromString("PARTICIPANT"),
          "id" -> Json.fromString(participantId)
        )
      ),
      client.facilitator
    )

  // ---- 資格の失効・再発行（AC3.2.5） ----

  /** 準備中でも取れる、参加者の画面の状態（ゲームの状態）。 */
  private def gameStateAs(client: GameClient, apiRole: String): Reply =
    client.get(gamePath(client, "/state"), client.players.get(apiRole))

  private def participantIdOf(client: GameClient, label: String): String =
    client.participants.getOrElse(s"参加者の$label", sys.error(s"未参加: $label"))

  private def revokeWith(
      client: GameClient,
      gameId: String,
      participantId: String,
      cookie: Option[String]
  ): Reply =
    client.post(
      s"/api/v1/games/$gameId/credentials/revoke",
      Json.obj(
        "subject" -> Json.obj(
          "kind" -> Json.fromString("PARTICIPANT"),
          "id" -> Json.fromString(participantId)
        )
      ),
      cookie
    )

  private def reissueAs(client: GameClient, participantId: String): Reply =
    client.post(
      gamePath(client, "/credentials/reissue"),
      Json.obj(
        "subject" -> Json.obj(
          "kind" -> Json.fromString("PARTICIPANT"),
          "id" -> Json.fromString(participantId)
        )
      ),
      client.facilitator
    )

  private var reissuedCode = ""

  Then("""^応答に、参加したゲームの ID が含まれる$""") { () =>
    require(
      world.last.json.hcursor.get[String]("gameId").contains(world.game.gameId.getOrElse("")),
      s"ゲームの ID が無い: ${world.last.text}"
    )
  }

  When("""^進行役が、(.+)の参加者の資格を失効させ(?:る|ようとする)$""") { (label: String) =>
    world.lastRole = role(label)
    world.last = revokeAs(world.game, participantIdOf(world.game, label))
  }

  Given("""^進行役が、(.+)の参加者の資格を失効させている$""") { (label: String) =>
    world.last = revokeAs(world.game, participantIdOf(world.game, label))
    require(world.last.status == 200, s"失効できない: ${world.last.text}")
  }

  Then("""^失効が受け付けられる$""") { () =>
    require(world.last.status == 200, s"失効できていない: ${world.last.text}")
  }

  Then("""^(.+)の参加者は、復帰資格で復帰できない$""") { (label: String) =>
    require(recoverAs(role(label)).status == 403, "復帰できてしまう")
  }

  Then("""^(.+)の参加者は、以前のブラウザセッションでも状況を取得できない$""") { (label: String) =>
    require(gameStateAs(world.game, role(label)).status == 403, "状況を取得できてしまう")
  }

  Then("""^(.+)の参加者の資格には影響しない$""") { (label: String) =>
    require(recoverAs(role(label)).status == 200, "影響している（復帰）")
    require(gameStateAs(world.game, role(label)).status == 200, "影響している（状況）")
  }

  When("""^進行役が、(.+)の参加者の資格を再発行する$""") { (label: String) =>
    world.last = reissueAs(world.game, participantIdOf(world.game, label))
    reissuedCode = world.last.json.hcursor.get[String]("recoveryCode").getOrElse("")
  }

  Given("""^進行役が、(.+)の参加者の資格を再発行している$""") { (label: String) =>
    world.last = reissueAs(world.game, participantIdOf(world.game, label))
    require(world.last.status == 200, s"再発行できない: ${world.last.text}")
    reissuedCode = world.last.json.hcursor.get[String]("recoveryCode").getOrElse("")
  }

  Then("""^再発行が受け付けられる$""") { () =>
    require(world.last.status == 200, s"再発行できていない: ${world.last.text}")
  }

  Then("""^新しい復帰コードと、現在より後の有効期限が示される$""") { () =>
    val c = world.last.json.hcursor
    require(c.get[String]("recoveryCode").exists(_.nonEmpty), "復帰コードが無い")
    require(
      c.get[String]("expiresAt")
        .toOption
        .exists(t => java.time.Instant.parse(t).isAfter(java.time.Instant.now)),
      "有効期限が現在より後でない"
    )
  }

  private def recoverWithCode(label: String): Reply =
    val reply = recoverReply(world.game, None, Some(reissuedCode))
    reply.cookieNamed("bg_session").foreach { c =>
      world.game.players = world.game.players.updated(role(label), c)
    }
    reply

  Then("""^(.+)の参加者は、新しい復帰コードで同じゲームの(.+)として復帰できる$""") { (label: String, _: String) =>
    val reply = recoverWithCode(label)
    require(reply.status == 200, s"復帰できない: ${reply.text}")
    require(reply.json.hcursor.get[String]("role").contains(role(label)), "役割が違う")
  }

  Then("""^(.+)の参加者は、失効した古い復帰資格では復帰できない$""") { (label: String) =>
    require(recoverAs(role(label)).status == 403, "古い復帰資格で復帰できてしまう")
  }

  Given("""^ゲームは「(準備中|開始後)」である$""") { (phase: String) =>
    if phase == "開始後" then require(startGame(world.game).status == 200, "開始できない")
  }

  When("""^(.+)の参加者が、新しい復帰コードで復帰する$""") { (label: String) =>
    world.last = recoverWithCode(label)
  }

  Then("""^資格はすでに失効しているという理由で拒否される$""") { () =>
    require(world.last.status == 409, s"409 でない: ${world.last.status}")
    require(
      world.last.code.contains("game.credential_already_revoked"),
      s"理由が違う: ${world.last.text}"
    )
  }

  When("""^(.+)の参加者が、(.+)の参加者の資格を失効させようとする$""") { (actor: String, target: String) =>
    world.last = revokeWith(
      world.game,
      world.game.gameId.getOrElse(""),
      participantIdOf(world.game, target),
      world.game.players.get(role(actor))
    )
  }

  Then("""^(.+)の参加者の資格は、?(?:有効なままである|失効していない)$""") { (label: String) =>
    require(recoverAs(role(label)).status == 200, "失効している（復帰）")
    require(gameStateAs(world.game, role(label)).status == 200, "失効している（状況）")
  }

  private var otherGame: Option[GameClient] = None

  Given("""^別のゲームの進行役がいる$""") { () =>
    val other = new GameClient(
      world.game.app,
      world.game.env,
      world.game.logs,
      world.game.databaseDown
    )
    require(createGame(other).status == 201, "別のゲームを作成できない")
    otherGame = Some(other)
  }

  When("""^別のゲームの進行役が、(.+)の参加者の資格を失効させようとする$""") { (label: String) =>
    world.last = revokeWith(
      world.game,
      world.game.gameId.getOrElse(""),
      participantIdOf(world.game, label),
      otherGame.flatMap(_.facilitator)
    )
  }

  Given("""^(.+)の参加者のブラウザセッションの有効期限が切れている$""") { (label: String) =>
    import doobie.implicits.*
    val d = tokenDigestOf(world.game, world.game.players.get(role(label)))
    world.game.env.ports.tx
      .run[Nothing, Int](
        sql"update browser_sessions set expires_at = timestamp '2000-01-01 00:00:00+00' where token_digest = $d".update.run
          .map(Right(_))
      )
      .unsafeRunSync()
      .fold(_ => (), n => require(n > 0, "ブラウザセッションの行が更新されない"))
  }

  When("""^(.+)の参加者が、期限が切れた資格で状況を取得しようとする$""") { (label: String) =>
    world.last = gameStateAs(world.game, role(label))
  }

  // 冪等キー付きの保存（ADR-004: 認可は冪等記録の照合より前）
  private var keyedSave: Option[(String, Json, Option[String], String)] = None

  private def sendKeyedSave(): Reply =
    val (path, body, cookie, key) = keyedSave.getOrElse(sys.error("保存の要求が無い"))
    world.game.callWith(org.http4s.Method.PUT, path, Some(body), cookie, Some(key), Nil)

  private def keyedSaveOf(label: String, week: Int, quantity: Int): Reply =
    val body = Json.obj("week" -> Json.fromInt(week), "quantity" -> Json.fromInt(quantity))
    keyedSave = Some(
      (
        sessionPath(world.game, "/decisions"),
        body,
        world.game.players.get(role(label)),
        java.util.UUID.randomUUID.toString
      )
    )
    sendKeyedSave()

  Given("""^(.+)の参加者が、(?:冪等キー付きで|識別子つきで)第 (\d+) 週の数量(?:として)? (\d+) を保存している$""") {
    (label: String, week: Int, quantity: Int) =>
      val reply = keyedSaveOf(label, week, quantity)
      require(reply.status == 200, s"保存できない: ${reply.text}")
  }

  When("""^(.+)の参加者が、以前に成功した保存の要求を、同じキーでもう一度送る$""") { (_: String) =>
    world.last = sendKeyedSave()
  }

  Then("""^保存済みの応答は返らない$""") { () =>
    require(world.last.json.hcursor.downField("versions").focus.isEmpty, "保存済みの応答が返った")
  }

  private var keyedRecover: Option[(Json, Option[String], String)] = None

  private def sendKeyedRecover(): Reply =
    val (body, cookie, key) = keyedRecover.getOrElse(sys.error("復帰の要求が無い"))
    world.game.callWith(
      org.http4s.Method.POST,
      "/api/v1/participations/recover",
      Some(body),
      cookie,
      Some(key),
      Nil
    )

  Given("""^(.+)の参加者が、冪等キー付きで復帰資格で再接続している$""") { (label: String) =>
    keyedRecover = Some(
      (
        Json.obj("gameId" -> Json.fromString(world.game.gameId.getOrElse(""))),
        world.game.recoveries.get(role(label)),
        java.util.UUID.randomUUID.toString
      )
    )
    val reply = sendKeyedRecover()
    require(reply.status == 200, s"復帰できない: ${reply.text}")
  }

  Given("""^(.+)の参加者が、復帰資格で再接続している$""") { (label: String) =>
    require(recoverAs(role(label)).status == 200, "復帰できない")
  }

  When("""^(.+)の参加者が、以前に成功した復帰の要求を、同じキーでもう一度送る$""") { (_: String) =>
    world.last = sendKeyedRecover()
  }

  // ---- 鍵のローテーション（NF-S4） ----

  private def rotateKey(): Unit =
    world.game.env.keyRing
      .update(_.rotate(java.util.UUID.randomUUID.toString))
      .unsafeRunSync()

  When("""^運営者が、資格の署名鍵を新しい版へ更新する$""") { () => rotateKey() }

  Given("""^運営者が、資格の署名鍵を新しい版へ更新している$""") { () => rotateKey() }

  Then("""^(.+)の参加者は、更新前に発行した復帰資格で復帰できる$""") { (label: String) =>
    require(recoverAs(role(label)).status == 200, "復帰できない")
  }

  Then("""^更新前に発行した(.+)の参加者のブラウザセッションで、状況を取得できる$""") { (label: String) =>
    require(gameStateAs(world.game, role(label)).status == 200, "状況を取得できない")
  }

  When("""^運営者が、旧版の鍵を設定から外す$""") { () =>
    world.game.env.keyRing.update(_.retire(1)).unsafeRunSync()
  }

  Then("""^更新前に発行した(.+)の参加者の資格は、復帰もブラウザセッションも権限エラーになる$""") { (label: String) =>
    require(recoverAs(role(label)).status == 403, "復帰できてしまう")
    require(gameStateAs(world.game, role(label)).status == 403, "状況を取得できてしまう")
  }

  Then("""^別のゲームの進行役の資格は、まだ使える$""") { () =>
    val other = otherGame.getOrElse(sys.error("別のゲームが無い"))
    require(
      other.get(gamePath(other, "/state"), other.facilitator).status == 200,
      "別のゲームの進行役が使えない"
    )
  }

  // ---- 役割の入れ替え（H4。開始後。AC3.2.5） ----

  /** 入れ替え前の担当者の資格（ブラウザセッションの Cookie と、復帰資格の Cookie）。 */
  private var replaced: List[(String, String)] = Nil

  private def snapshotHolders(apiRole: String): Unit =
    replaced = List(
      (
        world.game.players.getOrElse(apiRole, ""),
        world.game.recoveries.getOrElse(apiRole, "")
      )
    )

  Given("""^参加者「(.+)」が、役割なしで参加している$""") { (name: String) =>
    val client = world.game
    require(joinWith(client, joinCodeOf(client), name).status == 200, "参加できない")
  }

  When("""^進行役が、(.+)の担当を(.+)に入れ替え(?:る|ようとする)$""") { (label: String, name: String) =>
    snapshotHolders(role(label))
    world.lastRole = role(label)
    world.last = assignRole(world.game, name, role(label))
    if world.last.status == 200 then
      world.game.players = world.game.players.updated(
        role(label),
        world.game.participantCookies.getOrElse(name, "")
      )
      world.game.recoveries = world.game.recoveries.updated(
        role(label),
        world.game.participantRecoveries.getOrElse(name, "")
      )
  }

  Then("""^(.+)が(.+)の担当になる$""") { (name: String, label: String) =>
    require(world.last.status == 200, s"入れ替えられていない: ${world.last.text}")
    require(
      lobbyRoles(world.game)
        .get(world.game.participants.getOrElse(name, ""))
        .flatten
        .contains(role(label)),
      "担当になっていない"
    )
  }

  private def credentialsDead(cookie: String, recovery: String): Unit =
    val state =
      world.game.get(gamePath(world.game, "/state"), Some(cookie).filter(_.nonEmpty))
    require(state.status == 403, s"ブラウザセッションが使える: ${state.status}")
    val reply = recoverReply(world.game, Some(recovery).filter(_.nonEmpty), None)
    require(reply.status == 403, s"復帰資格が使える: ${reply.status}")

  Then("""^以前の(.+)の参加者の資格は、自動で失効している$""") { (_: String) =>
    replaced.foreach((cookie, recovery) => credentialsDead(cookie, recovery))
  }

  Then("""^共同担当だった(.+)の資格も、自動で失効している$""") { (name: String) =>
    credentialsDead(
      world.game.participantCookies.getOrElse(name, ""),
      world.game.participantRecoveries.getOrElse(name, "")
    )
  }

  Then("""^(.+)は、第 (\d+) 週の数量として (\d+) を保存できる$""") { (_: String, week: Int, quantity: Int) =>
    val reply = saveAt(world.game, world.lastRole, week, quantity)
    require(reply.status == 200, s"保存できない: ${reply.text}")
  }

  Then("""^小売店の入力 (\d+) の入力者は、以前の小売店の参加者として残っている$""") { (_: Int) =>
    val editor = world.game
      .get(sessionPath(world.game, "/state"), world.game.facilitator)
      .json
      .hcursor
      .downField("roles")
      .downField("RETAILER")
      .downField("decisionEditor")
    require(editor.get[String]("displayName").contains("参加者の小売店"), s"入力者のラベルが違う: ${editor.focus}")
  }

  private def gameVersion(client: GameClient): Long =
    client
      .get(gamePath(client, "/state"), client.facilitator)
      .json
      .hcursor
      .downField("versions")
      .get[Long]("game")
      .getOrElse(0L)

  private var versionBefore = 0L

  When("""^進行役が、小売店の参加者を小売店に割り当て直す$""") { () =>
    versionBefore = gameVersion(world.game)
    world.last = assignRole(world.game, "参加者の小売店", "RETAILER")
  }

  Then("""^割り当ては受け付けられるが、履歴に何も足されない$""") { () =>
    require(world.last.status == 200, s"受け付けられない: ${world.last.text}")
    require(gameVersion(world.game) == versionBefore, "履歴が足された")
  }

  When("""^(.+)の参加者が、(.+)の担当を(.+)に入れ替えようとする$""") { (actor: String, label: String, name: String) =>
    world.last = world.game.put(
      gamePath(
        world.game,
        s"/participants/${world.game.participants.getOrElse(name, "")}/role"
      ),
      Json.obj("role" -> Json.fromString(role(label))),
      world.game.players.get(role(actor)),
      None
    )
  }

  Then("""^権限エラーになる$""") { () =>
    require(world.last.status == 403, s"権限エラーでない: ${world.last.status}")
  }

  When("""^進行役が、(.+)の参加者を(.+)に割り当てようとする$""") { (from: String, label: String) =>
    world.last = assignRole(world.game, s"参加者の$from", role(label))
  }

  Then("""^準備中でないという理由で、割り当ては拒否される$""") { () =>
    require(world.last.status == 409, s"409 でない: ${world.last.status}")
    require(world.last.code.contains("game.not_preparing"), s"理由が違う: ${world.last.text}")
  }

  Given("""^進行役が、([^の]+)の資格を失効させている$""") { (name: String) =>
    world.last = revokeAs(world.game, world.game.participants.getOrElse(name, ""))
    require(world.last.status == 200, s"失効できない: ${world.last.text}")
  }

  Then("""^以前の(.+)の参加者が、同じ識別子で同じ保存を再送すると、権限エラーになる$""") { (_: String) =>
    require(sendKeyedSave().status == 403, "再送が通ってしまう")
  }

  // ---- 共同担当と共同入力（B5: AC1.2.4・AC2.1.4・AC2.2.3・AC2.2.4） ----

  Then("""^小売店に (\d+) 人の参加者が割り当てられている$""") { (count: Int) =>
    require(lobbyRoles(world.game).values.flatten.count(_ == "RETAILER") == count, "人数が違う")
  }

  When("""^進行役がゲームを開始する$""") { () => world.last = startGame(world.game) }

  Then("""^ゲームは開始されている$""") { () =>
    require(world.last.status == 200, s"開始されていない: ${world.last.text}")
  }

  /** 「小売店の参加者」と共同担当の名前から、その人の資格（Cookie）。 */
  private def cookieOfPerson(person: String): Option[String] =
    if person == "小売店の参加者" then world.game.players.get("RETAILER")
    else world.game.participantCookies.get(person)

  private def stateWith(cookie: Option[String]): Reply =
    world.game.get(sessionPath(world.game, "/state"), cookie)

  private def saveWith(cookie: Option[String], week: Int, quantity: Int, version: Long): Reply =
    world.game.callWith(
      org.http4s.Method.PUT,
      sessionPath(world.game, "/decisions"),
      Some(Json.obj("week" -> Json.fromInt(week), "quantity" -> Json.fromInt(quantity))),
      cookie,
      Some(java.util.UUID.randomUUID.toString),
      List(org.http4s.Header.Raw(CIString("If-Match"), version.toString))
    )

  private def retailerVersion: Long = versionOf(world.game, "RETAILER")

  private var viewedVersion = 0L
  private var viewedBasis: Json = Json.Null

  private def roleStatusOf(reply: Reply) = reply.json.hcursor.downField("roleStatus")

  When("""^共同担当の鈴木が、自分の役割の状況を取得する$""") { () =>
    world.last = stateWith(cookieOfPerson("鈴木"))
  }

  Then("""^鈴木が見る入力値は (\d+)、版は (\d+) である$""") { (quantity: Int, version: Int) =>
    val status = roleStatusOf(world.last)
    require(status.get[Int]("decision").contains(quantity), s"入力値が違う: ${world.last.text}")
    require(status.get[Int]("decisionVersion").contains(version), "版が違う")
  }

  /** 保存者の「自分か」だけを除いた、役割の状況。 */
  private def comparable(reply: Reply): Option[Json] =
    roleStatusOf(reply).focus.map(_.mapObject(_.remove("decisionEditor")))

  Then("""^鈴木が見る状況は、小売店の参加者が見る状況と同じである$""") { () =>
    val own = comparable(stateWith(cookieOfPerson("鈴木")))
    val other = comparable(stateWith(cookieOfPerson("小売店の参加者")))
    require(own.isDefined && own == other, s"状況が違う: $own / $other")
  }

  Then("""^同じ役割の共同担当として、小売店の参加者と鈴木が示される$""") { () =>
    val names = world.last.json.hcursor
      .downField("coHolders")
      .values
      .map(_.toList.flatMap(_.hcursor.get[String]("displayName").toOption))
      .getOrElse(Nil)
    require(names.toSet == Set("参加者の小売店", "鈴木"), s"共同担当が違う: $names")
  }

  Then("""^鈴木が見る最後の保存者は、(小売店の参加者|自分自身)である$""") { (who: String) =>
    val editor = roleStatusOf(stateWith(cookieOfPerson("鈴木"))).downField("decisionEditor")
    if who == "自分自身" then require(editor.get[Boolean]("isSelf").contains(true), "自分でない")
    else
      require(editor.get[String]("displayName").contains("参加者の小売店"), s"保存者が違う: ${editor.focus}")
      require(editor.get[Boolean]("isSelf").contains(false), "自分になっている")
  }

  Then("""^他の役割の担当者の表示名・ID は、どの項目にも含まれない$""") { () =>
    val text = world.last.text
    val ids = world.game.participants.collect {
      case (name, id) if name == "参加者の小売店" || name == "鈴木" => id
    }
    List("参加者の小売店", "鈴木").foreach(n => require(!text.contains(n), s"表示名 $n が含まれる"))
    ids.foreach(id => require(!text.contains(id), "ID が含まれる"))
  }

  Then("""^入力値・版は、自分の役割のもの（入力なし、版 (\d+)）である$""") { (version: Int) =>
    val status = roleStatusOf(world.last)
    require(status.get[Option[Int]]("decision").contains(None), "入力がある")
    require(status.get[Int]("decisionVersion").contains(version), "版が違う")
  }

  Given("""^小売店の参加者と鈴木が、同じ版の画面を見ている$""") { () => viewedVersion = retailerVersion }

  Given("""^小売店の参加者が、見ていた版のまま、数量 (\d+) を保存している$""") { (quantity: Int) =>
    val reply = saveWith(cookieOfPerson("小売店の参加者"), 1, quantity, viewedVersion)
    require(reply.status == 200, s"保存できない: ${reply.text}")
  }

  When("""^鈴木が、見ていた版のまま、数量 (\d+) を保存しようとする$""") { (quantity: Int) =>
    world.last = saveWith(cookieOfPerson("鈴木"), 1, quantity, viewedVersion)
  }

  Given("""^鈴木が、見ていた版のまま、数量 (\d+) を保存しようとして、競合している$""") { (quantity: Int) =>
    world.last = saveWith(cookieOfPerson("鈴木"), 1, quantity, viewedVersion)
    require(world.last.status == 409, s"競合していない: ${world.last.status}")
  }

  Then("""^保存は競合として拒否される$""") { () =>
    require(world.last.status == 409, s"409 でない: ${world.last.status}")
    require(world.last.code.contains("session.decision_conflict"), s"理由が違う: ${world.last.text}")
  }

  Then("""^競合の応答に、最新の入力 (\d+)、版 (\d+) が含まれる$""") { (quantity: Int, version: Int) =>
    val latest = world.last.json.hcursor.downField("latest")
    require(latest.get[Int]("quantity").contains(quantity), s"最新の入力が違う: ${world.last.text}")
    require(latest.get[Int]("version").contains(version), "版が違う")
  }

  Then("""^最後の保存者として小売店の参加者が、保存の時刻とともに示される$""") { () =>
    val latest = world.last.json.hcursor.downField("latest")
    require(
      latest.downField("editor").get[String]("displayName").contains("参加者の小売店"),
      "保存者が違う"
    )
    require(latest.get[String]("savedAt").exists(_.nonEmpty), "保存の時刻が無い")
  }

  Then("""^競合した入力 (\d+) は、応答に含まれない$""") { (quantity: Int) =>
    val numbers = world.last.json.foldWith(new io.circe.Json.Folder[List[Long]]:
      def onNull = Nil
      def onBoolean(value: Boolean) = Nil
      def onNumber(value: io.circe.JsonNumber) = value.toLong.toList
      def onString(value: String) = Nil
      def onArray(value: Vector[Json]) = value.toList.flatMap(_.foldWith(this))
      def onObject(value: io.circe.JsonObject) = value.values.toList.flatMap(_.foldWith(this)))
    require(!numbers.contains(quantity.toLong), "競合した入力が含まれる")
  }

  Then("""^当週の小売店の入力は (\d+)、版は (\d+) である$""") { (quantity: Int, version: Int) =>
    require(decisionOf(world.game, "RETAILER").contains(quantity), "入力が違う")
    require(versionOf(world.game, "RETAILER") == version.toLong, "版が違う")
  }

  When("""^鈴木が、最新の版を指定して、数量 (\d+) を保存し直す$""") { (quantity: Int) =>
    world.last = saveWith(cookieOfPerson("鈴木"), 1, quantity, retailerVersion)
  }

  Then("""^保存が受け付けられる$""") { () =>
    require(world.last.status == 200, s"受け付けられていない: ${world.last.text}")
  }

  Then("""^最後の保存者は、進行役の代理入力として示される$""") { () =>
    require(
      world.last.json.hcursor
        .downField("latest")
        .downField("editor")
        .get[String]("kind")
        .contains("FACILITATOR_PROXY"),
      "保存者が代理入力でない"
    )
  }

  Then("""^共同担当の鈴木が取得した状況は、入力値 (\d+)、版 (\d+) になる$""") { (quantity: Int, version: Int) =>
    val status = roleStatusOf(stateWith(cookieOfPerson("鈴木")))
    require(status.get[Int]("decision").contains(quantity), "入力値が違う")
    require(status.get[Int]("decisionVersion").contains(version), "版が違う")
  }

  private def saveTimesAs(person: String, times: Int): Unit =
    (1 to times).foreach { n =>
      val reply = saveWith(cookieOfPerson(person), 1, n, retailerVersion)
      require(reply.status == 200, s"$n 回目の保存ができない: ${reply.text}")
    }

  Given("""^共同担当の鈴木が、当週の数量をさらに (\d+) 回保存している$""") { (times: Int) => saveTimesAs("鈴木", times) }

  Given("""^小売店の参加者が、当週の数量をあと (\d+) 回保存している$""") { (times: Int) =>
    saveTimesAs("小売店の参加者", times)
  }

  When("""^共同担当の鈴木が、当週の数量をもう 1 回保存しようとする$""") { () =>
    world.last = saveWith(cookieOfPerson("鈴木"), 1, 9, retailerVersion)
  }

  Given("""^進行役が、確定の確認画面を開いて、各役割の入力の版を控えている$""") { () =>
    viewedBasis = decisionVersions(world.game)
  }

  Given("""^共同担当の鈴木が、当週の数量を (\d+) に保存し直している$""") { (quantity: Int) =>
    val reply = saveWith(cookieOfPerson("鈴木"), 1, quantity, retailerVersion)
    require(reply.status == 200, s"保存できない: ${reply.text}")
  }

  When("""^進行役が、控えた版のまま第 (\d+) 週を確定しようとする$""") { (week: Int) =>
    world.last = world.game.call(
      org.http4s.Method.POST,
      sessionPath(world.game, s"/weeks/$week/commit"),
      Some(Json.obj("requestedWeek" -> Json.fromInt(week), "basis" -> viewedBasis)),
      world.game.facilitator,
      Some(java.util.UUID.randomUUID.toString)
    )
  }

  Then("""^確定の根拠にした入力が変わったという理由で拒否される$""") { () =>
    require(world.last.status == 409, s"409 でない: ${world.last.status}")
    require(world.last.code.contains("session.decisions_changed"), s"理由が違う: ${world.last.text}")
  }

  Then("""^現在の入力として、小売店の (\d+)（保存者: (.+)）が示される$""") { (quantity: Int, name: String) =>
    val retailer = world.last.json.hcursor.downField("current").downField("RETAILER")
    require(retailer.get[Int]("quantity").contains(quantity), s"入力が違う: ${world.last.text}")
    require(retailer.downField("editor").get[String]("displayName").contains(name), "保存者が違う")
  }

  Then("""^確定の根拠が変わったという理由ではない$""") { () =>
    require(!world.last.code.contains("session.decisions_changed"), "根拠の変化として拒否された")
  }

  // ---- 試行の窓（NF-S11・NF-S19。上限 10 回、窓 10 分は、未計測の仮置き） ----

  private val attemptLimit = 10

  Given("""^同じ接続元が、存在しない参加コードで、上限の回数まで参加に失敗している$""") { () =>
    (1 to attemptLimit).foreach { n =>
      val reply = joinWith(world.game, "ZZZZZZZZ", s"失敗$n")
      require(reply.status == 403, s"失敗として数えられていない: ${reply.status}")
    }
  }

  Then("""^参加は、試行が多すぎるという理由で拒否される$""") { () =>
    require(world.last.status == 429, s"429 でない: ${world.last.status}")
    require(world.last.code.contains("app.rate_limited"), s"理由が違う: ${world.last.text}")
  }

  Then("""^再試行までの待ち時間が示される$""") { () =>
    val seconds = world.last.headers
      .get(CIString("Retry-After"))
      .flatMap(_.toList.headOption)
      .flatMap(_.value.toIntOption)
    require(seconds.exists(_ > 0), s"待ち時間が無い: $seconds")
  }

  private var bulkJoins: List[Reply] = Nil

  When("""^同じ接続元から、表示名の違う参加者が、上限を超える人数、有効な参加コードで参加する$""") { () =>
    val code = joinCodeOf(world.game)
    bulkJoins = (1 to attemptLimit + 2).toList.map(n => joinWith(world.game, code, s"参加者$n"))
  }

  Then("""^どの参加も受け付けられる$""") { () =>
    require(bulkJoins.forall(_.status == 200), s"拒否された参加がある: ${bulkJoins.map(_.status)}")
  }

  Given("""^同じ接続元が、表示名の無い参加を、上限を超える回数送っている$""") { () =>
    val code = joinCodeOf(world.game)
    (1 to attemptLimit + 2).foreach { _ =>
      val reply = world.game.post(
        "/api/v1/participations/join",
        Json.obj("joinCode" -> Json.fromString(code)),
        None
      )
      require(reply.status >= 400 && reply.status != 429, s"形の誤りでない: ${reply.status}")
    }
  }

  Then("""^参加は受け付けられる$""") { () =>
    require(world.last.status == 200, s"受け付けられていない: ${world.last.text}")
  }

  // ---- カスタム条件（B6: AC1.1.3〜1.1.5）と確定方式（B7: AC1.1.6・AC2.4.*） ----

  private def createBody(
      kind: String,
      conditions: Option[Json],
      commitMode: Option[String]
  ): Json =
    demandBody(12, Map.empty).mapObject(obj =>
      obj
        .add("kind", Json.fromString(kind))
        .deepMerge(
          io.circe.JsonObject.fromIterable(
            conditions.map("conditions" -> _).toList ++
              commitMode.map(m => "commitMode" -> Json.fromString(m)).toList
          )
        )
    )

  private def createWith(client: GameClient, body: Json): Reply =
    val key = java.util.UUID.randomUUID.toString
    val reply = client.call(org.http4s.Method.POST, "/api/v1/games", Some(body), None, Some(key))
    if reply.status == 201 then
      client.facilitator = reply.cookie
      client.gameId = reply.location.map(_.split("/").reverse.drop(1).headOption.getOrElse(""))
      client.recoveries =
        client.recoveries.updated("FACILITATOR", reply.cookieNamed("bg_recovery").getOrElse(""))
      client.recoveryCode = reply.json.hcursor.get[String]("recoveryCode").getOrElse("")
    reply

  private val fieldLabels: Map[String, String] = Map(
    "初期在庫" -> "INITIAL_INVENTORY",
    "初期の流れ" -> "INITIAL_FLOW",
    "注文の遅延" -> "ORDER_DELAY",
    "配送の遅延" -> "SHIPMENT_DELAY",
    "生産の遅延" -> "PRODUCTION_DELAY",
    "在庫の単価" -> "HOLDING_COST",
    "受注残の単価" -> "BACKLOG_COST",
    "公開範囲" -> "DISCLOSURE"
  )

  /** 「小売店の初期在庫を 20、配送の遅延を 3 週」のような列を、conditions の本文にする。 */
  private def conditionsOf(text: String): Json =
    val items = text.split("、").toList.map(_.trim).filter(_.nonEmpty)
    val fields = items.map { item =>
      val (label, raw) = item.split("を", 2) match
        case Array(l, v) => (l, v.trim.stripSuffix("週").trim.stripPrefix("「").stripSuffix("」"))
        case _           => sys.error(s"読めない条件: $item")
      def int = Json.fromInt(raw.toInt)
      label match
        case "小売店の初期在庫" => "initialInventory" -> Json.obj("RETAILER" -> int)
        case "配送の遅延"    => "shipmentDelayWeeks" -> int
        case "注文の遅延"    => "orderDelayWeeks" -> int
        case "在庫の単価"    => "holdingCostMinor" -> int
        case "受注残の単価"   => "backlogCostMinor" -> int
        case "公開範囲"     =>
          "disclosurePolicy" -> Json.fromString(if raw == "なし" then "NONE" else raw)
        case other => sys.error(s"未知の条件: $other")
    }
    Json.fromFields(fields)

  private def customCreate(text: String): Reply =
    world.games = List(GameClient.fresh())
    createWith(world.game, createBody("CUSTOM", Some(conditionsOf(text)), None))

  When("""^進行役が、(.+?) ?に変えて、ゲームを(?:作成する|作成しようとする)$""") { (text: String) =>
    world.last = customCreate(text)
  }

  Given("""^進行役が、(.+?) ?に変えて、ゲームを作成している$""") { (text: String) =>
    world.last = customCreate(text)
    require(world.last.status == 201, s"作成できない: ${world.last.text}")
  }

  Then("""^ゲームが作成される$""") { () =>
    require(world.last.status == 201, s"作成されていない: ${world.last.status} ${world.last.text}")
  }

  private def settingsOf(client: GameClient): (String, List[String]) =
    val c = client.get(gamePath(client, "/state"), client.facilitator).json.hcursor
    (
      c.get[String]("settingsKind").getOrElse(""),
      c.get[List[String]]("changedSettings").getOrElse(Nil)
    )

  private def requireSettings(kind: String, expected: List[String]): Unit =
    val (actualKind, changed) = settingsOf(world.game)
    require(actualKind == (if kind == "カスタム" then "CUSTOM" else "KIT"), s"種別が違う: $actualKind")
    require(changed == expected, s"変更した項目が違う: $changed / $expected")

  Then("""^ゲームの設定の種別は「(カスタム|キット準拠)」で、変更した項目は無い$""") { (kind: String) =>
    requireSettings(kind, Nil)
  }

  Then("""^ゲームの設定の種別は「(カスタム|キット準拠)」で、変更した項目は(「.+」)である$""") { (kind: String, items: String) =>
    requireSettings(
      kind,
      items.split("」「").toList.map(_.stripPrefix("「").stripSuffix("」")).map(fieldLabels)
    )
  }

  When("""^進行役が、キットの値のままの条件を指定して、ゲームをカスタムで作成する$""") { () =>
    world.games = List(GameClient.fresh())
    val kit = Json.obj(
      "initialInventory" -> Json.fromFields(allRoles.map(_ -> Json.fromInt(12))),
      "initialFlow" -> Json.fromInt(4),
      "orderDelayWeeks" -> Json.fromInt(2),
      "shipmentDelayWeeks" -> Json.fromInt(2),
      "productionDelayWeeks" -> Json.fromInt(2),
      "holdingCostMinor" -> Json.fromInt(50),
      "backlogCostMinor" -> Json.fromInt(100),
      "disclosurePolicy" -> Json.fromString("TEAM_TOTAL")
    )
    world.last = createWith(world.game, createBody("CUSTOM", Some(kit), None))
  }

  When("""^進行役が、キット準拠の作成に、配送の遅延 3 週の条件を付けて作成しようとする$""") { () =>
    world.games = List(GameClient.fresh())
    world.last = createWith(
      world.game,
      createBody("KIT", Some(Json.obj("shipmentDelayWeeks" -> Json.fromInt(3))), None)
    )
  }

  private def errorsOf(reply: Reply): List[io.circe.ACursor] =
    reply.json.hcursor
      .downField("errors")
      .values
      .map(_.toList.map(_.hcursor))
      .getOrElse(Nil)

  Then("""^誤りの対象は「条件」であり、カスタムで作成するという修正内容が示される$""") { () =>
    require(world.last.status == 422, s"422 でない: ${world.last.status}")
    require(
      errorsOf(world.last).exists(e =>
        e.get[String]("field").contains("conditions") &&
          e.get[String]("message").exists(_.contains("カスタム"))
      ),
      s"誤りが違う: ${world.last.text}"
    )
  }

  Then("""^小売店の第 1 週の在庫は (\d+) である$""") { (inventory: Int) =>
    val roles = world.game
      .get(sessionPath(world.game, "/state"), world.game.facilitator)
      .json
      .hcursor
      .downField("roles")
    require(roles.downField("RETAILER").get[Int]("inventory").contains(inventory), "在庫が違う")
  }

  Then("""^誤りの対象は「(.+)」であり、「(.+)」にするという修正内容が示される$""") { (target: String, fix: String) =>
    require(world.last.status == 422, s"422 でない: ${world.last.status}")
    require(
      errorsOf(world.last).exists(e =>
        e.get[String]("field").exists(f => f == target || f.endsWith(s".$target")) &&
          e.get[String]("message").exists(_.contains(fix))
      ),
      s"誤りが違う: ${world.last.text}"
    )
  }

  Then("""^誤りの対象として「(.+)」と「(.+)」の両方が示される$""") { (a: String, b: String) =>
    val fields = errorsOf(world.last).flatMap(_.get[String]("field").toOption)
    require(fields.exists(_.endsWith(a)) && fields.exists(_.endsWith(b)), s"対象が足りない: $fields")
  }

  // 確定方式
  private def commitModeOf(client: GameClient): String =
    client
      .get(gamePath(client, "/state"), client.facilitator)
      .json
      .hcursor
      .get[String]("commitMode")
      .getOrElse("")

  Then("""^ゲームの確定方式は「(手動確定|自動確定)」である$""") { (label: String) =>
    require(
      commitModeOf(world.game) == (if label == "自動確定" then "AUTO" else "MANUAL"),
      s"確定方式が違う: ${commitModeOf(world.game)}"
    )
  }

  When("""^進行役が、自動確定を有効にして、ゲームを作成する$""") { () =>
    world.games = List(GameClient.fresh())
    world.last = createWith(world.game, createBody("KIT", None, Some("AUTO")))
  }

  Given("""^進行役が、自動確定を有効にして、ゲームを作成している$""") { () =>
    world.games = List(GameClient.fresh())
    world.last = createWith(world.game, createBody("KIT", None, Some("AUTO")))
    require(world.last.status == 201, s"作成できない: ${world.last.text}")
  }

  When("""^進行役が、確定方式「(.+)」で、ゲームを作成しようとする$""") { (mode: String) =>
    world.games = List(GameClient.fresh())
    world.last = createWith(world.game, createBody("KIT", None, Some(mode)))
  }

  Then("""^誤りの対象は「commitMode」であり、MANUAL か AUTO にするという修正内容が示される$""") { () =>
    require(world.last.status == 422, s"422 でない: ${world.last.status}")
    require(
      errorsOf(world.last).exists(e =>
        e.get[String]("field").contains("commitMode") &&
          e.get[String]("message").exists(_.contains("MANUAL か AUTO"))
      ),
      s"誤りが違う: ${world.last.text}"
    )
  }

  private def setMode(cookie: Option[String], mode: String): Reply =
    world.game.put(
      sessionPath(world.game, "/commit-mode"),
      Json.obj("commitMode" -> Json.fromString(mode)),
      cookie,
      None
    )

  When("""^進行役が、自動確定を(有効|無効)にする$""") { (label: String) =>
    world.last = setMode(world.game.facilitator, if label == "有効" then "AUTO" else "MANUAL")
    require(world.last.status == 200, s"変更できない: ${world.last.text}")
  }

  When("""^(.+)の参加者が、自動確定を無効にしようとする$""") { (label: String) =>
    world.last = setMode(world.game.players.get(role(label)), "MANUAL")
  }

  When("""^(.+)の参加者が、第 (\d+) 週の数量として (\d+) を保存する$""") { (label: String, week: Int, quantity: Int) =>
    world.last = saveAt(world.game, role(label), week, quantity)
    require(world.last.status == 200, s"保存できない: ${world.last.text}")
  }

  When("""^進行役が、最終週 (\d+) の設定でゲームを作成しようとする$""") { (finalWeek: Int) =>
    world.games = List(GameClient.fresh())
    world.last = createWith(world.game, demandBody(finalWeek, Map.empty))
  }

  Then("""^最終週は (\d+) 以上 (\d+) 以下の整数にするという修正内容が示される$""") { (min: Int, max: Int) =>
    require(world.last.status == 422, s"422 でない: ${world.last.status}")
    require(
      errorsOf(world.last).exists(_.get[String]("message").exists(_.contains(s"$min 以上 $max 以下"))),
      s"修正内容が違う: ${world.last.text}"
    )
  }
