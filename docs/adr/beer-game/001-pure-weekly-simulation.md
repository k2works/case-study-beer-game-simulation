---
type: ADR
title: "ADR-001: 週次計算を純粋関数として分離する"
description: "週次の在庫・受注残・遅延・費用の計算を、永続化や認可から切り離した純粋関数 simulateWeek にする。"
tags: [adr]
status: draft
generated: { by: claude-code/claude-sonnet-5-5, at: 2026-11-09T07:45:24Z }
---

# ADR-001: 週次計算を純粋関数として分離する

週次の在庫・受注残・遅延・費用の計算を、永続化や認可から切り離した純粋関数 `simulateWeek` にする。

日付: 2026-11-09

## ステータス

提案中（実装済みの決定を事後に記録したもの。レビュー待ち）

## コンテキスト

ビールゲームの週次計算は、JSD 改訂版キットの 12 ステップと 2 週遅延に忠実である必要がある（BR-02〜BR-09）。教材としての価値は、この計算の正しさそのものにある。一方で、週の確定は永続化、冪等性、認可を伴うため、計算と混ぜると規則の検証が難しくなる。

- 同じ入力から同じ結果が得られること（決定論性）が要る。
- 既知の系列で結果を照合する検証（golden test）を、データベースなしで高速に回したい。
- 参考: [ドメインモデル設計](../../design/beer-game/domain-model.md)

## 決定

週次計算を `domain/simulation-engine.ts` の純粋関数 `simulateWeek(前週の断面, 4 役割の意思決定, 設定)` として実装する。時刻、通信、永続化、認可に依存しない。進行と整合性（トランザクション、冪等性、権限）は `GameService` が持ち、確定時に `simulateWeek` を呼ぶ。

### 変更箇所

- `apps/beer-game/src/domain/simulation-engine.ts`、`types.ts`
- `apps/beer-game/src/application/game-service.ts`（`commitWeek` が呼び出す）

### 代替案

- `GameService` に計算を統合する: 初期実装は単純だが、トランザクションと計算規則が密結合し、計算だけを検証できない。
- 在庫・注文・配送・費用ごとに部品を分ける: 1 回の週確定の不変条件が複数の部品に分散し、現規模では過剰。

## 影響

### ポジティブ

- 計算を単体テストと既知系列の照合で検証できる（`tests/u1/simulation-engine.test.ts`）。
- 永続化方式を変えても計算規則が変わらない。

### ネガティブ

- `GameService` と `simulateWeek` の間で、入力・出力の型を保つ必要がある。
- 遅延キューの長さが配列の位置に依存し、規則の変更時は配列の扱いに注意が要る。

## コンプライアンス

- `domain/` が他の層（`application/`、`infrastructure/`、`api/`）を import していないこと。
- 週次計算の変更時は、既知系列の照合テストが通ること。

## 備考

- 著者: claude-code（事後記録）。承認者: 未定
- 関連コミット: 5355ed4（walking skeleton）
- 関連 ADR: ADR-002
- 元の設計記録: `aidlc/.../inception/domain-design/decisions.md` の ADR-001
