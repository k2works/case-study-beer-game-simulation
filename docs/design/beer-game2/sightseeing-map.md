---
type: Design
title: "サイトシーイング・マップ（見どころ）"
description: "コードベースの見どころ（ここを理解すれば全体が分かる場所）の一覧。順序はない。コードのタグから自動生成する。"
tags: [design, living-documentation]
status: draft
generated: { by: "script:apps/beer-game2/scripts/guided-tour.ts (sightseeing-map)", at: 2026-11-10T07:11:10.420Z }
---
# サイトシーイング・マップ（見どころ）

> **自動生成**: このファイルは `npm run docs:tour` で、コードの `@landmark` から生成しています。直接編集せず、コードのタグを直してください（CI が、コードとの一致を検査します）。

初めてコードを読むときの地図です。**ここを理解すれば全体が分かる**場所だけを、少数に絞っています。
処理の流れを順にたどりたいときは、[ガイドツアー](./guided-tour-walking-skeleton.md) を使ってください。

| 見どころ | 場所 | 理由 |
| :--- | :--- | :--- |
| `buildServer` | [`src/adapters/http/server.ts`](https://github.com/k2works/case-study-beer-game-simulation/blob/develop/apps/beer-game2/src/adapters/http/server.ts) | HTTP の入口。Origin の検査、資格の選択、入力の検証、エラーの変換を、ここでまとめて行う。ルールは持たない。 |
| `createApplication` | [`src/application/index.ts`](https://github.com/k2works/case-study-beer-game-simulation/blob/develop/apps/beer-game2/src/application/index.ts) | ユースケース層の入口。1 回の操作は 1 つのトランザクション。ルールを持たず、認証 → 集約の呼び出し → 保存の順に進めるだけ。 |
| `Game` | [`src/domain/game.ts`](https://github.com/k2works/case-study-beer-game-simulation/blob/develop/apps/beer-game2/src/domain/game.ts) | 準備の集約。設定・参加者・役割の割り当てと、開始の条件（4 役割がそろう）を持つ。不変で、操作は新しい Game とイベントを返す。 |
| `canDisclose` | [`src/domain/review.ts`](https://github.com/k2works/case-study-beer-game-simulation/blob/develop/apps/beer-game2/src/domain/review.ts) | 情報の制約の要。振り返りを開示してよいかの判定が、この 1 か所に集まっている（終了後だけ）。他の経路から漏れないよう、判定を散らさない。 |
| `Session` | [`src/domain/session.ts`](https://github.com/k2works/case-study-beer-game-simulation/blob/develop/apps/beer-game2/src/domain/session.ts) | 進行の集約。週・役割別の状態・発注・履歴を持ち、確定と自動確定の不変条件を守る。Game とは別の集約にして、更新の競合を小さくしている。 |
| `simulateWeek` | [`src/domain/simulate-week.ts`](https://github.com/k2works/case-study-beer-game-simulation/blob/develop/apps/beer-game2/src/domain/simulate-week.ts) | ゲームのルールの核。週次の計算（入荷 → 受注 → 出荷 → 在庫・受注残 → 発注 → 遅延の前進 → 費用）が、純粋関数 1 つに閉じている。ここが分かれば、画面の数字の意味が分かる。 |
| `UnitOfWork` | [`src/ports/index.ts`](https://github.com/k2works/case-study-beer-game-simulation/blob/develop/apps/beer-game2/src/ports/index.ts) | トランザクション境界の契約。成功したら全部、失敗したら何も残らない。メモリ版と PostgreSQL 版の 2 つの実装が、同じ契約でテストされている。 |
