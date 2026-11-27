package bgs.adapter.persistence

import bgs.adapter.persistence.EventCodecs.given
import bgs.domain.*
import bgs.domain.DomainFixtures.*
import io.circe.parser.parse
import io.circe.syntax.*
import io.circe.{Decoder, Encoder, Json}
import munit.FunSuite

import java.nio.charset.StandardCharsets
import java.nio.file.{Files, Path, Paths}

/** イベントのスキーマ進化（B12。N-1 互換）。スキーマ版 1 の各イベントの黄金のデータ（`golden-events/v1`）を、
  * 現在のコードが読め、同じ形に書き戻せることを保つ。形を変えるときは、版を上げ、`Upcasters` に変換を足し、黄金のデータを増やす。 黄金のデータの更新:
  * `sbt BGS_GOLDEN_UPDATE=true "adapterPersistence/testOnly *EventSchemaSpec"`（差分は人が確認する）。
  */
class EventSchemaSpec extends FunSuite:

  /** テストの JVM の作業ディレクトリは、リポジトリのルートでも、プロジェクトの中でもあり得る。 */
  private val goldenDir: Path =
    List("src/test/resources", "adapter-persistence/src/test/resources")
      .map(Paths.get(_))
      .find(Files.isDirectory(_))
      .getOrElse(Paths.get("src/test/resources"))
      .resolve("golden-events/v1")
  private val update: Boolean = sys.env.get("BGS_GOLDEN_UPDATE").contains("true")

  private val started = Start
    .decide(fullGame, SessionState.NotStarted, StartGame(facilitator, at))
    .fold(e => throw new AssertionError(e.toString), identity)

  private val settingsValue = settings()
  private val states = KitPreset.initialStates(settingsValue.demand)
  private val outcome = simulateWeek(
    settingsValue.simulation,
    Week.first,
    states,
    RoleMap.all(Quantity.of(4).getOrElse(throw new AssertionError("数量")))
  )
  private val invitation = InvitationId(
    java.util.UUID.fromString("00000000-0000-0000-0000-0000000000a1")
  )
  private val observer = ObserverId(
    java.util.UUID.fromString("00000000-0000-0000-0000-0000000000b1")
  )

  /** 全イベントの種類の例（種類を足したら、ここにも足す。足りなければ、下の網羅の検査が落ちる）。 */
  private val gameSamples: List[GameEvent] = List(
    GameEvent.GameCreated(gameId, joinCode, settingsValue, retention, expiresAt),
    GameEvent.ParticipantJoined(participantId(1), expiresAt),
    GameEvent.RoleAssigned(participantId(1), Role.Retailer),
    GameEvent.RoleUnassigned(participantId(1), Role.Retailer),
    GameEvent.GameStarted(gameId),
    GameEvent.ObserverInvited(invitation, expiresAt),
    GameEvent.InvitationRevoked(invitation),
    GameEvent.ObserverJoined(observer, invitation),
    GameEvent.CredentialRevoked(participantId(1)),
    GameEvent.CredentialReissued(participantId(1), expiresAt)
  )

  private val sessionSamples: List[SessionEvent] = List(
    started.session.headOption.getOrElse(throw new AssertionError("SessionStarted")),
    SessionEvent.DecisionSaved(
      Week.first,
      Role.Retailer,
      Quantity.of(4).getOrElse(throw new AssertionError("数量")),
      DecisionVersion.of(1),
      Editor.ByParticipant(participantId(1)),
      1
    ),
    SessionEvent.DecisionSaved(
      Week.first,
      Role.Factory,
      Quantity.of(6).getOrElse(throw new AssertionError("数量")),
      DecisionVersion.of(1),
      Editor.ByFacilitator(gameId),
      2
    ),
    SessionEvent.WeekCommitted(
      Week.first,
      CommitKind.Manual,
      RoleMap.all(Quantity.of(4).getOrElse(throw new AssertionError("数量"))),
      outcome.results,
      outcome.nextStates,
      4
    ),
    SessionEvent.SessionEnded(EndReason.FinalWeek),
    SessionEvent.SessionPaused,
    SessionEvent.SessionResumed,
    SessionEvent.CommitModeChanged(CommitMode.Auto),
    SessionEvent.AssignmentsReplaced(RoleMap.all(Set(participantId(1))))
  )

  private def fileOf(prefix: String, index: Int, name: String): Path =
    goldenDir.resolve(f"$prefix-$index%02d-$name.json")

  private def check[E: Encoder: Decoder](
      prefix: String,
      samples: List[E],
      name: E => String
  ): Unit =
    samples.zipWithIndex.foreach { (event, index) =>
      val path = fileOf(prefix, index, name(event))
      val encoded = event.asJson
      if update then
        val _ = Files.createDirectories(goldenDir)
        val _ = Files.write(path, (encoded.spaces2 + "\n").getBytes(StandardCharsets.UTF_8))
      assert(Files.exists(path), s"黄金のデータが無い: $path（更新: BGS_GOLDEN_UPDATE=true）")
      val golden =
        parse(new String(Files.readAllBytes(path), StandardCharsets.UTF_8)).fold(throw _, identity)
      assertEquals(encoded, golden, s"書き出した形が黄金のデータと違う: $path")
      assertEquals(golden.as[E].toOption, Some(event), s"黄金のデータを読めない: $path")
    }

  test("[N-1] game のイベントの黄金のデータ（版 1）を、読め、同じ形に書き戻せる") {
    check[GameEvent]("game", gameSamples, _.name)
  }

  test("[N-1] session のイベントの黄金のデータ（版 1）を、読め、同じ形に書き戻せる") {
    check[SessionEvent]("session", sessionSamples, _.name)
  }

  test("[N-1] 全イベントの種類に、例（と黄金のデータ）がある") {
    val gameNames = Set(
      "GameCreated",
      "ParticipantJoined",
      "RoleAssigned",
      "RoleUnassigned",
      "GameStarted",
      "ObserverInvited",
      "InvitationRevoked",
      "ObserverJoined",
      "CredentialRevoked",
      "CredentialReissued"
    )
    val sessionNames = Set(
      "SessionStarted",
      "DecisionSaved",
      "WeekCommitted",
      "SessionEnded",
      "SessionPaused",
      "SessionResumed",
      "CommitModeChanged",
      "AssignmentsReplaced"
    )
    assertEquals(gameSamples.map(_.name).toSet, gameNames)
    assertEquals(sessionSamples.map(_.name).toSet, sessionNames)
  }

  test("[スキーマ進化] 現在の版は読める。現在より新しい版は、読まずに止める。版 0 は未知") {
    val payload = Json.obj("x" -> Json.fromInt(1)).noSpaces
    assert(Upcasters.upcast("GameStarted", Upcasters.Current, payload).isRight)
    assert(
      Upcasters.upcast("GameStarted", Upcasters.Current + 1, payload).left.exists(_.contains("新しい"))
    )
    assert(Upcasters.upcast("GameStarted", 0, payload).isLeft)
    assert(Upcasters.upcast("GameStarted", 1, "{not json").left.exists(_.contains("本文を読めない")))
  }
