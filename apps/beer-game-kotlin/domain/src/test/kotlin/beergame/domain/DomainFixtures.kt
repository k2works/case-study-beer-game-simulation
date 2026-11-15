package beergame.domain

import io.kotest.assertions.fail
import java.time.Instant
import java.util.UUID

/*
 * Given（過去のイベント）/ When（コマンド）/ Then の形で書くための補助（Object Mother）。
 * 時刻・ID はすべて固定値で、コマンドの値として与える（decide は時計を読まない）。
 */

val gid: GameId = GameId(UUID.fromString("00000000-0000-0000-0000-00000000000a"))

fun pid(n: Int): ParticipantId = ParticipantId(UUID(0L, n.toLong()))

val facilitatorActor: Actor = Actor.Facilitator(gid)

fun participantActor(n: Int): Actor = Actor.Participant(pid(n))

val anonymousActor: Actor = Actor.Anonymous

val t0: Instant = Instant.parse("2026-11-16T09:00:00Z")
val credentialExpiry: Instant = Instant.parse("2026-12-16T09:00:00Z")
val facilitatorExpiry: Instant = Instant.parse("2026-12-17T09:00:00Z")

val joinCode: JoinCode = JoinCode.of("K7M2Q9XW").valid("JoinCode")
val retention: RetentionDays = RetentionDays.of(90).valid("RetentionDays")

fun dv(n: Long): DecisionVersion = DecisionVersion.of(n).valid("DecisionVersion($n)")

fun sv(n: Long): StreamVersion = StreamVersion.of(n).valid("StreamVersion($n)")

fun name(text: String): DisplayName = DisplayName.of(text).valid("DisplayName($text)")

/** キット準拠の設定。既定は 3 週（需要 4, 4, 4）。 */
fun gameSettings(
    demand: List<Int> = listOf(4, 4, 4),
    finalWeek: Int = demand.size,
): GameSettings = GameSettings.kit(finalWeek, demand).valid("GameSettings")

// ---- Game: コマンド ----

fun createGame(
    actor: Actor = anonymousActor,
    settings: GameSettings = gameSettings(),
): GameCommand.CreateGame = GameCommand.CreateGame(actor, t0, gid, joinCode, settings, retention, facilitatorExpiry)

fun joinGame(n: Int): GameCommand.JoinGame =
    GameCommand.JoinGame(anonymousActor, t0, pid(n), name("参加者$n"), credentialExpiry)

fun assignRole(
    n: Int,
    role: Role,
    actor: Actor = facilitatorActor,
): GameCommand.AssignRole = GameCommand.AssignRole(actor, t0, pid(n), role)

// ---- Game: 資格 ----

/** 再発行・復帰で与える新しい有効期限。 */
val renewedExpiry: Instant = Instant.parse("2027-01-15T09:00:00Z")

val facilitatorSubject: CredentialSubject = CredentialSubject.Facilitator(gid)

fun participantSubject(n: Int): CredentialSubject = CredentialSubject.Participant(pid(n))

fun revokeCredential(
    subject: CredentialSubject,
    actor: Actor = facilitatorActor,
): GameCommand.RevokeCredential = GameCommand.RevokeCredential(actor, t0, subject)

fun reissueCredential(
    subject: CredentialSubject,
    actor: Actor = facilitatorActor,
    expiresAt: Instant = renewedExpiry,
): GameCommand.ReissueCredential = GameCommand.ReissueCredential(actor, t0, subject, expiresAt)

/** 復帰は、復帰資格の持ち主（その主体自身）の操作として届く（既定の操作者は主体から作る）。 */
fun recoverParticipation(
    subject: CredentialSubject,
    actor: Actor = actorOf(subject),
    at: Instant = t0,
    credentialExpiresAt: Instant = renewedExpiry,
): GameCommand.RecoverParticipation = GameCommand.RecoverParticipation(actor, at, subject, credentialExpiresAt)

fun actorOf(subject: CredentialSubject): Actor =
    when (subject) {
        is CredentialSubject.Facilitator -> Actor.Facilitator(subject.gameId)
        is CredentialSubject.Participant -> Actor.Participant(subject.id)
    }

// ---- Game: イベントと状態 ----

fun credentialRevoked(subject: CredentialSubject): GameEvent.CredentialRevoked = GameEvent.CredentialRevoked(subject)

fun credentialReissued(
    subject: CredentialSubject,
    expiresAt: Instant = renewedExpiry,
): GameEvent.CredentialReissued = GameEvent.CredentialReissued(subject, expiresAt)

fun participationRecovered(
    subject: CredentialSubject,
    credentialExpiresAt: Instant = renewedExpiry,
): GameEvent.ParticipationRecovered = GameEvent.ParticipationRecovered(subject, credentialExpiresAt)

fun gameCreated(settings: GameSettings = gameSettings()): GameEvent.GameCreated =
    GameEvent.GameCreated(gid, joinCode, settings, retention, facilitatorExpiry)

fun participantJoined(n: Int): GameEvent.ParticipantJoined = GameEvent.ParticipantJoined(pid(n), credentialExpiry)

fun roleAssigned(
    n: Int,
    role: Role,
): GameEvent.RoleAssigned = GameEvent.RoleAssigned(pid(n), role)

fun roleUnassigned(
    n: Int,
    role: Role,
): GameEvent.RoleUnassigned = GameEvent.RoleUnassigned(pid(n), role)

fun gameStarted(): GameEvent.GameStarted = GameEvent.GameStarted(gid)

/** 役割の入れ替えで、旧担当者 [n] が外れ、[replacedBy] が引き継いだ事実（B5 Step 3.5）。 */
fun participantReplaced(
    n: Int,
    role: Role,
    replacedBy: Int,
): GameEvent.ParticipantReplaced = GameEvent.ParticipantReplaced(pid(n), role, pid(replacedBy))

/** `session` の役割の写しの更新（旧担当者の集合 [removed] を外し、[added] を入れる）。 */
fun roleHolderReplaced(
    role: Role,
    removed: Set<Int>,
    added: Int,
): SessionEvent.RoleHolderReplaced = SessionEvent.RoleHolderReplaced(role, removed.map(::pid).toSet(), pid(added))

/** 過去のイベントを畳み込んだ状態（Given）。 */
fun gameOf(vararg events: GameEvent): GameState = events.fold<GameEvent, GameState>(GameState.NotCreated, ::evolveGame)

/** 参加者 n（1〜4）の役割。1 = 工場、2 = 一次卸、3 = 二次卸、4 = 小売店。 */
fun roleOfParticipant(n: Int): Role = Role.entries[n - 1]

/** 4 人が参加し、4 役割に 1 人ずつ割り当て済みのイベント列。 */
fun fullyAssignedEvents(settings: GameSettings = gameSettings()): List<GameEvent> =
    listOf<GameEvent>(gameCreated(settings)) +
        (1..4).map { participantJoined(it) } +
        (1..4).map { roleAssigned(it, roleOfParticipant(it)) }

fun fullyAssignedGame(): GameState = gameOf(*fullyAssignedEvents().toTypedArray())

fun gameDataOf(state: GameState): GameData =
    when (state) {
        is GameState.Preparing -> state.data
        is GameState.Started -> state.data
        is GameState.NotCreated -> fail("ゲームが作成されていない")
    }

// ---- Session: コマンド ----

fun saveDecision(
    role: Role,
    quantity: Int,
    week: Int = 1,
    expectedVersion: Long = 0,
    actor: Actor = participantActor(role.ordinal + 1),
): SessionCommand.SaveDecision = SessionCommand.SaveDecision(actor, t0, role, w(week), q(quantity), dv(expectedVersion))

fun commitWeek(
    week: Int = 1,
    basis: RoleMap<DecisionVersion> = RoleMap.all(dv(1)),
    actor: Actor = facilitatorActor,
): SessionCommand.CommitWeek = SessionCommand.CommitWeek(actor, t0, w(week), basis)

fun pauseSession(actor: Actor = facilitatorActor): SessionCommand.PauseSession = SessionCommand.PauseSession(actor, t0)

fun resumeSession(actor: Actor = facilitatorActor): SessionCommand.ResumeSession =
    SessionCommand.ResumeSession(actor, t0)

fun submitProxy(
    role: Role,
    quantity: Int,
    week: Int = 1,
    actor: Actor = facilitatorActor,
): SessionCommand.SubmitProxyDecision = SessionCommand.SubmitProxyDecision(actor, t0, role, w(week), q(quantity))

// ---- Session: イベントと状態 ----

/** 進行役の代理入力（入力者は、そのゲームの進行役）。 */
val facilitatorEditor: Editor = Editor.ByFacilitator(gid)

fun proxyDecisionSubmitted(
    role: Role,
    quantity: Int,
    version: Long = 1,
    submittedRoleCount: Int = 1,
    week: Int = 1,
): SessionEvent.ProxyDecisionSubmitted =
    SessionEvent.ProxyDecisionSubmitted(w(week), role, q(quantity), dv(version), facilitatorEditor, submittedRoleCount)

/** 同じ役割が、同じ週に [times] 回保存した事実（版は 1 から [times] まで。入力済みの数は 1）。 */
fun savedTimes(
    role: Role,
    times: Int,
    week: Int = 1,
): List<SessionEvent> = (1..times).map { decisionSaved(role, it, version = it.toLong(), week = week) }

/** 役割ごとの参加者（工場 = 参加者 1 … 小売店 = 参加者 4）。 */
val assignedParticipants: RoleMap<Set<ParticipantId>> = RoleMap.of { setOf(pid(it.ordinal + 1)) }

fun sessionStarted(settings: GameSettings = gameSettings()): SessionEvent.SessionStarted =
    SessionEvent.SessionStarted(
        gid,
        settings,
        assignedParticipants,
        KitPreset.initialStates(settings.demand),
        settings.commitMode,
    )

fun decisionSaved(
    role: Role,
    quantity: Int,
    version: Long = 1,
    submittedRoleCount: Int = 1,
    week: Int = 1,
): SessionEvent.DecisionSaved =
    SessionEvent.DecisionSaved(
        w(week),
        role,
        q(quantity),
        dv(version),
        Editor.ByParticipant(pid(role.ordinal + 1)),
        submittedRoleCount,
    )

fun sessionOf(vararg events: SessionEvent): SessionState =
    events.fold<SessionEvent, SessionState>(SessionState.NotStarted, ::evolveSession)

fun sessionDataOf(state: SessionState): SessionData =
    when (state) {
        is SessionState.Active -> state.data
        is SessionState.Paused -> state.data
        is SessionState.Ended -> state.data
        is SessionState.NotStarted -> fail("セッションが開始されていない")
    }

/** 4 役割が揃って入力した、その週のイベント（上流から下流の順で、入力済みの数は 1〜4）。 */
fun allSavedEvents(
    decisions: RoleMap<Quantity>,
    week: Int = 1,
): List<SessionEvent> =
    Role.entries.mapIndexed { i, role ->
        SessionEvent.DecisionSaved(
            w(week),
            role,
            decisions[role],
            dv(1),
            Editor.ByParticipant(pid(role.ordinal + 1)),
            i + 1,
        )
    }

/**
 * 確定した週のイベント。結果は `simulateWeek` を直接呼んで作る（`decideSession` を使わず、Given を独立に組み立てる）。
 * 最終週なら `SessionEnded` も付く。
 */
fun committedWeekEvents(
    before: SessionState,
    decisions: RoleMap<Quantity>,
): List<SessionEvent> {
    val data = sessionDataOf(before)
    val outcome = simulateWeek(data.settings.simulation(), data.week, data.roleStates, decisions)
    val committed =
        SessionEvent.WeekCommitted(data.week, CommitKind.MANUAL, decisions, outcome.results, outcome.nextStates, 4)
    return if (data.week == data.settings.finalWeek) {
        listOf(committed, SessionEvent.SessionEnded(EndReason.FINAL_WEEK))
    } else {
        listOf(committed)
    }
}

/** 開始から [weeks] 週ぶん、毎週すべて [decision] で入力して確定した後の状態とイベント列。 */
fun sessionPlayed(
    weeks: Int,
    decision: Int = 4,
    settings: GameSettings = gameSettings(),
): Pair<SessionState, List<SessionEvent>> {
    val started = sessionStarted(settings)
    return (1..weeks).fold(sessionOf(started) to listOf<SessionEvent>(started)) { (state, history), week ->
        val decisions = same(decision)
        val saved = allSavedEvents(decisions, week)
        val committed = committedWeekEvents(foldSession(state, saved), decisions)
        val events = saved + committed
        foldSession(state, events) to (history + events)
    }
}

private fun foldSession(
    state: SessionState,
    events: List<SessionEvent>,
): SessionState = events.fold(state, ::evolveSession)

/** イベント列にただ 1 つ含まれる `WeekCommitted`。 */
fun committedOf(events: List<SessionEvent>): SessionEvent.WeekCommitted =
    events.filterIsInstance<SessionEvent.WeekCommitted>().single()
