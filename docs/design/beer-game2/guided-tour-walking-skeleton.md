---
type: Design
title: "ガイドツアー: ウォーキングスケルトン（発注の保存から、1 週が確定するまで）"
description: "ウォーキングスケルトンの縦の流れ（画面 → API → ユースケース → 集約 → 計算 → 永続化 → 通知）を、順にたどるガイドツアー。コードのタグから自動生成する。"
tags: [design, living-documentation]
status: draft
generated: { by: "script:apps/beer-game2/scripts/guided-tour.ts (walking-skeleton)", at: 2026-11-10T06:38:08.109Z }
---
# ガイドツアー: ウォーキングスケルトン（発注の保存から、1 週が確定するまで）

> **自動生成**: このファイルは `npm run docs:tour` で、コードの `@guidedTour` から生成しています。直接編集せず、コードのタグを直してください（CI が、コードとの一致を検査します）。

ウォーキングスケルトン（Bolt 1）は、ゲームの作成から確定までを、画面からデータベースまで縦に通した最小の実装です。
このツアーは、その中心の流れ「参加者が発注を保存し、1 週が確定して、全員の画面が更新される」を、入口から出口まで順にたどります。
初めてコードを読む人は、ここから始めて、各ステップのファイルを開いてください。

全体の構造は [バックエンドのアーキテクチャ](./architecture-backend.md)、層の依存の理由は [ADR-003](../../adr/beer-game2/003-ports-and-adapters-with-lint.md) を参照してください。

## 1. PlayScreen

[`ui/src/features/play.tsx`](https://github.com/k2works/case-study-beer-game-simulation/blob/develop/apps/beer-game2/ui/src/features/play.tsx)

入口。参加者が発注を保存する画面。`api.saveDecision` を、画面が持つ「版」とともに呼ぶ（他の操作で更新されていたら、黙って上書きしないため）。画面は HTTP を知らず、`ApiClient`（実装は `ui/src/api/http-client.ts`、テストでは偽物）だけに依存する。次は、サーバー側の入口。

## 2. buildServer

[`src/adapters/http/server.ts`](https://github.com/k2works/case-study-beer-game-simulation/blob/develop/apps/beer-game2/src/adapters/http/server.ts)

HTTP の入口。Origin の検査、Cookie から資格の選択、zod による入力の検証、エラーの Problem JSON への変換を行う。**ルールは持たず**、ユースケースを呼ぶだけ。次は、ユースケース。

## 3. createApplication

[`src/application/index.ts`](https://github.com/k2works/case-study-beer-game-simulation/blob/develop/apps/beer-game2/src/application/index.ts)

ユースケース。1 回の操作を `UnitOfWork`（1 つのトランザクション）の中で行い、資格を確認し、集約を呼び、保存する。**ルールはここに書かない**（層の依存は lint で守られる）。次は、集約のルール。

## 4. saveDecision

[`src/domain/session.ts`](https://github.com/k2works/case-study-beer-game-simulation/blob/develop/apps/beer-game2/src/domain/session.ts)

ルールの本体その 1。担当の役割だけが、進行中に、範囲内の数量を、版が一致するときだけ保存できる。自動確定のゲームでは、最後の保存で、同じ操作の中で週を確定する。

## 5. commitWeek

[`src/domain/session.ts`](https://github.com/k2works/case-study-beer-game-simulation/blob/develop/apps/beer-game2/src/domain/session.ts)

ルールの本体その 2。進行役だけが、4 役割の発注がそろい、週と版が一致するときだけ確定できる（確認した後に入力が変わったら拒否）。計算は `simulateWeek` に任せ、役割別の週結果を履歴に積む。

## 6. simulateWeek

[`src/domain/simulate-week.ts`](https://github.com/k2works/case-study-beer-game-simulation/blob/develop/apps/beer-game2/src/domain/simulate-week.ts)

週次の計算（純粋関数）。入荷 → 受注 → 出荷 → 在庫・受注残 → 発注 → 遅延の前進 → 費用の順。時刻・DB・認可に依存しない。golden とプロパティテストで守られている。次は、結果の保存。

## 7. PgUnitOfWork

[`src/adapters/persistence/pg-unit-of-work.ts`](https://github.com/k2works/case-study-beer-game-simulation/blob/develop/apps/beer-game2/src/adapters/persistence/pg-unit-of-work.ts)

トランザクションの境界。1 回の操作の保存（集約、役割別の週結果、イベント、冪等記録）は、すべて成功するか、何も残らない。版つきの更新で、同時の更新も検出する。保存のたびに `pg_notify` され（`PgNotifier`）、SSE で全員の画面へ「変化があった」とだけ伝わり、画面が再取得して更新される。動く様子は、E2E（`tests/e2e/game.spec.ts`）で確認できる。
