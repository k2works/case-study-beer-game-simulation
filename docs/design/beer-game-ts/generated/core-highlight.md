---
type: Design
title: "コアのハイライト（生成）"
description: "ドメインの中核の主要な宣言を、注釈 @core から動的に選び出した、新しく参加する人の読む入口。手で編集しない。"
tags: [design, living-documentation, generated]
status: draft
generated: { by: "script:apps/beer-game-ts/scripts/living-docs.ts", at: 2026-11-24T10:11:45.642Z }
---
# コアのハイライト（生成）

> **自動生成**: このファイルは `npm run docs:living` で、コードの `@core` から生成しています。直接編集せず、コードのタグを直してください。

**ここが核心。** このゲームの中核は、シミュレーション計算と、進行（プレイ）。新しく参加する人は、まず下の 4 つを読んでください。

選び方: 注釈 `@core` を付けた宣言だけを、コンテキストごとに示します（名前や場所は名指ししません。改名や移動に追従します）。中核かどうかは、[ドメインモデル設計](../domain-model.md) の「戦略的設計」が正本で、補完・一般のコンテキストの宣言は載せません（検査が失敗します）。付ける数は 10 個以内です。

## シミュレーション計算

| 名前 | 場所 | なぜ核心か |
| :--- | :--- | :--- |
| `simulateWeek` | [`apps/beer-game-ts/src/domain/simulate-week.ts`](https://github.com/k2works/case-study-beer-game-simulation/blob/develop/apps/beer-game-ts/src/domain/simulate-week.ts) | 週次の計算の入口。JSD 改訂版キットの 12 ステップと遅延を忠実に再現する、時刻・DB・認可に依存しない純粋関数で、golden とプロパティテストで守られている |

## 進行（プレイ）

| 名前 | 場所 | なぜ核心か |
| :--- | :--- | :--- |
| `Session` | [`apps/beer-game-ts/src/domain/session.ts`](https://github.com/k2works/case-study-beer-game-simulation/blob/develop/apps/beer-game-ts/src/domain/session.ts) | 4 役割の意思決定を揃えて週を一度だけ確定する整合性の土台。週・役割別の状態・発注・履歴を持ち、共同入力と自動確定の不変条件を守る |
| `saveDecision` | [`apps/beer-game-ts/src/domain/session.ts`](https://github.com/k2works/case-study-beer-game-simulation/blob/develop/apps/beer-game-ts/src/domain/session.ts) | 入力の保存の規則。担当の役割・進行中・範囲・版の一致を確かめ、古い画面からの上書きを拒否する。自動確定のときは、最後の保存と同じ操作で週を確定する |
| `commitWeek` | [`apps/beer-game-ts/src/domain/session.ts`](https://github.com/k2works/case-study-beer-game-simulation/blob/develop/apps/beer-game-ts/src/domain/session.ts) | 週を一度だけ確定する規則。4 役割がそろい、週と版が一致するときだけ確定し、計算は simulateWeek に任せて、役割別の週結果を履歴に積む |

コアが事実として残すイベント（[イベント一覧](./events.md)）: `GameCreated`、`ParticipantJoined`、`RoleAssigned`、`RoleUnassigned`、`RoleReplaced`、`GameStarted`、`SessionStarted`、`DecisionSaved`、`ProxyDecisionSubmitted`、`WeekCommitted`、`AutoCommitChanged`、`SessionPaused`、`SessionResumed`、`SessionEnded`
