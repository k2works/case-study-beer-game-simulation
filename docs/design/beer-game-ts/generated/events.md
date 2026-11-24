---
type: Design
title: "イベント一覧（生成）"
description: "ドメインイベントの一覧。コードの共用体型から生成した。手で編集しない。"
tags: [design, living-documentation, generated]
status: draft
generated: { by: "script:apps/beer-game-ts/scripts/living-docs.ts", at: 2026-11-24T06:28:25.088Z }
---
# イベント一覧（生成）

> **自動生成**: このファイルは `npm run docs:living` で、コードの共用体型（`GameEvent`・`SessionEvent`）から生成しています。直接編集せず、コードを直してください（CI が、コードとの一致と、設計書の表との不一致を検査します）。

実装済みのドメインイベント 14 種類。名前が [ドメインモデル設計](../domain-model.md) の「ドメインイベント」の表に無いときは、検査が失敗します。発行する契機は、設計書の表を参照してください。

| イベント | 集約 | ペイロードの項目 | 場所 |
| :--- | :--- | :--- | :--- |
| `GameCreated` | Game | `gameId`、`kind`、`changes` | [`src/domain/game.ts`](https://github.com/k2works/case-study-beer-game-simulation/blob/develop/apps/beer-game-ts/src/domain/game.ts) |
| `ParticipantJoined` | Game | `gameId`、`participantId` | [`src/domain/game.ts`](https://github.com/k2works/case-study-beer-game-simulation/blob/develop/apps/beer-game-ts/src/domain/game.ts) |
| `RoleAssigned` | Game | `gameId`、`participantId`、`role` | [`src/domain/game.ts`](https://github.com/k2works/case-study-beer-game-simulation/blob/develop/apps/beer-game-ts/src/domain/game.ts) |
| `RoleUnassigned` | Game | `gameId`、`participantId` | [`src/domain/game.ts`](https://github.com/k2works/case-study-beer-game-simulation/blob/develop/apps/beer-game-ts/src/domain/game.ts) |
| `RoleReplaced` | Game | `gameId`、`participantId`、`role`、`replacedParticipantIds` | [`src/domain/game.ts`](https://github.com/k2works/case-study-beer-game-simulation/blob/develop/apps/beer-game-ts/src/domain/game.ts) |
| `GameStarted` | Game | `gameId` | [`src/domain/game.ts`](https://github.com/k2works/case-study-beer-game-simulation/blob/develop/apps/beer-game-ts/src/domain/game.ts) |
| `SessionStarted` | Session | `gameId`、`sessionId` | [`src/domain/session.ts`](https://github.com/k2works/case-study-beer-game-simulation/blob/develop/apps/beer-game-ts/src/domain/session.ts) |
| `DecisionSaved` | Session | `sessionId`、`week`、`role`、`quantity`、`savedBy`、`version` | [`src/domain/session.ts`](https://github.com/k2works/case-study-beer-game-simulation/blob/develop/apps/beer-game-ts/src/domain/session.ts) |
| `ProxyDecisionSubmitted` | Session | `sessionId`、`week`、`role`、`quantity`、`version`、`operator`、`at` | [`src/domain/session.ts`](https://github.com/k2works/case-study-beer-game-simulation/blob/develop/apps/beer-game-ts/src/domain/session.ts) |
| `WeekCommitted` | Session | `sessionId`、`record` | [`src/domain/session.ts`](https://github.com/k2works/case-study-beer-game-simulation/blob/develop/apps/beer-game-ts/src/domain/session.ts) |
| `AutoCommitChanged` | Session | `sessionId`、`commitMode` | [`src/domain/session.ts`](https://github.com/k2works/case-study-beer-game-simulation/blob/develop/apps/beer-game-ts/src/domain/session.ts) |
| `SessionPaused` | Session | `sessionId` | [`src/domain/session.ts`](https://github.com/k2works/case-study-beer-game-simulation/blob/develop/apps/beer-game-ts/src/domain/session.ts) |
| `SessionResumed` | Session | `sessionId` | [`src/domain/session.ts`](https://github.com/k2works/case-study-beer-game-simulation/blob/develop/apps/beer-game-ts/src/domain/session.ts) |
| `SessionEnded` | Session | `sessionId` | [`src/domain/session.ts`](https://github.com/k2works/case-study-beer-game-simulation/blob/develop/apps/beer-game-ts/src/domain/session.ts) |

## 設計書にあり、まだ実装が無いイベント

- `ObserverInvited`
- `ObserverInvitationRevoked`
- `CredentialRevoked`
- `CredentialReissued`
- `ParticipationRecovered`
