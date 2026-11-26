package bgs.adapter.http

import bgs.application.*
import bgs.domain.*
import io.circe.Json

/** 応答の JSON。API の契約（openapi.yaml）の項目名に合わせる。項目が無いときは、項目ごと付けない。 */
object JsonViews:

  def roleName(role: Role): String = role.toString.toUpperCase

  def parseRole(raw: String): Option[Role] = Role.values.find(roleName(_) == raw)

  /** 値の無い項目（None）を省いたオブジェクト。`Json.Null` は、明示の null として残す。 */
  def obj(fields: (String, Option[Json])*): Json =
    Json.fromFields(fields.collect { case (name, Some(value)) => name -> value })

  private def orNull(value: Option[Json]): Json = value.getOrElse(Json.Null)

  def versions(v: Versions): Json =
    Json.obj(
      "game" -> orNull(v.game.map(Json.fromLong)),
      "session" -> orNull(v.session.map(Json.fromLong))
    )

  def commandResponse(v: Versions): Json = Json.obj("versions" -> versions(v))

  private def statusName(status: GameStatus): String = status match
    case GameStatus.Preparing => "PREPARING"
    case GameStatus.Started   => "STARTED"
    case GameStatus.Paused    => "STARTED"
    case GameStatus.Ended     => "ENDED"

  private def commitModeName(mode: CommitMode): String = mode match
    case CommitMode.Manual => "MANUAL"
    case CommitMode.Auto   => "AUTO"

  def gameState(view: GameStateView): Json =
    obj(
      "gameId" -> Some(Json.fromString(view.gameId.value.toString)),
      "sessionId" -> Some(orNull(view.sessionId.map(id => Json.fromString(id.value.toString)))),
      "status" -> Some(Json.fromString(statusName(view.status))),
      "settingsKind" -> Some(Json.fromString("KIT")),
      "changedSettings" -> Some(Json.arr()),
      "commitMode" -> Some(Json.fromString(commitModeName(view.commitMode))),
      "joinCode" -> view.joinCode.map(Json.fromString),
      "finalWeek" -> view.finalWeek.map(Json.fromInt),
      "participantId" -> view.participantId.map(id => Json.fromString(id.value.toString)),
      "role" -> view.role.map(r => Json.fromString(roleName(r))),
      "versions" -> Some(versions(view.versions))
    )

  def lobby(view: LobbyView): Json =
    Json.obj(
      "gameId" -> Json.fromString(view.gameId.value.toString),
      "status" -> Json.fromString(statusName(view.status)),
      "joinCode" -> Json.fromString(view.joinCode),
      "settingsKind" -> Json.fromString("KIT"),
      "changedSettings" -> Json.arr(),
      "commitMode" -> Json.fromString(commitModeName(view.commitMode)),
      "participants" -> Json.fromValues(view.participants.map { p =>
        Json.obj(
          "participantId" -> Json.fromString(p.participantId.value.toString),
          "displayName" -> orNull(p.displayName.map(Json.fromString)),
          "role" -> orNull(p.role.map(r => Json.fromString(roleName(r))))
        )
      }),
      "invitations" -> Json.arr(),
      "observers" -> Json.arr(),
      "versions" -> versions(view.versions)
    )

  private def editor(view: EditorView): Json =
    Json.obj(
      "kind" -> Json.fromString(view.kind),
      "displayName" -> orNull(view.displayName.map(Json.fromString)),
      "isSelf" -> Json.fromBoolean(view.isSelf)
    )

  def roleStatus(view: RoleStatusView): Json =
    obj(
      "inventory" -> Some(Json.fromLong(view.inventory)),
      "backlog" -> Some(Json.fromLong(view.backlog)),
      "arrivals" -> Some(Json.fromLong(view.arrivals)),
      "orders" -> Some(Json.fromLong(view.orders)),
      "customerDemand" -> view.customerDemand.map(Json.fromLong),
      "decision" -> Some(orNull(view.decision.map(Json.fromInt))),
      "decisionVersion" -> Some(Json.fromLong(view.decisionVersion)),
      "decisionEditor" -> Some(orNull(view.decisionEditor.map(editor))),
      "decisionSavedAt" -> Some(Json.Null)
    )

  private def result(view: RoleResultView): Json =
    Json.obj(
      "role" -> Json.fromString(roleName(view.role)),
      "week" -> Json.fromInt(view.week),
      "orders" -> Json.fromLong(view.orders),
      "order" -> Json.fromInt(view.order),
      "inventory" -> Json.fromLong(view.inventory),
      "backlog" -> Json.fromLong(view.backlog),
      "shipment" -> Json.fromLong(view.shipment),
      "cost" -> Json.fromLong(view.cost),
      "cumulativeCost" -> Json.fromLong(view.cumulativeCost)
    )

  def sessionState(view: SessionStateView): Json =
    obj(
      "sessionId" -> Some(Json.fromString(view.gameId.value.toString)),
      "status" -> Some(Json.fromString(view.status match
        case GameStatus.Ended  => "ENDED"
        case GameStatus.Paused => "PAUSED"
        case _                 => "ACTIVE")),
      "week" -> Some(Json.fromInt(view.week)),
      "submittedRoleCount" -> Some(Json.fromInt(view.submittedRoleCount)),
      "participantId" -> view.participantId.map(id => Json.fromString(id.value.toString)),
      "role" -> view.role.map(r => Json.fromString(roleName(r))),
      "finalWeek" -> view.finalWeek.map(Json.fromInt),
      "roleStatus" -> view.roleStatus.map(roleStatus),
      "roles" -> view.roles.map(roles =>
        Json.fromFields(
          Role.values.toList.flatMap(r => roles.get(r).map(s => roleName(r) -> roleStatus(s)))
        )
      ),
      "results" -> view.results.map(rs => Json.fromValues(rs.map(result))),
      "versions" -> Some(versions(view.versions))
    )

  /** 検証の誤りを、項目・対象の週・修正内容にする（AC1.1.2・AC2.2.2）。 */
  def validationErrors(errors: List[ValidationError]): Json =
    Json.fromValues(errors.map {
      case ValidationError.DemandSeriesInvalid(week, reason) =>
        obj(
          "field" -> Some(Json.fromString("demand")),
          "week" -> Some(Json.fromInt(week)),
          "message" -> Some(Json.fromString(reason))
        )
      case ValidationError.QuantityOutOfRange(_, max) =>
        obj(
          "field" -> Some(Json.fromString("quantity")),
          "message" -> Some(Json.fromString(s"数量は 0 以上 $max 以下の整数で指定してください。"))
        )
      case ValidationError.WeekOutOfRange(_, max) =>
        obj(
          "field" -> Some(Json.fromString("week")),
          "message" -> Some(Json.fromString(s"週は 1 以上 $max 以下の整数で指定してください。"))
        )
      case ValidationError.DisplayNameInvalid(_) =>
        obj(
          "field" -> Some(Json.fromString("displayName")),
          "message" -> Some(Json.fromString("表示名は、前後の空白を除いて 1〜80 文字で入力してください。"))
        )
      case ValidationError.RetentionOutOfRange(_) =>
        obj(
          "field" -> Some(Json.fromString("retentionDays")),
          "message" -> Some(Json.fromString("保持日数は 1 以上 3650 以下で指定してください。"))
        )
      case other =>
        obj(
          "field" -> Some(Json.fromString("request")),
          "message" -> Some(Json.fromString(other.toString))
        )
    })
