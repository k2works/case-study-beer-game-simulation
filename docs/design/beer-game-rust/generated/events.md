---
type: Design
title: "イベント一覧（生成）"
description: "ドメインイベントの一覧。コードの注釈とソースから生成した。手で編集しない。"
tags: [design, generated]
status: draft
generated: { by: beergame-livingdoc }
---

# イベント一覧（生成）

この文書は、コードの注釈とソースから生成した。手で編集しない（試験 `livingdoc` が、コードとの差で失敗する）。再生成: `just livingdoc`（`cargo run -q -p beergame-livingdoc -- generate`）。

実装済みのドメインイベント 20 種類。ID は beer-game-kotlin の[ドメインモデル設計](../../beer-game-kotlin/domain-model.md)の「ドメインイベント」の表と同じで（[Rust 版の設計](../domain-model.md)は、この表を正本として引き継ぐ）、
名前が違うとき、または実装にあって設計書の表に無いときは、試験が失敗する。
ストリームとペイロードの項目は型から、書き込む投影のテーブルは `adapter-persistence` の `projection.rs` の走査から、発生する条件は注釈 `@event` から作る。

| ID | イベント | ストリーム | 発生する条件 | ペイロードの項目 | 書き込む投影のテーブル |
| :--- | :--- | :--- | :--- | :--- | :--- |
| EV-G01 | `GameCreated` | game | CreateGame。ストリームが空 | `game_id`、`join_code`、`settings`、`retention_days`、`facilitator_credential_expires_at` | `game_overview`、`retention_policies`、`game_join_codes`、`game_settings` |
| EV-G02 | `ParticipantJoined` | game | JoinGame。準備中 | `participant_id`、`credential_expires_at` | `lobby_participants` |
| EV-G03 | `RoleAssigned` | game | AssignRole。進行役、役割が変わる（準備中。開始後は入れ替えの新担当者） | `participant_id`、`role` | `lobby_participants` |
| EV-G04 | `RoleUnassigned` | game | AssignRole による付け替え（解除の側）。単独の UnassignRole は未実装 | `participant_id`、`role` | `lobby_participants` |
| EV-G05 | `ObserverInvited` | game | InviteObserver。進行役。準備中と開始後 | `invitation_id`、`expires_at` | `lobby_observer_invitations` |
| EV-G06 | `ObserverInvitationRevoked` | game | RevokeObserverInvitation。進行役、失効していない招待（期限切れでも可） | `invitation_id` | `lobby_observer_invitations` |
| EV-G07 | `ObserverJoined` | game | JoinAsObserver。有効で期限内の招待（準備中と開始後） | `observer_id`、`invitation_id` | `lobby_observers` |
| EV-G08 | `CredentialRevoked` | game | RevokeCredential。進行役、失効していない参加者の資格（期限切れでも可） | `participant_id` | なし |
| EV-G09 | `CredentialReissued` | game | ReissueCredential。進行役、失効した参加者の資格 | `participant_id`、`credential_expires_at` | なし |
| EV-G11 | `GameStarted` | game | StartGame。進行役、準備中、各役割に 1 人以上 | `game_id` | `game_overview` |
| EV-G12 | `ParticipantReplaced` | game | AssignRole（開始後の入れ替え）。進行役、旧担当者ごとに 1 件 | `participant_id`、`role`、`replaced` | `lobby_participants` |
| EV-S01 | `SessionStarted` | session | StartGame（game ストリームの GameStarted と同一トランザクション） | `game_id`、`settings`、`assignments`、`initial_states`、`commit_mode` | `session_overview` |
| EV-S02 | `SessionPaused` | session | PauseSession。進行役、進行中 | なし | `session_overview` |
| EV-S03 | `SessionResumed` | session | ResumeSession。進行役、一時停止中 | なし | `session_overview` |
| EV-S04 | `SessionEnded` | session | 最終週の WeekCommitted と同じ decide。手動の EndSession は未実装 | `reason` | `session_overview`、`game_overview` |
| EV-S05 | `DecisionSaved` | session | SaveDecision。進行中、その役割の参加者、意思決定の版が一致 | `week`、`role`、`quantity`、`decision_version`、`editor`、`submitted_role_count` | `current_decisions`、`session_overview` |
| EV-S06 | `ProxyDecisionSubmitted` | session | SubmitProxyDecision。進行役、進行中または一時停止中、requestedWeek が現在の週と一致 | `week`、`role`、`quantity`、`decision_version`、`operator`、`submitted_role_count` | `current_decisions`、`session_overview` |
| EV-S08 | `WeekCommitted` | session | CommitWeek（進行役、進行中、4 役割が揃う、週と意思決定の版が一致）。自動確定は、最後の入力・再開・方式の変更と同じ追記 | `week`、`commit_kind`、`decisions`、`results`、`next_states`、`contributors` | `week_commits`、`week_team_totals`、`week_role_results`、`role_current_states`、`current_decisions`、`session_overview` |
| EV-S09 | `RoleReplaced`（設計書では `RoleHolderReplaced`） | session | AssignRole（開始後の入れ替え）。game ストリームの ParticipantReplaced と同一トランザクション。進行中または一時停止中 | `role`、`new_holder` | なし |
| EV-S10 | `CommitModeChanged` | session | SetCommitMode。進行役、進行中または一時停止中 | `mode` | `game_overview` |

## 設計書にあり、まだ実装が無いイベント

- EV-G10 `ParticipationRecovered`
- EV-S07 `AutoCommitChanged`
