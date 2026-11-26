package bgs.acceptance

import io.circe.Json
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
      client.players =
        client.players.updated(apiRole, client.participantCookies.getOrElse(name, ""))
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

  Given("""^参加者「(.+)」が小売店に割り当てられている$""") { (name: String) =>
    val client = world.game
    require(joinWith(client, joinCodeOf(client), name).status == 200, "参加できない")
    require(assignRole(client, name, "RETAILER").status == 200, "割り当てられない")
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

  Then("""^(.+)は(二次卸)に割り当てられている$""") { (name: String, label: String) =>
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
  private def versionOf(client: GameClient, apiRole: String): Long =
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
    import cats.effect.unsafe.implicits.global
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
