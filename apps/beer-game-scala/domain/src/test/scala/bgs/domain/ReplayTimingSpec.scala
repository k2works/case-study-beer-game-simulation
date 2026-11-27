package bgs.domain

import bgs.domain.DomainFixtures.*
import munit.FunSuite

/** 最大のゲーム（最終週 50）の再生の時間の実測（B12。NF-P18 の根拠）。投影表が無いので、要求ごとの状態の復元は、この再生になる。
  * 時間の上限は、環境の揺れで落ちない大きさ（目標は実測で決める）。測った値は、標準出力と終了報告に残す。
  */
class ReplayTimingSpec extends FunSuite:

  private val finalWeek = 50
  private val savesPerRoleWeek = 3

  private def maxGameEvents: List[SessionEvent] =
    val s = settings(finalWeek)
    val assignments = RoleMap.of(role => Set(holder(role)))
    val start = SessionEvent.SessionStarted(
      gameId,
      s,
      assignments,
      KitPreset.initialStates(s.demand, s.initial, s.delays),
      CommitMode.Manual
    )
    def step(state: SessionState, events: List[SessionEvent], command: SessionCommand) =
      Session.handle(state, command).fold(e => fail(e.toString), identity) match
        case produced => (produced.foldLeft(state)(SessionEvents.apply), events ++ produced)
    val first = SessionEvents.apply(SessionState.NotStarted, start)
    val (_, all) = (1 to finalWeek)
      .foldLeft((first, List[SessionEvent](start))) { case ((state0, events0), w) =>
        val saved = Role.values.toList.foldLeft((state0, events0)) { (acc, role) =>
          (1 to savesPerRoleWeek).foldLeft(acc) { (inner, n) =>
            step(
              inner._1,
              inner._2,
              SessionCommand.SaveDecision(
                Actor.Participant(holder(role)),
                at,
                role,
                week(w),
                quantity(4 + n),
                DecisionVersion.of((n - 1).toLong)
              )
            )
          }
        }
        val basis = saved._1 match
          case SessionState.Active(data, _) => data.decisionVersions
          case other                        => fail(s"進行中のはず: $other")
        step(saved._1, saved._2, SessionCommand.CommitWeek(facilitator, at, week(w), basis))
      }
    all

  test("[NF-P18] 最終週 50 のゲームの再生は、要求ごとに行える時間に収まる（実測）") {
    val events = maxGameEvents
    val runs = 7
    val millis = (1 to runs).toList.map { _ =>
      val t0 = System.nanoTime
      val replayed = Replay.session(events)
      val elapsed = (System.nanoTime - t0) / 1000000.0
      assert(replayed.invalid.isEmpty)
      elapsed
    }
    val median = millis.sorted.apply(runs / 2)
    val line =
      f"[NF-P18 実測] 最終週 $finalWeek%d・${events.size}%d イベントの再生: 中央値 $median%.1f ms（${millis.map(m => f"$m%.1f").mkString(", ")}）\n"
    // 標準出力は使わず（規約）、測った値は target に残す。終了報告に転記する
    val out = java.nio.file.Paths.get("target/replay-timing.txt")
    val _ = java.nio.file.Files.createDirectories(out.toAbsolutePath.getParent)
    val _ = java.nio.file.Files.writeString(out, line)
    assert(median < 1000.0, s"再生が遅い: $median ms")
  }
