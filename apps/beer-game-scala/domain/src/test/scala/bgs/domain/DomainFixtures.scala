package bgs.domain

import java.time.Instant
import java.util.UUID

/** テストの補助。固定の値だけで作り、時計・乱数を使わない。 */
object DomainFixtures:
  val at: Instant = Instant.parse("2026-12-01T00:00:00Z")
  val expiresAt: Instant = Instant.parse("2026-12-02T00:00:00Z")

  val gameId: GameId = GameId(UUID.fromString("00000000-0000-0000-0000-000000000001"))

  def participantId(n: Int): ParticipantId =
    ParticipantId(UUID.fromString(f"00000000-0000-0000-0000-0000000001$n%02d"))

  def settings(finalWeek: Int = 12): GameSettings =
    GameSettings
      .kit(finalWeek, List.fill(finalWeek)(4), CommitMode.Manual)
      .fold(errors => throw new AssertionError(s"設定が作れない: $errors"), identity)

  def joinCode: JoinCode =
    JoinCode.of("ABCD2345").fold(e => throw new AssertionError(e.toString), identity)

  def retention: RetentionDays =
    RetentionDays.of(30).fold(e => throw new AssertionError(e.toString), identity)

  def displayName(raw: String): DisplayName =
    DisplayName.of(raw).fold(e => throw new AssertionError(e.toString), identity)

  def create: GameCommand.CreateGame =
    GameCommand.CreateGame(Actor.Anonymous, at, gameId, joinCode, settings(), retention, expiresAt)

  def join(n: Int): GameCommand.JoinGame =
    GameCommand.JoinGame(Actor.Anonymous, at, participantId(n), displayName(s"参加者$n"), expiresAt)

  def assign(n: Int, role: Role): GameCommand.AssignRole =
    GameCommand.AssignRole(Actor.Facilitator(gameId), at, participantId(n), role)

  val facilitator: Actor = Actor.Facilitator(gameId)

  def week(n: Int): Week = Week.of(n).fold(e => throw new AssertionError(e.toString), identity)

  def quantity(n: Int): Quantity =
    Quantity.of(n).fold(e => throw new AssertionError(e.toString), identity)

  /** 役割ごとの参加者（参加者 1〜4 を、上流から順に割り当てる）。 */
  def holder(role: Role): ParticipantId = participantId(role.ordinal + 1)

  /** 4 役割の参加者が参加し、割り当て済みの準備中のゲーム。 */
  def fullGame: GameState =
    val events: List[GameEvent] =
      GameEvent.GameCreated(gameId, joinCode, settings(), retention, expiresAt) ::
        Role.values.toList.flatMap { role =>
          List(
            GameEvent.ParticipantJoined(holder(role), expiresAt),
            GameEvent.RoleAssigned(holder(role), role)
          )
        }
    events.foldLeft[GameState](GameState.NotCreated)(GameEvents.apply)

  /** 開始済みのセッション（第 1 週、最終週 12、キットの初期状態）。 */
  def startedSession: SessionState =
    Start
      .decide(fullGame, SessionState.NotStarted, StartGame(facilitator, at))
      .fold(
        e => throw new AssertionError(e.toString),
        _.session.foldLeft[SessionState](SessionState.NotStarted)(SessionEvents.apply)
      )

  /** 作成済みの準備中のゲーム。 */
  def preparing: GameState =
    Game
      .handle(GameState.NotCreated, create)
      .fold(
        e => throw new AssertionError(e.toString),
        _.foldLeft[GameState](GameState.NotCreated)(GameEvents.apply)
      )
