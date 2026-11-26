package bgs.domain

import bgs.domain.DomainFixtures.*
import munit.FunSuite

/** Session 集約（進行）と startGame。入力の保存、手動の確定、最終週での終了（B1 の範囲）。 */
class SessionSpec extends FunSuite:

  private def save(role: Role, n: Int, expected: Long = 0L, requestedWeek: Int = 1) =
    SessionCommand.SaveDecision(
      Actor.Participant(holder(role)),
      at,
      role,
      week(requestedWeek),
      quantity(n),
      DecisionVersion.of(expected)
    )

  private def apply(state: SessionState, events: List[SessionEvent]): SessionState =
    events.foldLeft(state)(SessionEvents.apply)

  /** 4 役割が数量 4 を保存した第 1 週の進行中のセッション。 */
  private def allSaved: SessionState =
    Role.values.toList.foldLeft(startedSession) { (state, role) =>
      val events = Session.handle(state, save(role, 4)).fold(e => fail(e.toString), identity)
      apply(state, events)
    }

  private def basisOf(state: SessionState): RoleMap[DecisionVersion] =
    state match
      case SessionState.Active(data, _) => data.decisionVersions
      case other                        => fail(s"進行中のはず: $other")

  private def commit(state: SessionState, requestedWeek: Int = 1) =
    Session.handle(
      state,
      SessionCommand.CommitWeek(facilitator, at, week(requestedWeek), basisOf(state))
    )

  test("[AC1.2.3] 4 役割のそれぞれに 1 人以上が割り当て済みなら、開始で 2 つのストリームにイベントが作られる") {
    val decision = Start
      .decide(fullGame, SessionState.NotStarted, StartGame(facilitator, at))
      .fold(e => fail(e.toString), identity)
    assertEquals(decision.game, List(GameEvent.GameStarted(gameId)))
    assertEquals(decision.session.size, 1)
    assert(decision.session.headOption.exists(_.isInstanceOf[SessionEvent.SessionStarted]))
  }

  test("[AC1.2.3] 参加者のいない役割があれば、開始を拒否し、不足している役割を上流から下流の順に示す") {
    val onlyRetailer = List[GameEvent](
      GameEvent.GameCreated(gameId, joinCode, settings(), retention, expiresAt),
      GameEvent.ParticipantJoined(holder(Role.Retailer), expiresAt),
      GameEvent.RoleAssigned(holder(Role.Retailer), Role.Retailer)
    ).foldLeft[GameState](GameState.NotCreated)(GameEvents.apply)
    assertEquals(
      Start.decide(onlyRetailer, SessionState.NotStarted, StartGame(facilitator, at)),
      Left(GameError.StartConditionNotMet(List(Role.Factory, Role.Distributor, Role.Wholesaler)))
    )
  }

  test("[権限] 開始は進行役だけができる") {
    assertEquals(
      Start.decide(
        fullGame,
        SessionState.NotStarted,
        StartGame(Actor.Participant(holder(Role.Retailer)), at)
      ),
      Left(GameError.Forbidden("開始は進行役だけができる"))
    )
  }

  test("[二重の開始] 開始済みのゲームは、もう一度開始できない") {
    val started = GameEvents.apply(fullGame, GameEvent.GameStarted(gameId))
    assertEquals(
      Start.decide(started, startedSession, StartGame(facilitator, at)),
      Left(SessionError.AlreadyStarted)
    )
  }

  test("[AC2.2.1] 割り当てられた参加者は、自分の役割の数量を保存でき、意思決定の版が 1 になる") {
    val events =
      Session.handle(startedSession, save(Role.Retailer, 8)).fold(e => fail(e.toString), identity)
    assertEquals(events.size, 1)
    events.headOption match
      case Some(SessionEvent.DecisionSaved(w, role, q, version, editor, submitted)) =>
        assertEquals(
          (w.value, role, q.value, version.value, submitted),
          (1, Role.Retailer, 8, 1L, 1)
        )
        assertEquals(editor, Editor.ByParticipant(holder(Role.Retailer)))
      case other => fail(s"DecisionSaved のはず: $other")
  }

  test("[AC2.2.2 権限] 他の役割の数量は保存できない") {
    val byOther = save(Role.Retailer, 8).copy(actor = Actor.Participant(holder(Role.Factory)))
    assertEquals(
      Session.handle(startedSession, byOther),
      Left(SessionError.Forbidden("その役割の参加者だけが入力できる"))
    )
    val byFacilitator = save(Role.Retailer, 8).copy(actor = facilitator)
    assertEquals(
      Session.handle(startedSession, byFacilitator),
      Left(SessionError.Forbidden("その役割の参加者だけが入力できる"))
    )
  }

  test("[AC2.2 競合] 期待した意思決定の版が古いと、DecisionConflict で最新値を返す") {
    val saved = apply(
      startedSession,
      Session.handle(startedSession, save(Role.Retailer, 8)).fold(e => fail(e.toString), identity)
    )
    val result = Session.handle(saved, save(Role.Retailer, 9, expected = 0L))
    result match
      case Left(SessionError.DecisionConflict(Role.Retailer, Some(latest))) =>
        assertEquals(latest.quantity.value, 8)
      case other => fail(s"DecisionConflict のはず: $other")
  }

  test("[週の不一致] 古い画面の週で保存すると WeekAdvanced") {
    assertEquals(
      Session.handle(startedSession, save(Role.Retailer, 8, requestedWeek = 2)),
      Left(SessionError.WeekAdvanced(week(2), week(1)))
    )
  }

  test("[NF-C8] 1 役割・1 週あたりの保存は 9 回まで") {
    val state = (1 to 9).foldLeft(startedSession) { (s, i) =>
      apply(
        s,
        Session
          .handle(s, save(Role.Retailer, i, expected = (i - 1).toLong))
          .fold(e => fail(e.toString), identity)
      )
    }
    assertEquals(
      Session.handle(state, save(Role.Retailer, 1, expected = 9L)),
      Left(SessionError.SaveLimitReached)
    )
  }

  test("[未開始] 開始前のセッションには保存も確定もできない") {
    assertEquals(
      Session.handle(SessionState.NotStarted, save(Role.Retailer, 8)),
      Left(SessionError.NotActive)
    )
  }

  test("[AC2.3.1] 4 役割の入力がそろい、週と版が一致すれば、進行役が確定でき、週が進む") {
    val events = commit(allSaved).fold(e => fail(e.toString), identity)
    assertEquals(events.size, 1)
    events.headOption match
      case Some(SessionEvent.WeekCommitted(w, kind, decisions, results, _, contributors)) =>
        assertEquals((w.value, kind, contributors), (1, CommitKind.Manual, 4))
        assertEquals(decisions.values.map(_.value), List(4, 4, 4, 4))
        assertEquals(results.values.map(_.weeklyCost.minor), List(600L, 600L, 600L, 600L))
      case other => fail(s"WeekCommitted のはず: $other")
    val next = apply(allSaved, events)
    next match
      case SessionState.Active(data, _) =>
        assertEquals(data.week.value, 2)
        assertEquals(data.decisions, Map.empty)
        assertEquals(data.roleStates(Role.Retailer).orders.value, 4L)
      case other => fail(s"進行中のはず: $other")
  }

  test("[AC2.3.2 一回性] 確定済みの週を、もう一度確定すると WeekAdvanced（週は一度だけ確定される）") {
    val state = allSaved
    val committed = apply(state, commit(state).fold(e => fail(e.toString), identity))
    assertEquals(
      Session
        .handle(committed, SessionCommand.CommitWeek(facilitator, at, week(1), basisOf(state))),
      Left(SessionError.WeekAdvanced(week(1), week(2)))
    )
  }

  test("[AC2.3 前提] 4 役割の入力がそろっていなければ、不足している役割を示して拒否する") {
    val oneSaved = apply(
      startedSession,
      Session.handle(startedSession, save(Role.Retailer, 8)).fold(e => fail(e.toString), identity)
    )
    assertEquals(
      commit(oneSaved),
      Left(SessionError.IncompleteDecisions(List(Role.Factory, Role.Distributor, Role.Wholesaler)))
    )
  }

  test("[D10] 確定の根拠にした意思決定の版が、確定の前に変わっていたら DecisionsChanged") {
    val state = allSaved
    val staleBasis = RoleMap.all(DecisionVersion.of(0L))
    val result =
      Session.handle(state, SessionCommand.CommitWeek(facilitator, at, week(1), staleBasis))
    assert(result.left.exists(_.isInstanceOf[SessionError.DecisionsChanged]))
  }

  test("[権限] 確定は進行役だけができる") {
    val state = allSaved
    assertEquals(
      Session.handle(
        state,
        SessionCommand
          .CommitWeek(Actor.Participant(holder(Role.Retailer)), at, week(1), basisOf(state))
      ),
      Left(SessionError.Forbidden("確定は進行役だけができる"))
    )
  }

  test("[最終週] 最終週の確定は、WeekCommitted のあとに SessionEnded も作り、終了する") {
    val finalWeekSettings = settings(1)
    val decisionStart = Start
      .decide(
        fullGame.pipe(g =>
          GameState.Preparing(
            g.dataOrNone.fold(fail("データがある"))(_.copy(settings = finalWeekSettings)),
            g.version
          )
        ),
        SessionState.NotStarted,
        StartGame(facilitator, at)
      )
      .fold(e => fail(e.toString), identity)
    val started = apply(SessionState.NotStarted, decisionStart.session)
    val saved = Role.values.toList.foldLeft(started) { (s, role) =>
      apply(s, Session.handle(s, save(role, 4)).fold(e => fail(e.toString), identity))
    }
    val events = commit(saved).fold(e => fail(e.toString), identity)
    assertEquals(events.size, 2)
    assertEquals(events.lastOption, Some(SessionEvent.SessionEnded(EndReason.FinalWeek)))
    assert(apply(saved, events).isInstanceOf[SessionState.Ended])
    assertEquals(
      Session.handle(apply(saved, events), save(Role.Retailer, 1)),
      Left(SessionError.AlreadyEnded)
    )
  }

  test("[AC2.3.4 決定論] 同じ状態と同じコマンドから、常に同じイベントを作る") {
    assertEquals(commit(allSaved), commit(allSaved))
  }

  test("[再生] decide が作らない列（開始前の入力の保存）は、不正な遷移として記録され、状態は変わらない") {
    val saved = SessionEvent.DecisionSaved(
      week(1),
      Role.Retailer,
      quantity(4),
      DecisionVersion.of(1L),
      Editor.ByParticipant(holder(Role.Retailer)),
      1
    )
    val replayed = Replay.session(List(saved))
    assertEquals(replayed.invalid.map(_.eventType), List("DecisionSaved"))
    assertEquals(replayed.state, SessionState.NotStarted)
  }

  extension [A](a: A) private def pipe[B](f: A => B): B = f(a)
