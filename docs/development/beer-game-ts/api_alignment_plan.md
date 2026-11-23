---
type: Plan
title: "API を共有の契約に合わせる計画 - beer-game-ts"
description: "beer-game-ts の HTTP API を、共有の契約（apps/beer-game-contracts/openapi.yaml。/api/v1）に合わせ、独自の UI（ui/）を削除して共有 UI（apps/beer-game-web）を使うための計画。契約 25 操作と TS のルートの差分表、差の分類、段階、ゲート、進捗。"
tags: [plan]
status: draft
generated: { by: claude-code/claude-sonnet-5-5, at: 2026-11-24T00:00:00Z }
---

# API を共有の契約に合わせる計画

## 概要

| 項目 | 内容 |
| :--- | :--- |
| 目的 | `apps/beer-game-ts/ui`（独自の React UI）を削除し、UI は共有の `apps/beer-game-web`（Kotlin 版・Rust 版と共通）を使う |
| 本体の作業 | 共有 UI は共有の契約 `apps/beer-game-contracts/openapi.yaml`（`/api/v1`）だけを話す。**TS のバックエンドの HTTP API を、契約に合わせる**（アダプター層の書き直しと、アプリ層の入出力の形の拡張） |
| 決定（2026-11-24、ユーザー） | ①旧 API（`/api/*`）は残さず `/api/v1` へ置き換える（利用者なし。AWS 未適用）、②契約テストの道具に `ajv` 8.20.0・`ajv-formats` 3.0.1・`yaml` 2.9.1 を devDependency に追加、③`ui` の削除は最後（共有 UI の `@ui` が TS で通ってから） |
| 契約は変更しない | 契約は Kotlin・Rust・web の共有物。食い違いが契約の側の誤りと分かったら、変更せず、人に確認する（ゲート 4） |
| 進め方 | 段階ごとに、テスト先行 → コミット → push → CI 確認。意図的な Red は push しない（未実装は `tests/contract/pending.ts` の一覧で追う） |

## 契約の操作と TS のルートの差分表（2026-11-24 時点）

契約は 25 操作（`getHealth`・`getReady` を含む）。TS のルートは `apps/beer-game-ts/src/adapters/http/server.ts`。

| 契約の操作 | TS の対応 | 差 |
| :--- | :--- | :--- |
| getHealth・getReady | `GET /health`・`/ready`・`/api/ready` | パス（`/api/v1/health`・`/api/v1/ready`）。503 は problem+json で `checks:{database, notifier}` |
| createGame | `POST /api/games` | パス。本文（`weeks`→`finalWeek`、`kind`、`conditions` の形）。応答は 201＋`Location`＋`{versions, recoveryCode}`、Cookie 2 本 |
| joinGame | `POST /api/join` | パス（`/participations/join`）。応答は 200＋`{versions, gameId}` |
| recoverParticipation | `POST /api/recover` | パス。本文（`{gameId, recoveryCode?}`。省略時は Cookie `bg_recovery`）。応答の形 |
| joinAsObserver | `POST /api/observe` | パス。`code`→`invitationCode`。応答 |
| inviteObserver | `POST …/observer-invitations` | 応答 `{versions, invitationId, invitationCode, expiresAt}` |
| revokeObserverInvitation | `DELETE …/observer-invitations/:id` | メソッドとパス（契約は `POST …/{id}/revoke`）。応答 `{versions}` |
| getObservation | `GET …/observation` | パス。本文は未比較 |
| getLobby | `GET …/lobby` | 本文が大きく違う（`participants`・`invitations`・`observers`・`settingsKind`・`changedSettings`・`versions`） |
| getGameState | なし | 新設（進行役・参加者ごとの投影。TS は lobby・me・console に分散） |
| getSessionState | なし（`me`・`console` が近い） | 新設（1 本で、役割で分かれる投影） |
| startGame | `POST …/start` | パス。応答 `{versions}` |
| assignRole | `POST …/assignments`（本文に participantId） | `PUT /games/{g}/participants/{p}/role`。**開始後の入れ替え（H4）の有無を確認** |
| saveDecision | `PUT …/decision`（本文に role） | `PUT /sessions/{s}/decisions`。本文 `{week, quantity}`、役割は資格から決まる。`If-Match` は同じ |
| commitWeek | `POST …/commit`（`{week}`＋`If-Match`） | `POST /sessions/{s}/weeks/{w}/commit`。本文 `{requestedWeek, basis}`。**意味論が違う**（役割ごとの版 `basis`） |
| pauseSession・resumeSession・setCommitMode | `POST …/pause`・`…/resume`・`PUT …/commit-mode` | パス（`/sessions/{s}/…`）。応答 `{versions}` |
| submitProxyDecision | `PUT …/proxy-decision` | パス（`/proxy-decisions/{role}`）。本文 `{requestedWeek, quantity}` |
| revokeCredential | なし | 新設 |
| reissueCredential | `POST …/credentials/reissue` | 本文（`target`→`subject:{kind, id}`）。応答 `{versions, recoveryCode, expiresAt}` |
| getReview | `GET …/review` | パス。終了前は 409 `game.not_ended` |
| getExport | `GET …/export` | パス（`/exports`）。ヘッダー `X-Export-Checksum: sha256-…`・`X-Export-Schema-Version`（TS は `x-checksum-sha256` の 16 進のみ） |
| getRetention | なし（lobby の `retention` に同居） | 単独のエンドポイントを新設 |

TS にだけあって契約に無いもの（共有 UI は使わない。削除する）: `GET …/me`・`GET …/console`・`GET …/stream`（SSE）・`DELETE …/assignments/:pid`（unassign）・`/api/ready`。

## 差の分類

1. パスの接頭辞（`/api` → `/api/v1`）と、リソースの分割（`/participations/*`、`/sessions/{id}/*`）
2. エラー: TS は `code` 無しの problem（`type: about:blank`）、契約は 29 種の `code`・`type=/problems/{code}`・`errors[]`・`Retry-After`。**共有 UI は `type` の無い失敗を再送するので、`type` は必須**
3. 資格: TS は Cookie `bg_facilitator`・`bg_participant`・`bg_observer`、契約は `bg_session`・`bg_recovery`（`X-Tab-Id` でタブ別の名前）
4. コマンドの応答: TS は 204 などの個別の形、契約は `{versions:{game, session}}`（追記しなかったストリームは `null`）
5. 要求の形（`weeks`→`finalWeek`、`code`→`recoveryCode`/`invitationCode`、`target`→`subject`）
6. 版: TS は session の版 1 本、契約は game・session の 2 本と、`commitWeek` の `basis`
7. `Idempotency-Key`: TS は commit だけ、契約は全コマンドで必須
8. Origin: TS は `ALLOWED_ORIGIN`（単数）、共有 UI の開発・E2E は別ポートなので `ALLOWED_ORIGINS`（複数）が要る

土台として流用できるもの: 資格（256 ビット乱数＋HMAC ダイジェスト）、`If-Match`、Origin の検査、UUID の ID、`sessionId=gameId`、problem+json の枠。

## 段階とゲート

| 段階 | 内容 | 完了条件 |
| :-: | :--- | :--- |
| 0 | 差分表と契約テストの土台（本書、`tests/contract/`、`ajv`・`ajv-formats`・`yaml`） | 契約を読み込み、検証の道具が違反を検出できる。未実装の一覧（25 件）が operations のテストで追える |
| 1 | 横断の仕組み: `/api/v1`、problem+json の `code`・`type`・`errors[]`、Cookie `bg_session`・`bg_recovery`・`X-Tab-Id`、`Idempotency-Key`、`ALLOWED_ORIGINS`、health・ready | getHealth・getReady が契約に適合。problem が契約に適合 |
| 2 | 読み取り: state・lobby・observation・review・export・retention、`versions:{game, session}` | 各応答が契約のスキーマに適合 |
| 3 | コマンド: 作成・参加・復帰・開始・役割の割り当て（H4）・入力・確定（`basis`）・停止・再開・代理入力・観察者・資格の失効と再発行 | 全 25 操作が実装済み（未実装の一覧が空） |
| 4 | 旧 API の撤去と、統合テスト（約 107 件）・scripts の付け替え | 契約テスト全 Green、統合テスト・`acceptance` が新 API で Green |
| 5 | 共有 UI を TS のバックエンドで動かす（`@ui` 27 シナリオ）。CI の `e2e` ジョブと deploy を共有 UI に切り替え | `@ui` が TS で 27/27（ローカルと CI） |
| 6 | `ui/`・`vite.config.ts`・component テスト・Playwright E2E の削除と整理 | `docs:tour:check`・CI が緑 |
| 7 | ドキュメント（設計・運用手順・ADR・ログ） | `okf:check` ERROR 0 |

**ゲート（人の確認が要る点）**: ①DB のスキーマ変更（`versions.game` の持ち方。既存の列から導出できなければ、段階 2 の前に止まって案を示す）、②ガイドツアーの第 10 ステップ（`ui/src/features/play.tsx` の `@guidedTour`）の移し先か、ツアーを縮めるか、③TS 独自の機能（SSE・unassign・console）を捨てることの確認、④契約そのものの変更が要る場合。

## 進捗

| 段階 | 状態 | 備考 |
| :-: | :--- | :--- |
| 0 | 実施中 | 契約テストの土台（35 件）は通過。依存の版は 2026-11-24 に公式レジストリで確認（ajv 8.20.0、ajv-formats 3.0.1、yaml 2.9.1。いずれも exact 指定） |
| 1〜7 | 未着手 | |

## 更新履歴

| 日付 | 更新内容 | 更新者 |
| :--- | :--- | :--- |
| 2026-11-24 | 初版作成（段階 0。差分表と段階・ゲート） | claude-code |
