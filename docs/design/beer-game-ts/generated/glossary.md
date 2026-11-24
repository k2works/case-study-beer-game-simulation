---
type: Design
title: "用語集（生成）"
description: "ユビキタス言語の用語集。コードの注釈 @term から生成した。手で編集しない。"
tags: [design, living-documentation, generated]
status: draft
generated: { by: "script:apps/beer-game-ts/scripts/living-docs.ts", at: 2026-11-24T06:28:25.093Z }
---
# 用語集（生成）

> **自動生成**: このファイルは `npm run docs:living` で、コードの `@term` から生成しています。直接編集せず、コードのタグを直してください（CI が、コードとの一致と、設計書の用語との不一致を検査します）。

注釈 `@term` を付けた宣言の 7 項目。これから書くコードと、新しく足す概念から付け始めます（既存コードへの一括適用はしません）。全体のユビキタス言語は [ドメインモデル設計](../domain-model.md) を参照してください。

| 用語 | コード上の名称 | 定義 | 出典 |
| :--- | :--- | :--- | :--- |
| ゲーム | `Game`（[`src/domain/game.ts`](https://github.com/k2works/case-study-beer-game-simulation/blob/develop/apps/beer-game-ts/src/domain/game.ts)） | 1 回のシミュレーション実施単位。設定、参加者、役割の割り当てを持つ | ドメインモデル ユビキタス言語 |
| セッション | `Session`（[`src/domain/session.ts`](https://github.com/k2works/case-study-beer-game-simulation/blob/develop/apps/beer-game-ts/src/domain/session.ts)） | ゲームの進行状態（週・状態・版・役割の状態・意思決定）を持つ実行単位 | ドメインモデル ユビキタス言語 |
| 公開範囲 | `DisclosurePolicy`（[`src/domain/conditions.ts`](https://github.com/k2works/case-study-beer-game-simulation/blob/develop/apps/beer-game-ts/src/domain/conditions.ts)） | プレイ中に観察者へ見せる情報の範囲。既定はチーム合計（寄与者が 2 未満なら非表示） | ドメインモデル ユビキタス言語 |
| 自動確定 | `CommitMode`（[`src/domain/game.ts`](https://github.com/k2works/case-study-beer-game-simulation/blob/develop/apps/beer-game-ts/src/domain/game.ts)） | 進行役が有効にした場合、4 役割の入力がそろった時点でシステムが週確定を行う方式（手動 MANUAL の対） | ドメインモデル ユビキタス言語 |
| 週確定 | `commitWeek`（[`src/domain/session.ts`](https://github.com/k2works/case-study-beer-game-simulation/blob/develop/apps/beer-game-ts/src/domain/session.ts)） | 4 役割の意思決定から次週の状態を計算して確定する操作。一度だけ成立する | ドメインモデル ユビキタス言語 |
| 代理入力 | `proxyDecision`（[`src/domain/session.ts`](https://github.com/k2works/case-study-beer-game-simulation/blob/develop/apps/beer-game-ts/src/domain/session.ts)） | 進行役が参加者に代わって入力する意思決定。入力値を履歴に残す | ドメインモデル ユビキタス言語 |
| 役割 | `Role`（[`src/domain/role.ts`](https://github.com/k2works/case-study-beer-game-simulation/blob/develop/apps/beer-game-ts/src/domain/role.ts)） | サプライチェーン上の位置。工場・一次卸・二次卸・小売店の 4 つで、上流から下流の順に並ぶ | ドメインモデル ユビキタス言語 |
