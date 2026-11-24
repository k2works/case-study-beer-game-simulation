---
type: ADR
title: "ADR-014: TS 版は共有の API 契約（/api/v1）と共有の画面を使う"
description: "TS 版は、独自の画面と独自の API をやめ、Kotlin 版・Rust 版と共有の契約 /api/v1 と、共有の画面 apps/beer-game-web を使う。"
tags: [adr]
status: draft
generated: { by: claude-code/claude-sonnet-5-5, at: 2026-11-24T00:00:00Z }
---

# ADR-014: TS 版は共有の API 契約（/api/v1）と共有の画面を使う

TS 版は、独自の画面（`apps/beer-game-ts/ui`）と独自の API（`/api/*`）をやめ、Kotlin 版・Rust 版と共有の契約 `apps/beer-game-contracts/openapi.yaml`（`/api/v1`）と、共有の画面 `apps/beer-game-web` を使う。

日付: 2026-11-24

## ステータス

提案中（レビュー待ち）。[ADR-006](./006-sse-version-only.md)（SSE）と [ADR-010](./010-url-router-and-features.md)（独自の画面の構成）を、この決定で置き換える。

## コンテキスト

3 つの実装（Kotlin・Rust・TS）が、それぞれ別の画面と別の API を持っていた。画面（`apps/beer-game-web`）・受け入れの仕様（`apps/beer-game-features`）・API の契約（`apps/beer-game-contracts`）は、Kotlin 版と Rust 版が共有する形に整理済みだった。TS 版だけが、独自の画面（19 ファイル）と独自の API を持ち、画面の改善・アクセシビリティの検査・受け入れの仕様を、二重に保守していた。

## 決定

- API は、共有の契約 `/api/v1`（25 操作）に従う。旧い API（`/api/*`）は残さない（利用者がなく、AWS は未適用）。
- 画面は、共有の `apps/beer-game-web` を使い、TS 版は画面のコードを持たない。配信は従来どおり S3 + CloudFront（成果物は `apps/beer-game-web/dist`）。
- 契約への適合は、契約テスト（`tests/contract`。Ajv で応答のスキーマを検査。道具は `ajv`・`ajv-formats`・`yaml`）が守る。画面の受け入れ（`@ui`。27 シナリオ）は、CI の `e2e` ジョブが TS 版のバックエンドで実行する。
- TS 独自の機能は捨てる: SSE（`stream`。画面は `versions` に追いつくまで取得し直す）、`unassign`、`console`・`me`。`PgNotifier` は、`/api/v1/ready` の `notifier` の確認のために残す。
- 契約が定めて TS が足りなかった点を実装した: 役割ごとの初期在庫と初期の流れ（マイグレーション 008）、全コマンドの `Idempotency-Key`（009）、開始後の役割の入れ替え（010 `participants.replaced_at`）、game・session の 2 本の版、確定の根拠（`basis`）、29 種の `code` の problem+json、タブ別の Cookie（`X-Tab-Id`）。

## 結果

- 画面・受け入れ・契約の保守が 1 か所になり、3 つの実装が同じ画面と同じ契約で検証される。
- TS 版の Origin の検査は、Kotlin 版（Origin が無い要求を許す）より厳しいままにした。共有の受け入れの支援が、準備の API 呼び出しにも画面と同じ `Origin` を付ける。
- 画面の振る舞いのテスト（component 91 件・E2E 3 本）は消え、共有の `@ui` が引き継ぐ。画面のテストにしか無かった受入条件 2 件は、API のテストに足した。
- アプリケーション層には、HTTP から呼ばれない旧い読み取り・操作が残る（テストが保護）。整理は別の作業。

## 却下した案

- **旧い API を残す**: 利用者がなく、二重の保守になるため却下。
- **TS 版の独自の画面を残し、API だけ契約に合わせる**: 画面の二重保守が残るため却下。
- **契約を TS 版に合わせて変える**: 契約は 3 つの実装と画面の共有物なので、変えない。
