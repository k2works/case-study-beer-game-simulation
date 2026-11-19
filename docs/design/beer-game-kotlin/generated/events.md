---
type: Design
title: "イベント一覧（生成）"
description: "ドメインイベントの一覧。コードの注釈とソースから生成した。手で編集しない。"
tags: [design, generated]
status: draft
generated: { by: claude-code/claude-sonnet-5-5, at: 2026-11-15T09:21:42Z }
---

# イベント一覧（生成）

この文書は、コードの注釈とソースから生成した。手で編集しない（試験 `LivingDocumentationSpec` が、コードとの不一致で失敗する）。再生成: `./gradlew :domain:generateLivingDocs`。

実装済みのドメインイベント 21 種類。ID は[ドメインモデル設計](../domain-model.md)の「ドメインイベント」の表と同じで、
名前が違うとき、または実装にあって設計書の表に無いときは、試験が失敗する。
ストリームとペイロードの項目は型から、購読する投影は `Projection.kt` の走査から、発生する条件は注釈 `@EventSpec` から作る。

| ID | イベント | ストリーム | 発生する条件（コマンド） | ペイロードの項目 | 購読する投影（`Projections`） |
| :--- | :--- | :--- | :--- | :--- | :--- |
| EV-G01 | `GameCreated` | game | CreateGame。ストリームが空 | `gameId`、`joinCode`、`settings`、`retentionDays`、`facilitatorCredentialExpiresAt` | `gameOverview`、`gameJoinCodes`、`gameSettings`、`retentionPolicies` |
| EV-G02 | `ParticipantJoined` | game | JoinGame。準備中 | `participantId`、`credentialExpiresAt` | `lobbyParticipants` |
| EV-G03 | `RoleAssigned` | game | AssignRole。進行役、役割が変わる（準備中。開始後は入れ替えの新担当者） | `participantId`、`role` | `lobbyParticipants` |
| EV-G04 | `RoleUnassigned` | game | AssignRole による付け替え（解除の側）。単独の UnassignRole は未実装 | `participantId`、`role` | `lobbyParticipants` |
| EV-G05 | `ObserverInvited` | game | InviteObserver。進行役。準備中と開始後 | `invitationId`、`expiresAt` | `lobbyObserverInvitations` |
| EV-G06 | `ObserverInvitationRevoked` | game | RevokeObserverInvitation。進行役、失効していない招待（期限切れでも可） | `invitationId` | `lobbyObserverInvitations` |
| EV-G07 | `ObserverJoined` | game | JoinAsObserver。有効で期限内の招待（準備中と開始後） | `observerId`、`invitationId`、`credentialExpiresAt` | `lobbyObservers` |
| EV-G08 | `CredentialRevoked` | game | RevokeCredential。進行役、失効していない参加者の資格（期限切れでも可） | `subject` | なし |
| EV-G09 | `CredentialReissued` | game | ReissueCredential。進行役、失効した参加者の資格 | `subject`、`expiresAt` | なし |
| EV-G10 | `ParticipationRecovered` | game | RecoverParticipation。有効な復帰資格の持ち主 | `subject`、`credentialExpiresAt` | なし |
| EV-G11 | `GameStarted` | game | StartGame。進行役、準備中、各役割に 1 人以上 | `gameId` | `gameOverview` |
| EV-G12 | `ParticipantReplaced` | game | AssignRole（開始後の入れ替え）。進行役、旧担当者ごとに 1 件。同じ追記で CredentialRevoked と RoleHolderReplaced が付く | `participantId`、`role`、`replacedBy` | `lobbyParticipants` |
| EV-S01 | `SessionStarted` | session | StartGame（game ストリームの GameStarted と同一トランザクション） | `gameId`、`settings`、`assignments`、`initialStates`、`commitMode` | `sessionOverview`、`roleCurrentStates` |
| EV-S02 | `SessionPaused` | session | PauseSession。進行役、進行中 | なし | `sessionOverview` |
| EV-S03 | `SessionResumed` | session | ResumeSession。進行役、一時停止中 | なし | `sessionOverview` |
| EV-S04 | `SessionEnded` | session | 最終週の WeekCommitted と同じ decide。手動の EndSession は未実装 | `reason` | `gameOverview`、`sessionOverview` |
| EV-S05 | `DecisionSaved` | session | SaveDecision。進行中、その役割の参加者、意思決定の版が一致 | `week`、`role`、`quantity`、`decisionVersion`、`editor`、`submittedRoleCount` | `sessionOverview`、`currentDecisions` |
| EV-S06 | `ProxyDecisionSubmitted` | session | SubmitProxyDecision。進行役、進行中または一時停止中、requestedWeek が現在の週と一致 | `week`、`role`、`quantity`、`decisionVersion`、`editor`、`submittedRoleCount` | `sessionOverview`、`currentDecisions` |
| EV-S08 | `WeekCommitted` | session | CommitWeek（進行役、進行中、4 役割が揃う、週と意思決定の版が一致）。自動確定（B8）は、最後の入力・再開・方式の変更と同じ追記 | `week`、`commitKind`、`decisions`、`results`、`nextStates`、`contributors` | `sessionOverview`、`roleCurrentStates`、`currentDecisions`、`weekCommits`、`weekRoleResults`、`weekTeamTotals` |
| EV-S09 | `RoleHolderReplaced` | session | AssignRole（開始後の入れ替え）。game ストリームの ParticipantReplaced と同一トランザクション。進行中または一時停止中 | `role`、`removed`、`added` | なし |
| EV-S10 | `CommitModeChanged` | session | SetCommitMode。進行役、進行中または一時停止中 | `commitMode` | `gameOverview` |

## 設計書にあり、まだ実装が無いイベント

- EV-S07 `AutoCommitChanged`
