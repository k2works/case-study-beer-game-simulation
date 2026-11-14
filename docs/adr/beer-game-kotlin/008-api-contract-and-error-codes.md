---
type: ADR
title: "ADR-008: API の契約を OpenAPI の手書きの仕様で持ち、エラーを problem+json の code で識別する"
description: "contracts/openapi.yaml を手書きの正本にして TypeScript の型を生成し、契約テストで一致を守る。エラーは problem+json の code を鍵にし、コマンドの応答は versions だけを返す。"
tags: [adr]
status: draft
generated: { by: claude-code/claude-sonnet-5-5, at: 2026-11-14T08:47:37Z }
---

# ADR-008: API の契約を OpenAPI の手書きの仕様で持ち、エラーを problem+json の code で識別する

API の契約は `contracts/openapi.yaml`（手書き）を正本とし、フロントエンドの TypeScript の型を生成する。実装との一致は、Kotlin 側の契約テストで守る。エラーは `problem+json` の `code`（`<領域>.<名前>`）で識別する。コマンドの応答はストリームごとの版（`versions`）だけを返す。

日付: 2026-11-14

## ステータス

提案中（レビュー待ち）

## コンテキスト

beer-game2 は、バックエンドとフロントエンドが TypeScript の型を共有する想定だった。Kotlin 版では、バックエンドが Kotlin、フロントエンドが TypeScript になり、言語をまたぐ型の共有ができない。API の契約の持ち方を決める必要がある。

加えて、ES + CQRS により、API の形が変わる。1 ゲームに独立した版が 2 つある（`game` と `session`）。自動確定は、保存と同時に確定を起こす。共同担当が保存し直しただけで、確定が「すでに確定されています」と誤って拒否されてはならない。また、レビューで、エラーの識別子の書式が文書ごとに違う（`session.week_advanced` と `decision-conflict`）ことが指摘された（[設計レビュー](../../review/beer-game-kotlin/design_review_20261114.md) H9）。

## 決定

- **OpenAPI（`contracts/openapi.yaml`）を手書きの正本**とし、TypeScript の**型だけ**を生成する（実行時のコードを持たない生成物）。仕様には、エンドポイント、スキーマ、`problem+json` の `code` の一覧、ヘッダー（`Idempotency-Key`、`If-Match`、`x-correlation-id`）、SSE の通知の形を書く。
- **一致は契約テストで守る。** 実際のルートを呼び、応答が仕様のスキーマに適合することを検査する。変更は、仕様 → 契約テスト（失敗）→ Kotlin の実装 → 型の再生成 → 画面の順に進める。CI の順序は、仕様の検証 → 型の生成 → 型の検査 → テスト。
- **エラーは `problem+json`。** `type` は `/problems/{code}`（相対 URI）、拡張メンバー `code` に同じ値を持つ。`code` は小文字のドット区切り `<領域>.<名前>`（例: `session.decision_conflict`、`game.invitation_invalid`、`app.retry_exhausted`）。フロントエンドの辞書の鍵は `code` で、生成した型の列挙を鍵にした網羅的な表にし、`code` が増えると型エラーで漏れが分かる。ドメインのエラーの分類から HTTP の状態への写像は、`adapter-http` の 1 か所の純粋関数にする。
- **コマンドの応答は `versions`（ストリームごとの版）だけ**を返す。画面は応答のあとスナップショットを取得し、`versions` に追いつくまで待って表示する（SSE を待たない）。
- **`If-Match` は `SaveDecision`（意思決定の版）だけ**に付ける。`CommitWeek` は本文の `requestedWeek` と `basis` を使い、週が違えば `WeekAdvanced`、根拠の入力が変わっていれば `DecisionsChanged` を返す。`StaleVersion` は廃止する。
- **進行の開始は `POST /games/:id/start`。** 開始が `game` と `session` の 2 ストリームにまたがるため。

設計書の該当節: [フロントエンドアーキテクチャ](../../design/beer-game-kotlin/architecture-frontend.md)（API の契約、エラーの識別子と表示名、FD1〜FD4）、[バックエンドアーキテクチャ](../../design/beer-game-kotlin/architecture-backend.md)（入力の検証とエラーの写像、応答とスナップショット）、[ドメインモデル](../../design/beer-game-kotlin/domain-model.md)（D10。`StaleVersion` の廃止）。

### 代替案

- Kotlin のルートから OpenAPI を生成する（コードが正本、FD1 の案 B）: 仕様の記述が不要。Ktor の対応の状況と、`problem+json` の `code` の列挙や SSE の記述の表現力に不安があり、仕様がコードの副産物になってレビューしにくいため採らない。
- 型を手で二重に書く（契約テストなし、FD1 の案 C）: 追加の道具が要らないが、型のずれが実行時まで分からない。
- TypeScript と型を共有する（beer-game2 の想定）: 言語が分かれたため成り立たない。
- `StaleVersion`（単一のストリームの版による確定の検査）を残す（ドメインモデル D10 の案 B）: 実装が単純だが、共同担当の保存し直しだけで拒否され、画面に事実と違う文言が出る。「週が進んだ」と「状態が更新された」の 2 つに分ける案（案 C）も、入力が変わっていない更新まで拒否されるため採らない。
- 応答に結果（確定を含む）を載せて画面を更新し、SSE で追いつく（FD4 の案 B）: 取得は減るが、応答と SSE の 2 経路で順序の入れ替わりを扱う必要がある。

## 影響

### ポジティブ

- 仕様が正本で、API の変更が型エラーとして画面に現れる。
- 文言の変更や多言語化の影響が、辞書に閉じる。
- 更新の経路が 1 つで、SSE が切れていても自分の保存が出る。自動確定でも同じ。
- 共同担当の保存だけで確定が拒否される誤りを避けられる。

### ネガティブ

- 仕様を手で書く手間がかかり、実装との一致を契約テストで補う必要がある。
- 保存のたびにスナップショットの取得が 1 回増える。
- 型の生成ツールと、契約テストの方法（仕様の適合の検査に使うライブラリ、または自前の検査）は、選定が未決（外部ライブラリの導入には承認が要る）。

## コンプライアンス

- B1: `contracts/openapi.yaml` に、ウォーキングスケルトンの経路（作成、参加、割り当て、開始、入力、確定、状態の表示）を書く。開始は `POST /games/:id/start` とする。Gherkin の `@api` シナリオが、この経路を通す（[ADR-012](./012-gherkin-and-cucumber.md)）。
- **B2**: 契約テスト（仕様の検証、応答・リクエストの適合、`code` の一覧の一致、ルートの網羅、型の生成物の差分 0）と、型の生成を、CI の順序（仕様の検証 → 型の生成 → 型の検査 → テスト）に組み込む（[リリース計画](../../development/beer-game-kotlin/release_plan.md)、[テスト戦略](../../design/beer-game-kotlin/test-strategy.md) の API の契約テスト）。**仕様と実装を意図的にずらすと CI が落ちる**ことを確認する。道具の選定と導入の承認は B2。B3 以降は、API を足すたびに仕様 → 契約テスト → 実装の順に進める。
- HTTP の統合テスト（`testApplication`）: エラー形式（`type` が `/problems/{code}`）、`If-Match` が `SaveDecision` にだけ付くこと、`CommitWeek` が `requestedWeek` と `basis` を使うことを確認する（[テスト戦略](../../design/beer-game-kotlin/test-strategy.md) の境界の契約。H6）。B5、B6 で、`WeekAdvanced` と `DecisionsChanged` の区別を並行の統合テストで確認する（AC2.1.4、AC2.2.3、AC2.2.4）。
- `EventCodec` の golden とあわせて、設計書とコードの食い違い（`code` の一覧）を守る（[開発戦略](../../development/beer-game-kotlin/development_strategy.md) の重複させる知識の検証）。

## 備考

- 著者: claude-code
- 関連 ADR: [ADR-002](./002-event-sourcing-and-cqrs.md)、[ADR-003](./003-synchronous-projections.md)、[ADR-004](./004-idempotency-after-authorization.md)、[ADR-007](./007-functional-core-with-arrow.md)、[ADR-012](./012-gherkin-and-cucumber.md)
- 設計書の指摘（解決済み）: 契約テストの項目が、テスト戦略とリリース計画に無かった。2026-11-14 に、テスト戦略（API の契約テストの節）とリリース計画（B1 の仕様、B2 の契約テストと型の生成、リスク R21）に反映した。
- 参照: [フロントエンドアーキテクチャ](../../design/beer-game-kotlin/architecture-frontend.md)、[バックエンドアーキテクチャ](../../design/beer-game-kotlin/architecture-backend.md)、[設計レビュー](../../review/beer-game-kotlin/design_review_20261114.md)
