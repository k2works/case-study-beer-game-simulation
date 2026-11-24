---
type: Design
title: "コアのハイライト（生成）"
description: "ドメインの中核（シミュレーション計算と進行）の主要な概念を、注釈 @CoreConcept から動的に選び出して示す案内。新しく参加する開発者が、まず読むコードの入口になる。手で編集しない。"
tags: [design, generated]
status: draft
---

# コアのハイライト（生成）

この文書は、コードの注釈とソースから生成した。手で編集しない（試験 `LivingDocumentationSpec` が、コードとの不一致で失敗する）。再生成: `./gradlew :domain:generateLivingDocs`。

**ここが核心。** このゲームの中核は、遅延と意思決定が変動を増幅する過程を忠実に計算すること（シミュレーション計算）と、
4 役割の入力を揃えて週を一度だけ確定すること（進行）。新しく参加する人は、まず下の 5 つを読む。

選び方: 注釈 `@CoreConcept` を付けた概念だけを、コンテキストごとに示す（名前や場所は名指ししない。改名や移動に追従する）。
中核かどうかは、[ドメインモデル設計](../domain-model.md)の「境界付けられたコンテキストの分類」が正本で、
補完・一般のコンテキストの概念は載せない（試験が検出する）。付ける数は 10 個以内に絞る。

## シミュレーション計算

中核の理由（設計書）: JSD 改訂版キットの 12 ステップと遅延を忠実に再現することが教材価値そのもの

| 種別 | 名前 | 場所 | なぜ核心か |
| :--- | :--- | :--- | :--- |
| 型 | `Pipeline` | [`apps/beer-game-kotlin/domain/src/main/kotlin/beergame/domain/SimulateWeek.kt`](https://github.com/k2works/case-study-beer-game-simulation/blob/develop/apps/beer-game-kotlin/domain/src/main/kotlin/beergame/domain/SimulateWeek.kt) | 遅延の表現。注文と出荷が遅れて届くことが、変動の増幅（ブルウィップ効果）の原因で、教材が見せたい現象そのもの。長さは遅延 - 1 |
| 関数 | `simulateWeek` | [`apps/beer-game-kotlin/domain/src/main/kotlin/beergame/domain/SimulateWeek.kt`](https://github.com/k2works/case-study-beer-game-simulation/blob/develop/apps/beer-game-kotlin/domain/src/main/kotlin/beergame/domain/SimulateWeek.kt) | 1 週の計算の入口。JSD 改訂版キットの 12 ステップと遅延を忠実に再現する。副作用が無く、同じ入力から同じ結果を返すので、golden テストと性質テストで守る |

## 進行（プレイ）

中核の理由（設計書）: 4 役割の意思決定を揃えて週を一度だけ確定する整合性。共同入力と自動確定がここにある

| 種別 | 名前 | 場所 | なぜ核心か |
| :--- | :--- | :--- | :--- |
| 型 | `SessionState` | [`apps/beer-game-kotlin/domain/src/main/kotlin/beergame/domain/Session.kt`](https://github.com/k2works/case-study-beer-game-simulation/blob/develop/apps/beer-game-kotlin/domain/src/main/kotlin/beergame/domain/Session.kt) | 進行の状態（未開始・進行中・一時停止・終了）。session ストリームのイベントを畳み込んだ結果で、4 役割の入力を揃えて週を一度だけ確定する整合性の土台 |
| 関数 | `decideSession` | [`apps/beer-game-kotlin/domain/src/main/kotlin/beergame/domain/Session.kt`](https://github.com/k2works/case-study-beer-game-simulation/blob/develop/apps/beer-game-kotlin/domain/src/main/kotlin/beergame/domain/Session.kt) | 進行の規則のすべてが集まる場所。入力の保存・代理入力・停止と再開・手動と自動の確定の可否を決め、事実（イベント）だけを返す。共同入力と自動確定の整合性もここで守る |
| 関数 | `evolveSession` | [`apps/beer-game-kotlin/domain/src/main/kotlin/beergame/domain/SessionEvolve.kt`](https://github.com/k2works/case-study-beer-game-simulation/blob/develop/apps/beer-game-kotlin/domain/src/main/kotlin/beergame/domain/SessionEvolve.kt) | 事実（イベント）を状態へ畳み込む。規則を持たず、確定済みの結果を採用するだけなので、あとから再生しても同じ状態に戻る（イベントソーシングの土台） |

コアが事実として残すイベント（session ストリーム。[イベント一覧](./events.md)）:

- EV-S01 `SessionStarted`
- EV-S02 `SessionPaused`
- EV-S03 `SessionResumed`
- EV-S04 `SessionEnded`
- EV-S05 `DecisionSaved`
- EV-S06 `ProxyDecisionSubmitted`
- EV-S08 `WeekCommitted`
- EV-S09 `RoleHolderReplaced`
- EV-S10 `CommitModeChanged`
