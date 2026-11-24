---
type: Design
title: "ガイドツアー: ウォーキングスケルトン（発注の保存から、1 週が確定するまで）"
description: "ウォーキングスケルトンの縦の流れ（画面 → API → ユースケース → 集約 → 計算 → 永続化 → 通知）を、順にたどるガイドツアー。コードのタグから自動生成する。"
tags: [design, living-documentation]
status: draft
generated: { by: "script:apps/beer-game-ts/scripts/guided-tour.ts (walking-skeleton)", at: 2026-11-24T10:11:44.264Z }
---
# ガイドツアー: ウォーキングスケルトン（発注の保存から、1 週が確定するまで）

> **自動生成**: このファイルは `npm run docs:tour` で、コードの `@guidedTour` から生成しています。直接編集せず、コードのタグを直してください（CI が、コードとの一致を検査します）。

ウォーキングスケルトン（Bolt 1）は、ゲームの作成から確定までを、画面からデータベースまで縦に通した最小の実装です。
このツアーは、その中心の流れ「参加者が発注を保存し、1 週が確定して、全員の画面が更新される」を、入口から出口まで順にたどります。
初めてコードを読む人は、ここから始めて、各ステップのファイルを開いてください。

全体の構造は [バックエンドのアーキテクチャ](./architecture-backend.md)、層の依存の理由は [ADR-003](../../adr/beer-game-ts/003-ports-and-adapters-with-lint.md) を参照してください。

## 1. registerApiV1Commands

[`apps/beer-game-ts/src/adapters/http/routes-v1-commands.ts`](https://github.com/k2works/case-study-beer-game-simulation/blob/develop/apps/beer-game-ts/src/adapters/http/routes-v1-commands.ts)

入口。参加者が発注を保存する要求（`PUT /api/v1/sessions/{sessionId}/decisions`）。入力する役割は資格から決まり、意思決定の版は `If-Match` で送る（他の操作で更新されていたら、黙って上書きしないため）。画面は Kotlin 版・Rust 版と共通の `apps/beer-game-web` で、HTTP の契約（`apps/beer-game-contracts/openapi.yaml`）だけを話す。次は、サーバー側の入口。

## 2. buildServer

[`apps/beer-game-ts/src/adapters/http/server.ts`](https://github.com/k2works/case-study-beer-game-simulation/blob/develop/apps/beer-game-ts/src/adapters/http/server.ts)

HTTP の入口。Origin の検査、Cookie から資格の選択、zod による入力の検証、エラーの Problem JSON への変換を行う。**ルールは持たず**、ユースケースを呼ぶだけ。次は、ユースケース。

## 3. createApplication

[`apps/beer-game-ts/src/application/index.ts`](https://github.com/k2works/case-study-beer-game-simulation/blob/develop/apps/beer-game-ts/src/application/index.ts)

ユースケース。1 回の操作を `UnitOfWork`（1 つのトランザクション）の中で行い、資格を確認し、集約を呼び、保存する。**ルールはここに書かない**（層の依存は lint で守られる）。次は、集約のルール。

## 4. saveDecision

[`apps/beer-game-ts/src/domain/session.ts`](https://github.com/k2works/case-study-beer-game-simulation/blob/develop/apps/beer-game-ts/src/domain/session.ts)

ルールの本体その 1。担当の役割だけが、進行中に、範囲内の数量を、版が一致するときだけ保存できる。自動確定のゲームでは、最後の保存で、同じ操作の中で週を確定する。

## 5. commitWeek

[`apps/beer-game-ts/src/domain/session.ts`](https://github.com/k2works/case-study-beer-game-simulation/blob/develop/apps/beer-game-ts/src/domain/session.ts)

ルールの本体その 2。進行役だけが、4 役割の発注がそろい、週と版が一致するときだけ確定できる（確認した後に入力が変わったら拒否）。計算は `simulateWeek` に任せ、役割別の週結果を履歴に積む。

## 6. simulateWeek

[`apps/beer-game-ts/src/domain/simulate-week.ts`](https://github.com/k2works/case-study-beer-game-simulation/blob/develop/apps/beer-game-ts/src/domain/simulate-week.ts)

週次の計算（純粋関数）。入荷 → 受注 → 出荷 → 在庫・受注残 → 発注 → 遅延の前進 → 費用の順。時刻・DB・認可に依存しない。golden とプロパティテストで守られている。次は、結果の保存。

## 7. PgUnitOfWork

[`apps/beer-game-ts/src/adapters/persistence/pg-unit-of-work.ts`](https://github.com/k2works/case-study-beer-game-simulation/blob/develop/apps/beer-game-ts/src/adapters/persistence/pg-unit-of-work.ts)

トランザクションの境界。1 回の操作の保存（集約、役割別の週結果、イベント、冪等記録）は、すべて成功するか、何も残らない。版つきの更新で、同時の更新も検出する。保存のたびに `pg_notify` され（`PgNotifier`。受信が生きているかは `/api/v1/ready` の `notifier` で確かめる）、画面は応答の `versions` に追いつくまで状態を取得し直して更新される。動く様子は、共有の画面の受け入れ（`apps/beer-game-web` の `@ui`。TS 版のバックエンドで CI が実行する）で確認できる。
