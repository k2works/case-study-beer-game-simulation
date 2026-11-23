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

## 段階 3 の前の確認事項（2026-11-24。**3 案とも承認済み**）

段階 3（コマンド）に入る前に、スキーマ変更とドメインの規則の変更が要る 3 件の案。スキーマ変更・業務ルールの変更は確認必須。AWS は未適用なので、既存データへの影響は開発 DB だけ。

**承認の記録（2026-11-24、ユーザー）**: 案 1「承認する」（条件の範囲を契約に合わせることを含む）、案 2「段階 3 で実装する」、案 3「承認する」。承認の範囲はこの 3 件のマイグレーション（008・009・010）と、それに伴うドメインの変更。それ以外のスキーマ変更は、改めて確認する。

### 案 1: カスタム条件（役割ごとの初期在庫と、初期の流れ）— マイグレーション 008

**なぜ要るか**: 契約の `CustomConditions` は、役割ごとの初期在庫（`initialInventory: {役割: 数}`）と、初期の流れ（`initialFlow`。遅延の各段にある数量。キットは 4）を持つ。TS は、全役割に共通の初期在庫 1 つだけを持ち、初期の流れは定数（`INITIAL_PIPELINE = 4`）。共有 UI の `custom-conditions-ui`（「**小売店の**初期在庫を 20 に変える」）は役割ごとの値を送るので、**この変更が無いと `@ui` の 1 シナリオが TS で通らない**。ロビーの「カスタム（変更: 初期在庫、配送の遅延）」の表示にも、`INITIAL_INVENTORY`・`INITIAL_FLOW` の区別が要る。

**スキーマ（案）**: `games` の整数列 `initial_inventory` を、**役割ごとの 4 列**に置き換え、`initial_flow` を足す（`games` は、条件を平らな列で持つ現在の流儀のまま。CHECK 制約で守れる）。`sessions.settings`（jsonb。開始時点の条件の写し）も、同じ形に変換する。

```sql
-- Up
ALTER TABLE games
  ADD COLUMN initial_inventory_factory     integer CHECK (initial_inventory_factory     >= 0),
  ADD COLUMN initial_inventory_distributor integer CHECK (initial_inventory_distributor >= 0),
  ADD COLUMN initial_inventory_wholesaler  integer CHECK (initial_inventory_wholesaler  >= 0),
  ADD COLUMN initial_inventory_retailer    integer CHECK (initial_inventory_retailer    >= 0),
  ADD COLUMN initial_flow integer NOT NULL DEFAULT 4 CHECK (initial_flow BETWEEN 0 AND 1000);
UPDATE games SET initial_inventory_factory = initial_inventory, initial_inventory_distributor = initial_inventory,
                 initial_inventory_wholesaler = initial_inventory, initial_inventory_retailer = initial_inventory;
ALTER TABLE games
  ALTER COLUMN initial_inventory_factory SET NOT NULL, ALTER COLUMN initial_inventory_distributor SET NOT NULL,
  ALTER COLUMN initial_inventory_wholesaler SET NOT NULL, ALTER COLUMN initial_inventory_retailer SET NOT NULL,
  DROP COLUMN initial_inventory;
UPDATE sessions SET settings = settings
  || jsonb_build_object('initialInventory', jsonb_build_object(
       'FACTORY', settings->'initialInventory', 'DISTRIBUTOR', settings->'initialInventory',
       'WHOLESALER', settings->'initialInventory', 'RETAILER', settings->'initialInventory'),
     'initialFlow', 4)
 WHERE jsonb_typeof(settings->'initialInventory') = 'number';
-- Down: 4 列 → 1 列（小売店の値。役割ごとの違いは失われる。開発 DB だけの想定）、sessions.settings も数値に戻す
```

**ドメイン・アプリの変更**: `Conditions.initialInventory: number` → `Record<Role, number>`、`Conditions.initialFlow: number` を追加。`initialRoleStates` は役割ごとの在庫と `initialFlow` を使う。`ConditionItem` に `initialFlow` を追加。`kitPreset`（キットとの差の判定）は、役割ごとに比べる（どれか 1 つでも違えば `INITIAL_INVENTORY`）。永続化（`pg-repositories.ts`）、出力の元データの読み取り（`pg-export-reader.ts`）、HTTP の入力の検証（zod）、`contract-settings.ts` の写像（`initialFlow` → `INITIAL_FLOW`）を直す。

**範囲の合わせ込み**: TS の条件の範囲は「仮の値（運営者と未合意）」で、契約より狭い（初期在庫 0〜100、遅延 1〜4 週、費用 0〜1000。契約は 0〜1000、1〜8、0〜100000。初期の流れは 0〜1000）。共有 UI の入力の検証は契約の範囲なので、**TS も契約の範囲に合わせる**案（`CONDITION_LIMITS` を 1 か所で変更。DB の CHECK は下限だけなので変更不要）。

**公開範囲の呼び名**: 契約は `NONE`、TS の内部は `PROGRESS_ONLY`。入力で `NONE` を受けて `PROGRESS_ONLY` に写す（HTTP の境界。保存済みの値は変えない。スキーマ変更なし）。

**影響**: `initialInventory` を使うテスト・UI が 14 ファイル（テスト 9、`ui/` 5。計 41 か所）。**旧い経路（`/api/*`）と旧い UI は、段階 4・6 で撤去するまで、`settings.initialInventory` を数値で返す必要がある**ので、旧い経路の応答だけ、小売店の値を返す暫定の写し（`settingsView`）を置く（段階 4 で撤去）。

**却下した案**: ①`jsonb` 1 列（`initial_inventory_by_role`）— 列の流儀と CHECK 制約の利点を失う。②今の整数列を残し、「差分だけ」を別の jsonb に持つ — 判定が二重になる。③TS では役割ごとの初期在庫を受けず、`@ui` の当該シナリオを許可リストで除外 — 契約への適合が崩れ、共有 UI の機能が TS だけ欠ける。

### 案 2: 開始後の役割の入れ替え（H4）と資格の失効・再発行 — マイグレーション 009

**なぜ要るか**: 契約の `assignRole`（`PUT /games/{g}/participants/{p}/role`）は、準備中の付け替え（D9）に加え、**開始後**に、役割を持たない参加者を、すでに担当がいる役割へ割り当てる「入れ替え」を受け付け、旧担当者の資格を同じ操作で失効させる。ロビーは、入れ替えられた旧担当者を `replaced: true` で残す（履歴と入力者のラベルのため）。**共有 UI の `@ui` は、入れ替えを使わない**（`replaced` を参照する画面は無い。入れ替えは、`@api` の `credentials.feature` だけ）。**契約への適合のための実装**で、TS で `@ui` を通すだけなら、この案は後に回せる（ご判断）。

**スキーマ（案）**: `participants` に、**入れ替えられた時刻**を 1 列足すだけ。入れ替えられた旧担当者は、`role` を NULL にし、`replaced_at` を設定する。行は残す（`role_decisions.saved_by` が参照する入力者のラベルのため）。

```sql
-- Up
ALTER TABLE participants ADD COLUMN replaced_at timestamptz;
-- Down
ALTER TABLE participants DROP COLUMN replaced_at;
```

**ドメイン・アプリの変更**（契約の `assignRole` の規則どおり）:
- 準備中: **別の役割にいる人を選ぶと「付け替え」**（いまの TS は「すでに ○○ です」と拒否する。契約は `RoleUnassigned` と `RoleAssigned` で付け替える）。同じ役割への割り当て直しは、何も変えず 200（イベントも版も足さない）。
- 開始後: 担当者のいる役割へ、**役割を持たない参加者**を割り当てると、その役割の**現在の担当者全員**が入れ替わる（共同担当も全員）。旧担当者の復帰資格を失効（`recovery_revoked_at`）し、ブラウザセッション（`browser_sessions`）の行を、同じトランザクションで削除する。`session.holders`（開始時点の写し）を新担当者に更新し、game・session の両方の版を進める。新しいイベント（`RoleReplaced`）を、履歴に足す。
- 拒否: 別の役割にいる人の開始後の付け替えは `game.not_preparing`（409）、終了後は `session.already_ended`（409）、資格が失効済みの参加者は `game.credential_already_revoked`（409）、存在しない参加者は `game.participant_not_found`（404）。
- `Participant` に `replaced`（入れ替えられたか）を足し、ロビーの `replaced` に出す。ロビーと `getGameState`（`role`）は、入れ替えられた人を、役割の担当として数えない。
- **資格の失効・再発行**（`revokeCredential`・`reissueCredential`）は、既存の列（`participants.recovery_revoked_at`・`browser_sessions`）で足りる（**スキーマ変更なし**）。契約は、失効と再発行を別の操作に分け、失効済みでない資格の再発行を `game.credential_not_revoked`（409）、失効済みの再失効を `game.credential_already_revoked`（409）で拒否する。いまの TS の `reissueCredential`（失効＋再発行を 1 つで行う）は、契約の形に分ける。

**却下した案**: `participants` の行を消す（入力者のラベルと、`role_decisions` の参照が失われる）／`participants.role` に履歴を持たせる（担当の判定が複雑になる）。

### 案 3: `createGame` の冪等（`Idempotency-Key`）— マイグレーション 010

**なぜ要るか**: 契約は、変更系すべてに `Idempotency-Key` を必須とし、同じキーの再送は保存した応答を返す。共有 UI は、結果が不明な失敗（切断・`type` の無い 5xx）で、同じキーで最大 2 回再送する。TS の冪等記録（`idempotency_records`）は、`game_id` が `games` への外部キーなので、**ゲームの存在前の `createGame` は載せられなかった**。

**案**: 新しいゲームの ID（作成と同じトランザクションで作る）を `game_id` として、`scope = 'create'` の記録を保存し、**キーのダイジェストだけで検索できる部分一意索引**を足す（**新しい表は作らない**。Kotlin 版の設計（`uq_idempotency_create`）と同じ）。再送は、索引で記録を見つけ、保存した応答（暗号化済み。復帰コードを含む）を返す。本文が違えば `app.idempotency_key_reused`（409）。同時の重複は、一意制約の違反を競合として扱い、再試行で保存済みの応答を返す。

```sql
-- Up
CREATE UNIQUE INDEX uq_idempotency_create ON idempotency_records (key_digest) WHERE scope = 'create';
-- Down
DROP INDEX uq_idempotency_create;
```

**ほかの変更系の冪等**（`joinGame`・`recoverParticipation`・`joinAsObserver` など）は、対象のゲームが先に決まる（参加コード・本文の `gameId`・招待から）ので、**既存の表と主キーのまま**で足りる（スキーマ変更なし）。

**却下した案**: 作成だけ冪等を保存しない — 再送で、ゲームが重複して作られる（共有 UI が再送する前提と合わない）。

### 承認された内容

1. 案 1（マイグレーション 008。範囲を契約に合わせることを含む）— **承認**
2. 案 2（マイグレーション 009）— **段階 3 で実装する**
3. 案 3（マイグレーション 010）— **承認**

## 進捗

| 段階 | 状態 | 備考 |
| :-: | :--- | :--- |
| 0 | 完了（2026-11-24） | 契約テストの土台（35 件）は通過。依存の版は 2026-11-24 に公式レジストリで確認（ajv 8.20.0、ajv-formats 3.0.1、yaml 2.9.1。いずれも exact 指定） |
| 1 | 完了（2026-11-24） | `getHealth`・`getReady` を `/api/v1` に実装（未実装は 25 → 23 件）。problem+json（`code`・`type`・`errors[]`・`Retry-After`）、Origin（`ALLOWED_ORIGINS`）、`Idempotency-Key` の検査、本文 64 KB、404 を契約の形で。**旧い経路（`/api/*`）は従来の形のまま**（段階 4 まで。URL の接頭辞で切り替える）。537 件通過 |
| 2 | 完了（2026-11-24） | 読み取りの 7 操作（`getGameState`・`getSessionState`・`getLobby`・`getObservation`・`getReview`・`getExport`・`getRetention`）を `/api/v1` に実装（未実装は 23 → 16 件）。応答は契約のスキーマに適合し、開示・認可の規則（参加者は自分の役割だけ、観察者に役割別の値を見せない、終了前は 409 `game.not_ended`、無資格・別ゲーム・存在しないゲームは同じ 403）を契約テスト 26 件で検査。564 件通過。**ゲート 1 で、マイグレーション 007（`role_decisions.saved_at`）を承認**（2026-11-24、ユーザー）。`versions.game`・`versions.session` は、既存の `games.version`・`sessions.version` から返せる（スキーマ変更なし） |
| 3〜7 | 未着手 | |

### 段階 2 で、後の段階へ持ち越したもの・分かったこと

| 項目 | 持ち越し先 | 内容 |
| :--- | :-: | :--- |
| **カスタム条件の形の差（ドメインの変更）** | 3（開始前にゲート） | 契約の `CustomConditions` は、役割ごとの初期在庫（`initialInventory: {役割: 数}`）と初期の流れ（`initialFlow`）を持つ。TS は、全役割に共通の 1 つの初期在庫しか持たず、初期の流れは固定（4）。共有 UI の `custom-conditions-ui`（「小売店の初期在庫を 20」）は、役割ごとの値を使う。**ドメインの条件（`Conditions`）の変更と、`games.initial_inventory`（整数）の保存形式の変更（スキーマ変更）が要る**ので、段階 3 の `createGame` の前に、案を示して確認する |
| 公開範囲の呼び名 | 3 | 契約は `TEAM_TOTAL`・`NONE`、TS の内部は `TEAM_TOTAL`・`PROGRESS_ONLY`。読み取りは `disclosureNameOf` で写す。作成の入力は、段階 3 で `NONE` → `PROGRESS_ONLY` に写す（保存済みの値は変えない） |
| 出力の形の版 | 4 | 契約の出力は `beer-game-kotlin.export.v1`（Kotlin・Rust と同じ形式なので同じ値）。旧い出力（`beer-game2.export.v1`）は、旧い経路と一緒に、段階 4 で撤去する（前に「`beer-game2.export.v1` は変えない」としたのは、旧い経路の出力のこと） |
| `RoleStatus.decisionSavedAt` | — | 完了。永続化が、新しく保存された入力に `now()` を付け、既存の入力の時刻は引き継ぐ（別の役割の保存で変わらないことを、PostgreSQL の統合テストで検査） |
| 保持の `nextAttemptAt`・`lastFailureCode` | — | `nextAttemptAt` は、再試行を定期のタスクの次の実行で行い、指数の待ちを持たないので null。`lastFailureCode` は記録していないので null。契約の型は両方とも null を許す。`IN_PROGRESS` は、状態の記録が無いので現れない |
| 開始後の役割の入れ替え（H4）の `replaced` | 3 | 読み取りは `replaced` を省略（false）。H4 の実装は、段階 3 の前にスキーマ変更の案を確認する（2026-11-24、実装することは承認済み） |

### 段階 1 で、後の段階へ持ち越したもの

| 項目 | 持ち越し先 | 理由 |
| :--- | :-: | :--- |
| `Idempotency-Key` の**保存と再生**（同じキーで本文が違えば 409 `app.idempotency_key_reused`）。いまは、変更系の**存在と形の検査**だけ | 3 | 保存はコマンドごと（既存の `idempotency_records` はゲーム単位。commit だけが使っている）。**`createGame` はゲームが存在する前なので、この表（`game_id` が外部キー）に載せられない**。扱い（キーからゲーム ID を決めて再生する、など）を、段階 3 の `createGame` で決める（スキーマ変更が要るならゲート 1） |
| 業務の失敗の `code`（`session.paused` ほか 18 種）への写し。`StaleError`・`DecisionConflictError` は、いまは `app.internal` | 3 | 操作ごとに、返す `code` と拡張メンバー（`latest`・`current`・`missingRoles` など）が違う |
| `NotFoundError` の扱い（いまは 404 `request.not_found`）。存在しないゲームを「資格が無い」と区別しない 403 にするかは、操作ごと | 3 | 契約は、存在の有無を明かさない箇所（資格・ゲーム）と、`game.invitation_not_found` を持つ |
| `405 request.method_not_allowed` | 3 | 経路の表から、同じ経路の別メソッドを判定する必要がある。共有 UI は起こさない |
| `x-correlation-id` を、UUID のときだけ採用する規則（契約）。いまは、どんな文字列も採用 | 4 | 既存の統合テストが、UUID でない値（`corr-123`）の反映を検査している。旧 API の撤去と同時に直す |
| `Secure` 属性の設定（契約は「HTTPS の環境では Secure」。いまは常に `secure: true`） | 5 | 共有 UI の E2E は `http://localhost`（WebKit は Secure の Cookie を受けない）。設定項目（`COOKIE_SECURE` など）が要る |
| `ALLOWED_ORIGIN`（旧名）の撤去、Terraform（`allowed_origin`）・`container-check.sh` の環境変数名の更新 | 4〜5 | 現在は旧名も受ける（優先は `ALLOWED_ORIGINS`）。AWS は未適用 |

## 更新履歴

| 日付 | 更新内容 | 更新者 |
| :--- | :--- | :--- |
| 2026-11-24 | 初版作成（段階 0。差分表と段階・ゲート） | claude-code |
| 2026-11-24 | 段階 1 の完了を反映（横断の仕組み、`getHealth`・`getReady`、持ち越しの一覧） | claude-code |
| 2026-11-24 | 段階 2 の完了を反映（読み取り 7 操作、マイグレーション 007 の承認、段階 3 へ持ち越す差） | claude-code |
