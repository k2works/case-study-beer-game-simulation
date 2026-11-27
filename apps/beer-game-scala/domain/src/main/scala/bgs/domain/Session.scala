package bgs.domain

import java.time.Instant

/*
 * Session 集約（進行。ストリーム `session`）。B1 の範囲: 入力の保存、手動の確定、最終週での終了。
 * 停止・再開・代理入力（B4）、共同入力（B5）、確定方式の変更と自動確定（B7）は後続の Bolt。
 * 開始（SessionStarted）は [[Start.decide]] が作る。
 */

/** 1 役割・1 週あたりの保存回数の上限（NF-C8）。 */
val SaveLimitPerRoleWeek: Long = 9L

/** 意思決定の版。役割ごと・週ごとに 0 から始まり、保存のたびに 1 増える（ストリームの版とは別）。 */
opaque type DecisionVersion = Long

object DecisionVersion:
  val Zero: DecisionVersion = 0L

  /** 境界で検証済みの値から作る。負数は 0 に丸める（版は 0 以上）。 */
  def of(n: Long): DecisionVersion = math.max(0L, n)

  extension (v: DecisionVersion)
    def value: Long = v
    def next: DecisionVersion = v + 1L

/** 確定の方式（イベントに残す）。手動（進行役の確定）か、自動（入力がそろったときの自動確定。B7）。 */
enum CommitKind:
  case Manual, Auto

/** 終了の理由。B1 は最終週の確定だけ。 */
enum EndReason:
  case FinalWeek

/** 入力した人。参加者の保存と、進行役の代理入力（B4）。 */
enum Editor:
  case ByParticipant(id: ParticipantId)
  case ByFacilitator(gameId: GameId)

/** 当週に保存された、1 役割の意思決定。 */
final case class DecisionEntry(quantity: Quantity, version: DecisionVersion, editor: Editor)

final case class SessionData(
    gameId: GameId,
    settings: GameSettings,
    assignments: RoleMap[Set[ParticipantId]],
    week: Week,
    roleStates: RoleMap[RoleState],
    decisions: Map[Role, DecisionEntry],
    decisionVersions: RoleMap[DecisionVersion],
    commitMode: CommitMode,
    paused: Boolean
):
  /** まだ入力されていない役割（上流から下流の順）。 */
  def missingRoles: List[Role] = Role.values.toList.filterNot(decisions.contains)

  /** 4 役割の入力がそろっているときだけ、役割ごとの数量。 */
  def completeDecisions: Option[RoleMap[Quantity]] =
    for
      factory <- decisions.get(Role.Factory)
      distributor <- decisions.get(Role.Distributor)
      wholesaler <- decisions.get(Role.Wholesaler)
      retailer <- decisions.get(Role.Retailer)
    yield RoleMap(factory.quantity, distributor.quantity, wholesaler.quantity, retailer.quantity)

  /** 保存の事実を採用する。意思決定の版は、当週の保存回数と同じ（保存のたびに 1 増え、確定で 0 に戻る）。 */
  private[domain] def withDecision(role: Role, saved: DecisionEntry): SessionData =
    copy(
      decisions = decisions.updated(role, saved),
      decisionVersions =
        decisionVersions.map((r, version) => if r == role then saved.version else version)
    )

  /** 当週に、この役割へ保存できる回数が残っているか。 */
  def hasSaveCapacity(role: Role): Boolean = decisionVersions(role).value < SaveLimitPerRoleWeek

  /** 確定の事実（次週の状態）を採用する。計算し直さない（D5）。最終週は週を進めない。 */
  private[domain] def afterCommit(nextStates: RoleMap[RoleState]): SessionData =
    copy(
      roleStates = nextStates,
      week = if week == settings.finalWeek then week else week.next.getOrElse(week),
      decisions = Map.empty,
      decisionVersions = RoleMap.all(DecisionVersion.Zero)
    )

enum SessionState:
  case NotStarted
  case Active(data: SessionData, version: StreamVersion)
  case Ended(data: SessionData, version: StreamVersion)

object SessionState:
  extension (state: SessionState)
    def version: StreamVersion = state match
      case SessionState.NotStarted   => StreamVersion.Zero
      case SessionState.Active(_, v) => v
      case SessionState.Ended(_, v)  => v

    def name: String = state match
      case SessionState.NotStarted   => "NotStarted"
      case SessionState.Active(_, _) => "Active"
      case SessionState.Ended(_, _)  => "Ended"

sealed trait SessionCommand:
  def actor: Actor
  def at: Instant

object SessionCommand:
  /** 進行役の一時停止（AC3.1.1）。 */
  final case class PauseSession(actor: Actor, at: Instant) extends SessionCommand

  /** 進行役が確定方式を変える（AC2.4.5）。自動にした時点で入力がそろっていれば、同じ追記で確定する。 */
  final case class SetCommitMode(actor: Actor, at: Instant, mode: CommitMode) extends SessionCommand

  /** 進行役の再開（AC3.1.3）。 */
  final case class ResumeSession(actor: Actor, at: Instant) extends SessionCommand

  /** 進行役の代理入力（AC3.1.2）。意思決定の版は要求しない。本文の週で、古い画面からの入力を区別する。 */
  final case class SubmitProxyDecision(
      actor: Actor,
      at: Instant,
      role: Role,
      requestedWeek: Week,
      quantity: Quantity
  ) extends SessionCommand

  /** 画面が表示している週 [[requestedWeek]] と、期待する意思決定の版を持つ。 */
  final case class SaveDecision(
      actor: Actor,
      at: Instant,
      role: Role,
      requestedWeek: Week,
      quantity: Quantity,
      expectedDecisionVersion: DecisionVersion
  ) extends SessionCommand

  /** 確定しようとしている週 [[requestedWeek]] と、確定の根拠にした各役割の意思決定の版 [[basis]]（D10）。 */
  final case class CommitWeek(
      actor: Actor,
      at: Instant,
      requestedWeek: Week,
      basis: RoleMap[DecisionVersion]
  ) extends SessionCommand

enum SessionEvent:
  /** 設定と役割の割り当ての写しを運ぶ。以後 session は game を読まない（D4）。[[gameId]] は session の識別子でもある。 */
  case SessionStarted(
      gameId: GameId,
      settings: GameSettings,
      assignments: RoleMap[Set[ParticipantId]],
      initialStates: RoleMap[RoleState],
      commitMode: CommitMode
  )

  case DecisionSaved(
      week: Week,
      role: Role,
      quantity: Quantity,
      decisionVersion: DecisionVersion,
      editor: Editor,
      submittedRoleCount: Int
  )

  /** 1 週の事実のすべて。結果と次週の状態を含み、evolve はそれを採用するだけ（D5）。 */
  case WeekCommitted(
      week: Week,
      commitKind: CommitKind,
      decisions: RoleMap[Quantity],
      results: RoleMap[RoleWeekResult],
      nextStates: RoleMap[RoleState],
      contributors: Int
  )

  case SessionEnded(reason: EndReason)

  case SessionPaused
  case SessionResumed

  /** 確定方式の変更（AC2.4.5）。 */
  case CommitModeChanged(mode: CommitMode)

  /** 開始後の役割の入れ替え。役割ごとの担当者の全体を置き換える（D4: session は開始時の写しを持つ）。 */
  case AssignmentsReplaced(assignments: RoleMap[Set[ParticipantId]])

  def name: String = this match
    case SessionEvent.SessionStarted(_, _, _, _, _)   => "SessionStarted"
    case SessionEvent.DecisionSaved(_, _, _, _, _, _) => "DecisionSaved"
    case SessionEvent.WeekCommitted(_, _, _, _, _, _) => "WeekCommitted"
    case SessionEvent.SessionEnded(_)                 => "SessionEnded"
    case SessionEvent.SessionPaused                   => "SessionPaused"
    case SessionEvent.SessionResumed                  => "SessionResumed"
    case SessionEvent.CommitModeChanged(_)            => "CommitModeChanged"
    case SessionEvent.AssignmentsReplaced(_)          => "AssignmentsReplaced"

enum SessionError(val code: String, val category: ErrorCategory) extends DomainError:
  /** セッションが始まっていない（未開始）。 */
  case NotActive extends SessionError("session.not_active", ErrorCategory.InvalidState)

  /** 1 役割・1 週あたりの保存回数の上限（[[SaveLimitPerRoleWeek]] 回）に達した。 */
  case SaveLimitReached
      extends SessionError("session.save_limit_reached", ErrorCategory.InvalidState)

  /** 停止中（参加者の保存と週の確定を拒否する。まだ始まっていない [[NotActive]] とは別）。 */
  case Paused extends SessionError("session.paused", ErrorCategory.InvalidState)
  case NotPaused extends SessionError("session.not_paused", ErrorCategory.InvalidState)
  case AlreadyEnded extends SessionError("session.already_ended", ErrorCategory.InvalidState)
  case AlreadyStarted extends SessionError("session.already_started", ErrorCategory.InvalidState)
  case Forbidden(reason: String) extends SessionError("session.forbidden", ErrorCategory.Forbidden)

  /** 確定で週が進んだ後の要求。共同入力の競合（[[DecisionConflict]]）とは別。 */
  case WeekAdvanced(requested: Week, current: Week)
      extends SessionError("session.week_advanced", ErrorCategory.Conflict)

  /** 同じ役割の入力で、期待した版が古い。最新値と最後の保存者を返す。 */
  case DecisionConflict(role: Role, latest: Option[DecisionEntry])
      extends SessionError("session.decision_conflict", ErrorCategory.Conflict)

  /** 確定の根拠にした入力が、確定の前に変わった。現在の値と保存者を返す。 */
  case DecisionsChanged(week: Week, current: Map[Role, DecisionEntry])
      extends SessionError("session.decisions_changed", ErrorCategory.Conflict)

  /** 4 役割の入力がそろっていない週は確定できない。不足している役割を示す。 */
  case IncompleteDecisions(missing: List[Role])
      extends SessionError("session.incomplete_decisions", ErrorCategory.RuleViolation)

object Session:

  /** 進行中のときだけデータを返す。 */
  private def activeData(state: SessionState): Either[SessionError, SessionData] = state match
    case SessionState.Active(data, _) => Right(data)
    case SessionState.NotStarted      => Left(SessionError.NotActive)
    case SessionState.Ended(_, _)     => Left(SessionError.AlreadyEnded)

  /** 入力できるのは、その役割に割り当てられた参加者だけ（開始時の写しで確認する）。 */
  private def editorOf(
      actor: Actor,
      role: Role,
      assignments: RoleMap[Set[ParticipantId]]
  ): Either[SessionError, Editor] = actor match
    case Actor.Participant(id) if assignments(role).contains(id) => Right(Editor.ByParticipant(id))
    case _ => Left(SessionError.Forbidden("その役割の参加者だけが入力できる"))

  private def facilitatorOnly(
      actor: Actor,
      data: SessionData,
      what: String
  ): Either[SessionError, Unit] =
    Either.cond(actor.isFacilitatorOf(data.gameId), (), SessionError.Forbidden(s"$what は進行役だけができる"))

  /** 自動確定。確定方式が自動で、停止中でなく、4 役割の入力がそろっているときだけ、確定のイベントを作る（AC2.4.1・2.4.3）。 [[after]]
    * は、直前の変化を採用した後のデータ。
    */
  private def autoCommitEvents(after: SessionData): List[SessionEvent] =
    if after.commitMode == CommitMode.Auto && !after.paused then
      after.completeDecisions.fold(List.empty[SessionEvent])(decisions =>
        weekCommitEvents(after, decisions, CommitKind.Auto)
      )
    else Nil

  private def setCommitModeEvents(
      data: SessionData,
      command: SessionCommand.SetCommitMode
  ): Either[SessionError, List[SessionEvent]] =
    facilitatorOnly(command.actor, data, "確定方式の変更").map { _ =>
      if data.commitMode == command.mode then Nil
      else
        SessionEvent.CommitModeChanged(command.mode) ::
          autoCommitEvents(data.copy(commitMode = command.mode))
    }

  private def pauseEvents(
      data: SessionData,
      command: SessionCommand.PauseSession
  ): Either[SessionError, List[SessionEvent]] =
    for
      _ <- facilitatorOnly(command.actor, data, "停止")
      _ <- Either.cond(!data.paused, (), SessionError.Paused)
    yield List(SessionEvent.SessionPaused)

  private def resumeEvents(
      data: SessionData,
      command: SessionCommand.ResumeSession
  ): Either[SessionError, List[SessionEvent]] =
    for
      _ <- facilitatorOnly(command.actor, data, "再開")
      _ <- Either.cond(data.paused, (), SessionError.NotPaused)
    yield SessionEvent.SessionResumed :: autoCommitEvents(data.copy(paused = false))

  /** 代理入力は、進行中と停止中の両方で受け付け、週は確定しない。版は 1 増える（保存回数に数える）。 */
  private def proxyEvents(
      data: SessionData,
      command: SessionCommand.SubmitProxyDecision
  ): Either[SessionError, List[SessionEvent]] =
    val current = data.decisionVersions(command.role)
    for
      _ <- facilitatorOnly(command.actor, data, "代理入力")
      _ <- Either.cond(
        command.requestedWeek == data.week,
        (),
        SessionError.WeekAdvanced(command.requestedWeek, data.week)
      )
      _ <- Either.cond(data.hasSaveCapacity(command.role), (), SessionError.SaveLimitReached)
    yield
      val editor = Editor.ByFacilitator(data.gameId)
      val saved = SessionEvent.DecisionSaved(
        data.week,
        command.role,
        command.quantity,
        current.next,
        editor,
        (data.decisions.keySet + command.role).size
      )
      saved :: autoCommitEvents(
        data.withDecision(command.role, DecisionEntry(command.quantity, current.next, editor))
      )

  private def saveDecisionEvents(
      data: SessionData,
      command: SessionCommand.SaveDecision
  ): Either[SessionError, List[SessionEvent]] =
    val current = data.decisionVersions(command.role)
    for
      _ <- Either.cond(!data.paused, (), SessionError.Paused)
      editor <- editorOf(command.actor, command.role, data.assignments)
      _ <- Either.cond(
        command.requestedWeek == data.week,
        (),
        SessionError.WeekAdvanced(command.requestedWeek, data.week)
      )
      _ <- Either.cond(
        command.expectedDecisionVersion == current,
        (),
        SessionError.DecisionConflict(command.role, data.decisions.get(command.role))
      )
      _ <- Either.cond(data.hasSaveCapacity(command.role), (), SessionError.SaveLimitReached)
    yield
      val submitted = (data.decisions.keySet + command.role).size
      val saved = SessionEvent.DecisionSaved(
        data.week,
        command.role,
        command.quantity,
        current.next,
        editor,
        submitted
      )
      saved :: autoCommitEvents(
        data.withDecision(command.role, DecisionEntry(command.quantity, current.next, editor))
      )

  /** 4 役割の入力から、週の確定のイベントを作る。最終週なら `SessionEnded` も返す。 */
  private def weekCommitEvents(
      data: SessionData,
      decisions: RoleMap[Quantity],
      kind: CommitKind
  ): List[SessionEvent] =
    val outcome = simulateWeek(data.settings.simulation, data.week, data.roleStates, decisions)
    val committed = SessionEvent.WeekCommitted(
      data.week,
      kind,
      decisions,
      outcome.results,
      outcome.nextStates,
      Role.values.length
    )
    if data.week == data.settings.finalWeek then
      List(committed, SessionEvent.SessionEnded(EndReason.FinalWeek))
    else List(committed)

  private def commitWeekEvents(
      data: SessionData,
      command: SessionCommand.CommitWeek
  ): Either[SessionError, List[SessionEvent]] =
    for
      _ <- Either.cond(
        command.actor.isFacilitatorOf(data.gameId),
        (),
        SessionError.Forbidden("確定は進行役だけができる")
      )
      _ <- Either.cond(!data.paused, (), SessionError.Paused)
      // 判定順 1: 週が違えば WeekAdvanced
      _ <- Either.cond(
        command.requestedWeek == data.week,
        (),
        SessionError.WeekAdvanced(command.requestedWeek, data.week)
      )
      // 判定順 2: 週は同じで、確定の根拠にした入力の版が現在と違えば DecisionsChanged
      _ <- Either.cond(
        command.basis == data.decisionVersions,
        (),
        SessionError.DecisionsChanged(data.week, data.decisions)
      )
      decisions <- data.completeDecisions.toRight(
        SessionError.IncompleteDecisions(data.missingRoles)
      )
    yield weekCommitEvents(data, decisions, CommitKind.Manual)

  /** 入力の保存と確定の規則は、ここに集まる。`simulateWeek`（純粋）は確定のときだけ呼び、結果と次週の状態を事実として固定する。 */
  def handle(
      state: SessionState,
      command: SessionCommand
  ): Either[SessionError, List[SessionEvent]] =
    activeData(state).flatMap { data =>
      command match
        case c: SessionCommand.SaveDecision        => saveDecisionEvents(data, c)
        case c: SessionCommand.CommitWeek          => commitWeekEvents(data, c)
        case c: SessionCommand.SetCommitMode       => setCommitModeEvents(data, c)
        case c: SessionCommand.PauseSession        => pauseEvents(data, c)
        case c: SessionCommand.ResumeSession       => resumeEvents(data, c)
        case c: SessionCommand.SubmitProxyDecision => proxyEvents(data, c)
    }

object SessionEvents:

  /** 進行中のときだけデータを更新して版を進める。decide が作らない列は、状態を変えずに返す。 */
  private def updateData(state: SessionState)(update: SessionData => SessionData): SessionState =
    state match
      case SessionState.Active(data, version) => SessionState.Active(update(data), version.next)
      case SessionState.NotStarted | SessionState.Ended(_, _) => state

  /** イベントを状態へ畳み込む。全域（例外を投げない）。`WeekCommitted` の `nextStates` はそのまま採用し、 `simulateWeek`
    * を呼ばない（D5）。decide が作らない列は、状態を変えずに返す（版も増えない。検知は [[Replay.session]]）。
    */
  def apply(state: SessionState, event: SessionEvent): SessionState = event match
    case SessionEvent.SessionStarted(gameId, settings, assignments, initialStates, commitMode) =>
      state match
        case SessionState.NotStarted =>
          SessionState.Active(
            SessionData(
              gameId = gameId,
              settings = settings,
              assignments = assignments,
              week = Week.first,
              roleStates = initialStates,
              decisions = Map.empty,
              decisionVersions = RoleMap.all(DecisionVersion.Zero),
              commitMode = commitMode,
              paused = false
            ),
            state.version.next
          )
        case SessionState.Active(_, _) | SessionState.Ended(_, _) => state
    case SessionEvent.DecisionSaved(_, role, quantity, version, editor, _) =>
      updateData(state)(_.withDecision(role, DecisionEntry(quantity, version, editor)))
    case SessionEvent.WeekCommitted(_, _, _, _, nextStates, _) =>
      updateData(state)(_.afterCommit(nextStates))
    case SessionEvent.AssignmentsReplaced(assignments) =>
      updateData(state)(_.copy(assignments = assignments))
    case SessionEvent.CommitModeChanged(mode) => updateData(state)(_.copy(commitMode = mode))
    case SessionEvent.SessionPaused           => updateData(state)(_.copy(paused = true))
    case SessionEvent.SessionResumed          => updateData(state)(_.copy(paused = false))
    case SessionEvent.SessionEnded(_)         =>
      state match
        case SessionState.Active(data, version) => SessionState.Ended(data, version.next)
        case SessionState.NotStarted | SessionState.Ended(_, _) => state
