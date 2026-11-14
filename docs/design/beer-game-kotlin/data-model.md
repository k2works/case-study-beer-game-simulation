---
type: Design
title: "データモデル設計 - ビールゲームシミュレーション（Kotlin 版）"
description: "Kotlin 版のデータモデル。イベントストア（ストリーム・版・楽観的並行制御・冪等キー）、スナップショットの要否、投影テーブル、周辺ストア、保持削除、マイグレーション、インデックスを整理した正本。"
tags: [design]
status: draft
generated: { by: claude-code/claude-sonnet-5-5, at: 2026-11-14T07:17:34Z }
---

# データモデル設計 - ビールゲームシミュレーション（Kotlin 版）

## 概要

本書は、beer-game-kotlin のデータモデルを、概念データモデルから論理データモデルへ段階的に定義します。**`docs/` を設計の正本**とします。

[beer-game2 のデータモデル](../beer-game2/data-model.md) は、集約ごとの現在の状態を表に持ち、版つきで更新していました。本書は、[ドメインモデル（Kotlin 版）](./domain-model.md) の**イベントソーシング + CQRS**に合わせ、次のように作り直します。

- **書き込み側の正本は、追記専用の `events` 表**です。状態は、イベントの再生（`fold(evolve)`）で導きます。
- **読み取り側は、投影テーブル**です。イベントの追記と同じトランザクションで更新し、いつでもイベントから作り直せます。
- イベントに入れない**個人情報（表示名）と秘密（資格のダイジェスト）は、周辺ストア**に置きます（NF-S14）。
- すべての表は `game_roots(game_id)` への外部キー（`ON DELETE CASCADE`）を持ち、**1 回の削除で漏れなく消えます**（NFR-07、ADR-007 を引き継ぎ）。

データベースは PostgreSQL で、スキーマは番号つきの SQL マイグレーションで管理します（ツールは [技術スタック](./tech-stack.md) で決めます）。永続化の失敗は、例外のまま漏らさず境界で `Either` に変換します（[ガイド §7.6](../../reference/関数型プログラミングガイド_Kotlin編.md)）。

### beer-game2 からの設計方針の変更

| # | beer-game2 | beer-game-kotlin | 理由 |
| :--- | :--- | :--- | :--- |
| 1 | `games`・`sessions` などが現在の状態を持ち、`version` で版つき更新 | **`events` が正本**。`games` などは投影（読み取りモデル）になり、更新の版を持たない | ES（ドメインモデル D1） |
| 2 | 版は `games.version`、`sessions.version`（行の版） | **ストリームの版**（`events.stream_version`）。`(game_id, stream_type, stream_version)` の一意制約で、楽観的並行制御を行う | 追記の競合の検出 |
| 3 | `events` は、監査と通知の再送のための記録（`published_at`） | `events` は**状態の正本**であり、監査を兼ねる。通知は版だけで再送が不要なので `published_at` を廃止 | SSE は版の通知だけ（ADR-006） |
| 4 | 現在の意思決定は `role_decisions`（行を更新） | イベント（`DecisionSaved` など）が正本。`current_decisions` が投影 | 投影 |
| 5 | `week_results` / `week_role_results` は集約の表（確定時に書く） | `WeekCommitted` が正本。`week_commits` / `week_role_results` が投影 | CQRS（ADR-005 の意図を維持） |
| 6 | 観察は、`week_role_results` を `SUM` して返す | **`week_team_totals` を別の投影**にし、観察者の問い合わせは役割別の行に到達しない | 最小権限（逆算の防止、BR-17） |
| 7 | 表示名・資格ダイジェストは、集約の表の列 | **周辺ストア**（`display_profiles`、`credentials`）。イベントには入れない | NF-S14（イベント = 監査） |
| 8 | 保持削除は、`games` の `CASCADE` | `game_roots` を根にした `CASCADE`。`retention_*` も同じ根を使う | `games` が投影になったため、根を独立させる |
| 9 | `deletion_runs` は `game_id` を残す | 完了と同じトランザクションで `deletion_runs`・`deletion_attempts` の行も消す。証跡はダイジェストだけ | 削除後にゲーム ID を含む行を残さない（AC5.1.4） |
| 10 | 冪等記録は 24 時間（`idempotency_records`） | 維持。同じトランザクションで追記と一緒に書く | NFR2.6（NF-R6） |

## 概念データモデル

```plantuml
@startuml
title 概念データモデル（Kotlin 版）
hide circle
left to right direction

entity ゲームの根
entity イベント
entity 投影
entity 周辺ストア
entity 冪等記録
entity 保持方針
entity 保持削除

ゲームの根 ||--o{ イベント : 2 ストリーム\n（game / session）
ゲームの根 ||--o{ 投影 : イベントから導出
ゲームの根 ||--o{ 周辺ストア : 表示名・資格
ゲームの根 ||--o{ 冪等記録
ゲームの根 ||--|| 保持方針
保持方針 ||--o| 保持削除
@enduml
```

| 概念エンティティ | 対応するドメイン概念 | 説明 |
| :--- | :--- | :--- |
| ゲームの根（`game_roots`） | — | 連鎖削除の根。ゲームの作成と同じトランザクションで 1 行作る |
| イベント（`events`） | Game・Session の 2 ストリーム | 追記専用。状態の正本であり、監査の記録を兼ねる |
| 投影 | 読み取りモデル（[ドメインモデル](./domain-model.md) の投影） | ロビー、役割別の週結果、観察（チーム合計）、現在の意思決定など（出力は投影にしない） |
| 周辺ストア | D7 | 表示名、資格のダイジェスト、ブラウザセッション。イベントに入れない値 |
| 冪等記録 | 横断 | 重複排除と、同じ結果の再返却（応答は暗号化） |
| 保持方針、保持削除 | RetentionSaga（D8） | 期限と、削除の進行（プロセスマネージャーの状態） |

### ドメインの概念と表の対応

| ドメイン（Kotlin） | 表 | 種別 |
| :--- | :--- | :--- |
| `GameEvent`、`SessionEvent` | `events` | 書き込み側の正本 |
| ストリーム `(GameId, StreamType)` | `events` の `(game_id, stream_type)` | — |
| `GameOverview` | `game_overview` | 投影 |
| `GameSettingsView` | `game_settings` | 投影 |
| `Lobby` | `lobby_participants`、`lobby_observer_invitations`、`lobby_observers` | 投影 |
| `SessionOverview` | `session_overview` | 投影 |
| `RoleCurrentState` | `role_current_states` | 投影 |
| `CurrentDecisions` | `current_decisions` | 投影 |
| `WeekRoleResults`（振り返り） | `week_commits`、`week_role_results` | 投影 |
| `WeekTeamTotals`（観察） | `week_team_totals` | 投影 |
| `ExportPackage` | （表なし） | 問い合わせ時に純粋関数 `buildExport` で作る（投影にしない） |
| `RetentionPolicyView` | `retention_policies` | 投影 |
| 表示名 | `display_profiles` | 周辺ストア |
| 資格（進行役・復帰・観察用の招待） | `credentials` | 周辺ストア |
| ブラウザセッション | `browser_sessions` | 周辺ストア |
| 冪等キー | `idempotency_records` | 横断 |
| `RetentionSaga` | `deletion_runs`、`deletion_attempts`、`deletion_receipts` | 状態（D8） |

## 論理データモデル

### ER 図（イベントストアと周辺ストア）

```plantuml
@startuml
title 論理 ER 図 - イベントストアと周辺ストア
hide circle
skinparam linetype ortho

entity "game_roots" as roots {
  * game_id : uuid <<PK>>
  --
  created_at : timestamptz
}

entity "events" as events {
  * event_id : uuid <<PK>>
  --
  seq : bigint <<UK, identity>>
  game_id : uuid <<FK>>
  stream_type : text
  stream_version : bigint
  event_type : text
  schema_version : integer
  payload : jsonb
  actor_kind : text
  actor_id : uuid
  correlation_id : uuid
  command_id : uuid
  occurred_at : timestamptz
  --
  UK (game_id, stream_type, stream_version)
}

entity "projection_checkpoints" as checkpoints {
  * game_id : uuid <<PK, FK>>
  * stream_type : text <<PK>>
  --
  projected_version : bigint
  updated_at : timestamptz
}

entity "display_profiles" as profiles {
  * game_id : uuid <<PK, FK>>
  * actor_kind : text <<PK>>
  * actor_id : uuid <<PK>>
  --
  display_name : text
  created_at : timestamptz
}

entity "credentials" as credentials {
  * credential_digest : text <<PK>>
  --
  game_id : uuid <<FK>>
  kind : text
  subject_id : uuid
  key_version : integer
  issued_at : timestamptz
  expires_at : timestamptz
  revoked_at : timestamptz
}

entity "browser_sessions" as sessions {
  * credential_digest : text <<PK>>
  --
  game_id : uuid <<FK>>
  actor_kind : text
  actor_id : uuid
  key_version : integer
  expires_at : timestamptz
}

entity "idempotency_records" as idem {
  * game_id : uuid <<PK, FK>>
  * scope : text <<PK>>
  * key_digest : text <<PK>>
  --
  request_digest : text（本文・対象・操作者 ID の HMAC）
  status_code : integer
  response : bytea（暗号化）
  expires_at : timestamptz
}

roots ||--o{ events
roots ||--o{ checkpoints
roots ||--o{ profiles
roots ||--o{ credentials
roots ||--o{ sessions
roots ||--o{ idem
@enduml
```

### ER 図（投影テーブル）

```plantuml
@startuml
title 論理 ER 図 - 投影テーブル（読み取りモデル）
hide circle
skinparam linetype ortho

entity "game_roots" as roots {
  * game_id : uuid <<PK>>
}

entity "game_overview" as overview {
  * game_id : uuid <<PK, FK>>
  --
  status : text
  join_code : text <<UK>>
  final_week : integer
  commit_mode : text
  settings_kind : text
  settings_changes : jsonb
  retention_days : integer
  created_at : timestamptz
  started_at : timestamptz
  ended_at : timestamptz
}

entity "game_settings" as settings {
  * game_id : uuid <<PK, FK>>
  --
  demand : jsonb
  initial_conditions : jsonb
  holding_cost_minor : integer
  backlog_cost_minor : integer
  order_delay_weeks : integer
  shipment_delay_weeks : integer
  production_delay_weeks : integer
  disclosure_policy : text
}

entity "lobby_participants" as lp {
  * participant_id : uuid <<PK>>
  --
  game_id : uuid <<FK>>
  role : text
  joined_at : timestamptz
}

entity "lobby_observer_invitations" as li {
  * invitation_id : uuid <<PK>>
  --
  game_id : uuid <<FK>>
  expires_at : timestamptz
  revoked_at : timestamptz
  created_at : timestamptz
}

entity "lobby_observers" as lo {
  * observer_id : uuid <<PK>>
  --
  game_id : uuid <<FK>>
  invitation_id : uuid
  joined_at : timestamptz
}

entity "session_overview" as so {
  * game_id : uuid <<PK, FK>>
  --
  status : text
  week : integer
  started_at : timestamptz
  ended_at : timestamptz
}

entity "role_current_states" as rcs {
  * game_id : uuid <<PK, FK>>
  * role : text <<PK>>
  --
  inventory : integer
  backlog : integer
  order_pipeline : jsonb
  shipment_pipeline : jsonb
  production_pipeline : jsonb
  cumulative_cost_minor : bigint
  as_of_week : integer
}

entity "current_decisions" as cd {
  * game_id : uuid <<PK, FK>>
  * role : text <<PK>>
  --
  week : integer
  quantity : integer
  decision_version : bigint
  editor_kind : text
  editor_id : uuid
  updated_at : timestamptz
}

entity "week_commits" as wc {
  * game_id : uuid <<PK, FK>>
  * week : integer <<PK>>
  --
  commit_kind : text
  contributors : integer
  stream_version : bigint
  committed_at : timestamptz
}

entity "week_role_results" as wrr {
  * game_id : uuid <<PK, FK>>
  * week : integer <<PK, FK>>
  * role : text <<PK>>
  --
  demand : integer
  shipped : integer
  ordered : integer
  ending_inventory : integer
  ending_backlog : integer
  weekly_cost_minor : integer
  cumulative_cost_minor : bigint
}

entity "week_team_totals" as wtt {
  * game_id : uuid <<PK, FK>>
  * week : integer <<PK, FK>>
  --
  total_ordered : integer
  total_inventory : integer
  total_backlog : integer
  contributors : integer
}

entity "retention_policies" as rp {
  * game_id : uuid <<PK, FK>>
  --
  retention_days : integer
  retention_starts_at : timestamptz
  delete_after : timestamptz
}

roots ||--|| overview
roots ||--|| settings
roots ||--o{ lp
roots ||--o{ li
roots ||--o{ lo
roots ||--o| so
roots ||--o{ rcs
roots ||--o{ cd
roots ||--o{ wc
wc ||--|{ wrr
wc ||--|| wtt
roots ||--|| rp
@enduml
```

### ER 図（保持と削除）

```plantuml
@startuml
title 論理 ER 図 - 保持と削除
hide circle
skinparam linetype ortho

entity "game_roots" as roots {
  * game_id : uuid <<PK>>
}

entity "retention_policies" as policies {
  * game_id : uuid <<PK, FK>>
  --
  retention_days : integer
  retention_starts_at : timestamptz
  delete_after : timestamptz
}

entity "deletion_runs" as runs {
  * deletion_id : uuid <<PK>>
  --
  game_id : uuid <<UK>>
  status : text
  attempt : integer
  requested_at : timestamptz
  next_attempt_at : timestamptz
  last_failure_code : text
}

entity "deletion_attempts" as attempts {
  * deletion_id : uuid <<PK, FK>>
  * attempt : integer <<PK>>
  --
  started_at : timestamptz
  failure_code : text
}

entity "deletion_receipts" as receipts {
  * deletion_id : uuid <<PK>>
  --
  game_reference_digest : text
  outcome : text
  recorded_at : timestamptz
  expires_at : timestamptz
}

roots ||--|| policies
policies ..o| runs : game_id（論理参照）
runs ||--o{ attempts
runs ..o| receipts : 完了時に 1 件
@enduml
```

`deletion_runs` と `deletion_attempts` は `game_roots` へ外部キーを持ちません（ゲームのデータが消えた後も、再試行の記録として生き残るため）。**完了と同じトランザクションで、この 2 表の行も削除**し、`game_id` を含む行を残しません。`deletion_receipts` は、ゲームを特定しない証跡（ダイジェストだけ）で、1 年後に削除します。

## イベントストア

### ストリームと版

- ストリームは `(game_id, stream_type)` で識別します。1 ゲームにつき `GAME`（準備）と `SESSION`（進行）の 2 本です（ドメインモデル D1）。
- `stream_version` は、ストリームの中で 1 から連続する整数です。`State.version`（`evolve` が数えた適用数）と等しくなります。
- `seq` は、ゲームをまたぐ追記の順序（`bigint` の identity）です。監査と将来の購読者の取り込み順に使います。コミットの順序とは必ずしも一致しないため、**業務上の順序は `stream_version`** とします。

### 追記と楽観的並行制御

```text
read:    SELECT ... FROM events WHERE game_id = $1 AND stream_type = $2 ORDER BY stream_version
decide:  純粋（State と Command から List<Event>）
append:  INSERT INTO events (...stream_version = expected + 1 .. expected + n ...)
         -> 一意制約 uq_events_stream_version (game_id, stream_type, stream_version) の違反 = ConcurrencyConflict
```

1. アプリケーション層は、対象ストリームの全イベントを読み、`replay` で状態にします。**読んだときの版（`expected`）**を覚えます。
2. `decide` が返したイベント列を、**`expected + 1` から連続する版**で、1 回のトランザクションで追記します。
3. 同じ版が既にあれば、一意制約の違反になります。これを `ConcurrencyConflict`（`Either` の左）に変換して返します。**ロックは取りません**（beer-game2 の `SELECT ... FOR UPDATE` は不要になります）。
4. `ConcurrencyConflict` は、**自動で再試行します**（上限は小さな固定回数。実装開始時に決める）。再読み込みで状態が進んでいるため、`decide` が再評価され、業務上の競合（`DecisionConflict`、`WeekAdvanced`、`DecisionsChanged`、`AlreadyStarted`）は `decide` が正しく返します。再試行で結果が変わらない失敗は、そのまま利用者へ返します。
5. `decide` が空のイベント列を返したとき（例: 同じ役割への再割り当て）は、追記しません。

複数ストリームのコマンド（`StartGame`）は、両ストリームを読み、両方の期待する版を持って、**同じトランザクションで**追記します（[ガイド §7.6](../../reference/関数型プログラミングガイド_Kotlin編.md)）。

```kotlin
// 関数の束として定義し、PostgreSQL 版とインメモリ版を差し替える（ガイド §7.2、§7.6）
data class EventStore(
    val read: suspend (Tx, GameId, StreamType) -> Either<PersistenceFailure, StreamRead>,   // events と version
    val append: suspend (Tx, Map<StreamType, StreamVersion>, List<NewEvent>) -> Either<AppendFailure, Unit>,
    val transaction: suspend (suspend (Tx) -> Either<AppendFailure, Unit>) -> Either<AppendFailure, Unit>,
)
// transaction の戻り値の型は、実装では総称にする（スケッチのため Unit で示す）
```

### 共同入力の競合は、ストリームの版とは別

共同担当の意思決定の競合（FR-16）は、**ストリームの版でなく、イベント内の意思決定の版**（`DecisionSaved.decisionVersion`）で検出します。同じ役割の 2 人が同時に保存すると、一方はストリームの版で衝突します。再読み込みすると、もう一方の保存が反映されているため、`decide` は `DecisionConflict(role, latest)` を返し、最新値と最後の保存者を示します（変更を黙って失いません）。

### 冪等性

| 層 | 仕組み | 範囲 |
| :--- | :--- | :--- |
| コマンドの再送（HTTP） | `idempotency_records`。`(game_id, scope, key_digest)` で検索し、`request_digest` が同じなら、保存した**成功の応答**（暗号化）をそのまま返す。違えば `app.idempotency_key_reused`（409） | 24 時間（NF-R6） |
| 追記の一回性 | ストリームの版の一意制約 | 永続 |
| 週確定の一回性 | `WeekCommitted` は 1 週につき 1 件。`decide` が `requestedWeek` と意思決定の版（`basis`）を検査する（ストリームの版は前提にしない） | 永続 |
| 開始の一回性 | `SessionStarted` は `SESSION` ストリームの版 1 | 永続 |

`idempotency_records` の行は、**追記と同じトランザクション**で書きます。これにより、「追記は成功したが記録が無い」状態を作りません。応答が資格の生の値を含む操作（ゲームの作成、参加、復帰）の再送も、同じ値を返せます（応答を暗号化して保存するため）。

**コマンド処理の順**は、「認証（操作者・資格の有効性）→ 認可の前提検査 → 冪等記録の照合 → 読み込み → `decide` → 追記・投影」です。冪等記録の照合を認可より先に置きません。入れ替えで失効した旧担当者が以前のキーを再送しても、保存済みの応答（参加・復帰では資格の生の値）を返さず、403 にするためです。

- `request_digest` は、**本文・対象・操作者の ID** の鍵付き HMAC です。同じキーでも操作者が違えば `app.idempotency_key_reused`（409）になります。
- 保存するのは**成功した応答だけ**です。業務の失敗（`Left`）は保存しません。再送は、同じ失敗を再計算して返します（状態が変わっていれば結果も変わりうる）。
- 失効した資格が過去のキーを再送しても、認証の段階で 403 です（保存済みの応答は返りません）。

ゲーム作成の冪等は、作成の要求（`scope = 'create'`）を、`GameCreated` の追記と同じトランザクションで、新しい `game_id` で保存します。同じ冪等キーの再送は、`(scope, key_digest)` の部分一意索引（`WHERE scope = 'create'`）で検索します。

### 一意制約の衝突の扱い（制約名の正本）

再試行・再照合の対象にする一意制約を、名前つきで次に定めます。**この表が正本**で、[バックエンドアーキテクチャ](./architecture-backend.md) も同じ表を持ちます。

| 制約名 | 表 | 衝突の意味 | 扱い |
| :--- | :--- | :--- | :--- |
| `uq_events_stream_version` | `events` | 同じストリームへの同時の追記 | 読み直して `decide` からやり直す（`ConcurrencyConflict`、上限つき） |
| `uq_idempotency_create` | `idempotency_records`（`scope = 'create'` の部分一意索引） | 同じキーのゲーム作成の同時の重複 | 記録を再照合し、保存済みの応答を返す（500 にしない） |
| `pk_idempotency_records` | `idempotency_records` | 同じキー・同じ対象の同時の重複（空の列を返す操作を含む） | 記録を再照合し、本文の digest が同じなら保存済みの応答、違えば `app.idempotency_key_reused`（409） |

上の 3 つ以外の一意制約違反は、設計上起きないはずなので、500 と相関 ID（ログ）で返します。制約には、この名前を明示して付けます（マイグレーション 001・002）。

イベントの封筒の `command_id` は、同じコマンドから生まれたイベントを束ねるための識別子で、冪等キーとは別です（冪等キーのダイジェストはイベントに入れません）。

### イベントのスキーマ

- `payload` は JSON（`jsonb`）で、`event_type` を型の判別に使います。`schema_version` は、ペイロードの形の版です。
- **イベントは変更しません。** 形が変わるときは、新しい `schema_version` を追加し、読み込み時に**アップキャスト**（旧版 → 新版の純粋関数）して `evolve` へ渡します。
- ペイロードに、表示名・資格の値・招待コードの値を入れません（ドメインモデル D7）。

### 追記専用の保護

- アプリケーションが使う DB ロールには、`events` の **INSERT と SELECT だけ**を与え、UPDATE と DELETE を与えません。
- 保持削除は、別のロールが `game_roots` を削除し、**外部キーの連鎖**で `events` の行が消えます。連鎖削除が、`events` に DELETE 権限を持たないロールでも動くことは、実装開始時に確認します（未決事項）。

### スナップショット

**導入しません。** 判断は次のとおりです。

| 観点 | 見積もり（前提を明示） |
| :--- | :--- |
| 1 ストリームの最大長 | `SESSION` は、50 週 ×（4 役割 × 数回の保存 + 確定 1 + 例外の操作）で、**千件前後**と見積もる。`GAME` は、参加者・割り当て・招待・資格で、数十〜百件程度 |
| 再生のコスト | 純粋な `fold` で、千件程度の `evolve` は小さい（実測で確認する） |
| 規模 | 同時 15 チーム（NFR-04）。1 コマンドが読むのは 1 ゲームのストリームだけ |
| 1 ゲームの保存量 | 千件 × 1〜数 KB で、数 MB 以下 |

| 案 | 内容 | 評価 |
| :--- | :--- | :--- |
| **A（採用）** | スナップショットなし。毎回、ストリーム全体を再生する | 実装が単純で、復元（FR-12）は再生と同じ経路。上の見積もりでは十分 |
| B | 確定のたびに `session_snapshots` を作り、そこからの差分を再生する | 再生が短くなる。スナップショットの版管理（スキーマ変更時の無効化）と、保持削除の対象が増える |

導入の基準: コマンド処理の再生時間が、NFR-03（入力確定の 95 パーセンタイルを 1 秒以内）の予算を圧迫すると**実測で分かった場合**にだけ、`B` を導入します。

## 投影

### 更新の方式（同期投影）

投影は、**イベントの追記と同じトランザクション**で更新します（同期投影）。

| 案 | 内容 | 評価 |
| :--- | :--- | :--- |
| **A（採用）** | 追記と同じトランザクションで、投影の行を更新する | 追記の直後に、読み取りが必ず反映される（週確定後の画面反映 2 秒、NFR-03。SSE の版の通知を受けて取得した状態が、通知の版以上であることを保証）。投影の遅れによる障害の種類が無い |
| B | 別のワーカーが、`seq` を購読して非同期に更新（チェックポイントあり） | 書き込みと読み取りを分離できる。結果整合で、通知の版が投影に追いつかない窓が生まれる。ワーカーの運用が増える |

トレードオフ: A は、追記のトランザクションが長くなります。投影の更新は、イベント 1 件につき数行の更新で、計算は純粋で軽いため許容します。将来、読み取りの負荷が書き込みを圧迫する場合に、B へ移行できるよう、投影は `Projection<Row>`（純粋）として書き、更新の仕組みと分けます。

`projection_checkpoints` は、投影が適用した最後のストリームの版を持ちます。次の目的に使います。

- 検証: `projected_version` と `MAX(stream_version)` が一致することを、整合性の検査で確認する。
- 再構築: 投影の作り直しの範囲を決める。

### 投影の再構築

投影の行は、`events` からいつでも作り直せます。**手順**: ゲームの投影の行を削除し、`events` を `stream_version` の順に畳み込み、`projection_checkpoints` を更新する。スキーマの変更（投影の列の追加など）は、マイグレーションの後にこの再構築で埋めます。再構築の同時実行制御（そのゲームの追記を止めるか、アドバイザリロックを取るか）は、未決事項です。

### 投影テーブルの定義

| テーブル | 主キー | 購読するイベント | 主な制約・内容 |
| :--- | :--- | :--- | :--- |
| `game_overview` | `game_id` | `GameCreated`、`GameStarted`、`AutoCommitChanged`、`SessionEnded` | `status` は `PREPARING`・`STARTED`・`ENDED`（`SessionEnded` で導出）。`join_code` 一意。`final_week` は 1〜50。`commit_mode` は `MANUAL`・`AUTO`。`settings_kind` は `KIT`・`CUSTOM`。`settings_changes` に準拠値から変えた項目 |
| `game_settings` | `game_id` | `GameCreated` | 需要系列、初期条件、費用、遅延、公開範囲。遅延と単価は 0 以上。**進行役の画面にだけ**使う（将来の需要を含むため） |
| `lobby_participants` | `participant_id` | `ParticipantJoined`、`RoleAssigned`、`RoleUnassigned` | `game_id` は外部キー。`role` は 4 値または NULL。**`(game_id, role)` の一意制約は無い**（共同担当、FR-16）。表示名は `display_profiles` と結合 |
| `lobby_observer_invitations` | `invitation_id` | `ObserverInvited`、`ObserverInvitationRevoked` | 有効期限、失効。招待コードの値は持たない |
| `lobby_observers` | `observer_id` | `ObserverJoined` | 役割を持たない |
| `session_overview` | `game_id` | `SessionStarted`、`SessionPaused`、`SessionResumed`、`SessionEnded`、`WeekCommitted` | `status` は `ACTIVE`・`PAUSED`・`ENDED`。`week > 0` |
| `role_current_states` | `(game_id, role)` | `SessionStarted`、`WeekCommitted` | 当該役割の在庫、受注残、待ち行列、累積費用。**当該役割の参加者と進行役だけ**が読める |
| `current_decisions` | `(game_id, role)` | `DecisionSaved`、`ProxyDecisionSubmitted`、`WeekCommitted` | 当週の意思決定。`decision_version > 0`、`quantity >= 0` と上限（検査）。`editor_*` に最後に保存した人。確定で行を削除する |
| `week_commits` | `(game_id, week)` | `WeekCommitted` | `commit_kind` は `MANUAL`・`AUTO`。`stream_version` に、確定のイベントの版。**一度だけ確定**されることを、主キーでも守る |
| `week_role_results` | `(game_id, week, role)` | `WeekCommitted` | **役割別の週結果**。需要（受注）、出荷、発注、週末在庫、週末受注残、週次費用、累積費用。`(game_id, week)` は `week_commits` への外部キー（`CASCADE`） |
| `week_team_totals` | `(game_id, week)` | `WeekCommitted` | 週ごとのチーム合計（発注、在庫、受注残）と寄与者数。**役割別の値を持たない** |
| `retention_policies` | `game_id` | `GameCreated` | `retention_days` は 1〜3650（既定 90）、`delete_after > retention_starts_at` |

### 出力は投影にしない（`export_packages` の廃止）

出力（`ExportPackage`）は、同期投影にも非同期投影にもしません。**問い合わせの時に**、全域の純粋関数 `buildExport(settings, weekRoleResults): ExportPackage`（`Either` を返さない）で、`week_role_results` と設定（`game_overview`、`game_settings`）から作ります。`checksum` と `schema_version` も要求時に算出します。表 `export_packages` は持ちません。したがって、最終週の確定（`WeekCommitted` と `SessionEnded` の追記）は出力の作成に依存せず、画面に「準備中」の状態は要りません。

| 案 | 内容 | 評価 |
| :--- | :--- | :--- |
| **A（採用）** | 問い合わせ時に `buildExport` で作る | 最終週の確定（Must）が出力（Should）の失敗に左右されない。途中状態が無い。表が 1 つ減る |
| B | `SessionEnded` の同期投影として保存（旧案） | 取得が速い。投影の失敗が最終週の確定を失敗させうる |
| C | `SessionEnded` の後に別のトランザクションで作る | 確定とは切り離せるが、「準備中」の状態と再試行が要る |

トレードオフ: 要求のたびに計算します。1 ゲームの結果は小さい（50 週 × 4 役割）ため許容し、大きければ将来キャッシュを検討します（未決事項）。

### 読み取りの規則（認可と開示）

| 利用者 | 読めるもの | 読めないもの |
| :--- | :--- | :--- |
| 参加者（プレイ中） | 自分の役割の `role_current_states`・`current_decisions`・`week_role_results`、共通の `game_overview`・`session_overview`、ロビー（自分の役割と共同担当） | 他役割の行、`game_settings` の将来の需要、`week_team_totals` |
| 進行役 | 全役割の入力状況、`game_settings`、`lobby_*`、`week_team_totals`、確定した週の記録 | 参加者の資格の値 |
| 観察者 | `game_overview`、`session_overview`、`week_team_totals`（公開範囲と寄与者数で抑止） | 役割別の値、将来の需要、`week_role_results`（終了前） |
| 全員（終了後） | `week_role_results`（全役割の時系列） | — |
| 進行役（出力） | 要求時に `buildExport` が作る出力（CSV・JSON）。`week_role_results` と設定から導出する | — |

観察者の問い合わせは、DB の権限でも `week_role_results`・`role_current_states`・`current_decisions` に**到達できない**ようにします（最小権限。アプリのバグでも役割別の値が漏れにくい）。寄与者数による抑止（`contributors < 2` なら合計を出さない）は、問い合わせの層（`Disclosure`）で行います。

### 設計判断: 観察のための `week_team_totals`

| 案 | 内容 | 評価 |
| :--- | :--- | :--- |
| **A（採用）** | 確定時に、チーム合計を別の行にして保存する | 観察者向けの読み取りが役割別の行に触れない（権限で分離できる）。beer-game2 は、`SUM` を毎回計算した |
| B | 観察のたびに `week_role_results` を `SUM` する（beer-game2） | 行が 1 種類で単純。観察者の問い合わせが役割別の値に到達できてしまい、実装の誤りが直接の漏えいになる |

## 周辺ストア

イベントに入れない値を保存する、状態を持つ表です（ドメインモデル D7）。**追記と同じトランザクション**で書きます。書く内容は、コマンドが運んだ値（`DisplayName`、`IssuedCredential`）と、イベントの ID だけです。

| テーブル | 主キー | 内容 | 制約 |
| :--- | :--- | :--- | :--- |
| `display_profiles` | `(game_id, actor_kind, actor_id)` | 参加者と観察者の表示名 | `actor_kind` は `PARTICIPANT`・`OBSERVER`。表示名は 1〜80 文字（前後の空白を除く）。**ログ・イベント・出力に含めない**（NF-S14） |
| `credentials` | `credential_digest` | 進行役の資格、参加者の復帰資格、観察用の招待のダイジェスト | `kind` は `FACILITATOR`・`PARTICIPANT_RECOVERY`・`OBSERVER_INVITATION`。鍵付き HMAC のダイジェストと**鍵の版**だけを保存（ADR-009）。`expires_at`、`revoked_at` を持つ。**生の値は保存しない** |
| `browser_sessions` | `credential_digest` | ブラウザセッション（24 時間） | `actor_kind` は `FACILITATOR`・`PARTICIPANT`・`OBSERVER`。`expires_at` で掃除 |

`credentials.revoked_at` は、`CredentialRevoked` を追記する同じトランザクションで更新します（再発行では、新しい行を挿入し、旧行を失効させます）。**整合のルール**: 「`credentials` の失効・発行が、対応する `Credential*` イベント（または `GameCreated`・`ParticipantJoined`・`ObserverInvited`・`ObserverJoined`・`ParticipationRecovered`）と必ず一緒に起きる」ことを、統合テストで確認します。

## 保持削除

### 削除の網羅

すべての表（`deletion_*` を除く）が、`game_roots(game_id)` への外部キー（`ON DELETE CASCADE`）を持ちます。**`DELETE FROM game_roots WHERE game_id = $1` の 1 回で、イベント、投影、周辺ストア、冪等記録が連鎖して消えます**（ADR-007）。`deletion_runs`・`deletion_attempts` は、同じトランザクションで明示的に削除します。

削除の網羅は、次のテストで確認します。

> 削除の完了後に、`game_id` 列を持つ**すべての表**に、そのゲームの行が残らない（表の一覧は、`information_schema` から取得して検査する）。

### 保持削除の流れ

```plantuml
@startuml
title 保持削除（プロセスマネージャー）
participant "スケジューラ\n（5 分ごと）" as SCH
participant "RetentionSaga\n（decide / evolve）" as RS
database "PostgreSQL" as DB

SCH -> DB : retention_policies から delete_after <= now を検出\n（deletion_runs が無い、または再試行の時刻）
SCH -> RS : StartDeletion(gameId)
RS --> SCH : DeletionStarted
SCH -> DB : BEGIN
SCH -> DB : DELETE FROM game_roots WHERE game_id = $1\n（events・投影・周辺ストア・冪等記録が連鎖して消える）
SCH -> DB : DELETE FROM deletion_runs / deletion_attempts WHERE game_id = $1
SCH -> DB : INSERT INTO deletion_receipts（ゲーム ID のダイジェストだけ）
SCH -> DB : COMMIT
alt 失敗
  SCH -> RS : RecordFailure(code, now)
  RS --> SCH : DeletionFailed（次の試行の時刻。最大 5 回、指数バックオフ）
  SCH -> DB : deletion_runs / deletion_attempts を更新
end
@enduml
```

`deletion_receipts` は、ゲームの ID を含みません（`game_reference_digest` は、鍵付き HMAC のダイジェスト）。バックアップに削除前のデータが残る期間は、保持方針に明記します（AC5.1.5。[運用要件](./operation.md)）。

### テーブル定義（保持と削除）

| テーブル | 主キー | 主な制約 | 役割 |
| :--- | :--- | :--- | :--- |
| `retention_policies` | `game_id` | `game_roots` への外部キー（`CASCADE`）。`delete_after > retention_starts_at` | 保持方針（`GameCreated` の投影）。期限で索引を持つ |
| `deletion_runs` | `deletion_id` | `game_id` 一意（外部キーなし）。`status` は `PENDING`・`IN_PROGRESS`・`FAILED`・`COMPLETED` | 削除の進行。完了のトランザクションで行を削除 |
| `deletion_attempts` | `(deletion_id, attempt)` | `deletion_id` は外部キー | 試行履歴。完了のトランザクションで削除 |
| `deletion_receipts` | `deletion_id` | `game_reference_digest` は 64 文字。`expires_at > recorded_at` | 削除の証跡。1 年後に削除 |

## テーブル定義（イベントストアと横断）

| テーブル | 主キー | 主な制約 | 役割 |
| :--- | :--- | :--- | :--- |
| `game_roots` | `game_id` | — | 連鎖削除の根。`GameCreated` と同じトランザクションで挿入 |
| `events` | `event_id` | `game_id` は外部キー（`CASCADE`）。`stream_type` は `GAME`・`SESSION`。**`(game_id, stream_type, stream_version)` 一意（制約名 `uq_events_stream_version`）**。`stream_version >= 1`。`schema_version >= 1` | 追記専用の状態の正本。監査の記録を兼ねる（操作者の種別と ID、入力値を含む。表示名と資格は含まない） |
| `projection_checkpoints` | `(game_id, stream_type)` | `game_id` は外部キー（`CASCADE`） | 投影が適用した最後の版 |
| `idempotency_records` | `(game_id, scope, key_digest)`（制約名 `pk_idempotency_records`） | `game_id` は外部キー（`CASCADE`）。応答は暗号化。`expires_at` は 24 時間後。`scope = 'create'` の部分一意索引 `uq_idempotency_create` | 冪等キーと**成功した応答だけ**の保存 |

## マイグレーション

- スキーマの変更は、**番号つきの SQL マイグレーション**で行い、適用の履歴を DB に残します。管理ツールは [技術スタック](./tech-stack.md) で決めます。
- 変更は、**拡張 → 互換 → 縮小**の順に分け、ロールバックできる単位にします（NFR-12）。
- **イベントは、マイグレーションで書き換えません。** イベントの形の変更は `schema_version` とアップキャストで吸収します。投影の形の変更は、マイグレーションで表を直し、**再構築**で埋めます。

| 番号（予定） | 内容 |
| :--- | :--- |
| 001 | `game_roots`、`events`（一意制約、`CHECK`、追記専用のロール権限）、`projection_checkpoints` |
| 002 | 周辺ストア: `display_profiles`、`credentials`、`browser_sessions`、`idempotency_records` |
| 003 | 投影（準備）: `game_overview`、`game_settings`、`lobby_*` |
| 004 | 投影（進行）: `session_overview`、`role_current_states`、`current_decisions` |
| 005 | 投影（結果）: `week_commits`、`week_role_results`、`week_team_totals` |
| 006 | 保持: `retention_policies`、`deletion_runs`、`deletion_attempts`、`deletion_receipts` |

追記専用の保護（`events` への UPDATE/DELETE の禁止）、投影の `CHECK`（数量の上限）、観察者向けの権限は、001〜005 に含めます。

## インデックス（主なもの）

| 表 | 索引 | 目的 |
| :--- | :--- | :--- |
| `events` | `(game_id, stream_type, stream_version)`（一意） | ストリームの読み込み、楽観的並行制御 |
| `events` | `(seq)`（一意） | 監査と購読者の取り込み順 |
| `events` | `(game_id, actor_kind, actor_id)` | 操作者ごとの監査の検索 |
| `game_overview` | `(join_code)`（一意） | 参加コードでの検索 |
| `credentials` | `(game_id, kind, subject_id)`、`(expires_at)` | 主体ごとの検索、期限切れの掃除 |
| `browser_sessions` | `(game_id, expires_at)` | 期限切れの掃除 |
| `lobby_participants` | `(game_id)` | ロビーの一覧 |
| `idempotency_records` | `(expires_at)`、`(scope, key_digest)`（部分一意、`WHERE scope = 'create'`） | 期限切れの掃除、作成の再送の検索 |
| `retention_policies` | `(delete_after, game_id)` | 期限到来の検出 |
| `deletion_runs` | 再試行の予定（`next_attempt_at`）の部分索引 | 再試行 |

投影の主キー（`(game_id, week, role)` など）が、振り返りと出力の問い合わせ（`WHERE game_id = $1 ORDER BY week, role`）の索引を兼ねます。

## 設計判断のまとめ

| # | 判断 | 採用 | 主な代替案 |
| :--- | :--- | :--- | :--- |
| 1 | ストリームの単位 | 1 ゲームにつき `GAME`・`SESSION` の 2 本（ドメインモデル D1） | 1 本、役割ごと |
| 2 | 並行制御 | 版の一意制約 + 自動再試行（ロックなし） | `SELECT ... FOR UPDATE`（beer-game2）、アドバイザリロック |
| 3 | スナップショット | なし。実測で必要になれば導入 | 確定ごとのスナップショット |
| 4 | 投影の更新 | 同期（追記と同じトランザクション） | 非同期ワーカー + チェックポイント |
| 5 | 観察の合計 | `week_team_totals` を別の投影に | `SUM` を毎回計算（beer-game2） |
| 6 | 個人情報と秘密 | 周辺ストア（イベントに入れない） | 暗号化してイベントに含める |
| 7 | 保持削除 | `game_roots` の連鎖削除 + 状態の行 | 表ごとの削除、`retention` ストリーム |
| 8 | 冪等性 | 冪等記録（24 時間、成功した応答だけを暗号化して保存）を追記と同じトランザクションで。認可の後に照合 | `command_id` の一意制約だけ（資格の再返却ができない） |
| 9 | 出力 | 問い合わせ時に純粋関数 `buildExport` で作る（`export_packages` 廃止） | 同期投影、`SessionEnded` 後の非同期投影 |

## beer-game2 からの変更

| # | beer-game2 | beer-game-kotlin | 理由 |
| :--- | :--- | :--- | :--- |
| 1 | `games`、`sessions`、`role_decisions` が現在の状態（版つき更新） | `events` が正本。`game_overview`、`session_overview`、`current_decisions` などは投影 | ES + CQRS |
| 2 | 楽観的排他は `WHERE version = $expected`、行数 0 で競合 | 追記の一意制約違反を競合とし、自動再試行 | ロックなしの並行制御 |
| 3 | `events` に `aggregate_type`、`aggregate_version`、`published_at` | `stream_type`、`stream_version`、`seq`、`command_id`。`published_at` を廃止 | 状態の正本。通知は再送不要 |
| 4 | `games` が連鎖削除の根 | `game_roots` を根に独立 | `games` が投影になるため |
| 5 | `participants`（表示名・復帰資格・役割の列） | `lobby_participants`（役割）、`display_profiles`（表示名）、`credentials`（資格）に分割 | NF-S14。イベントに入れない |
| 6 | `observers`、`observer_invitations`（資格を含む） | `lobby_observers`、`lobby_observer_invitations`（投影）、`display_profiles`、`credentials` | 同上 |
| 7 | `games` に設定のすべてと進行役の資格 | `game_overview`（公開してよい項目）、`game_settings`（需要系列など、進行役向け）、`credentials`（進行役の資格） | 開示の分離（将来の需要） |
| 8 | `week_results`（確定の記録）、`week_role_results` | `week_commits`、`week_role_results`（投影）。`session_version` の代わりに `stream_version` | ES |
| 9 | 観察は `SUM` で計算 | `week_team_totals`（投影）。権限で役割別の行から分離 | 最小権限（BR-17） |
| 10 | `sessions.settings`、`sessions.role_states`（JSONB） | `SessionStarted` のイベントと `role_current_states`（行） | 設定の写しはイベントが持つ。現在の役割状態は投影 |
| 11 | `export_packages`（`PENDING`・`COMPLETE`・`FAILED`） | 表を廃止。問い合わせ時に全域の純粋関数 `buildExport` で作る | 最終週の確定を出力の作成から切り離す。途中状態が無い |
| 12 | 保持の `deletion_runs` は完了後も行が残る（`game_id` つき） | 完了のトランザクションで `deletion_runs`・`deletion_attempts` も削除 | 削除後にゲーム ID を含む行を残さない（AC5.1.4） |
| 13 | `retention_policies` は `games` を参照しない | `game_roots` への外部キー（連鎖削除）。証跡は `deletion_receipts` に限る | 投影として一緒に消す |
| 14 | 復元は DB のバックアップ | 同じ + イベントの再生で状態と投影を再構築できる（FR-12） | ES の利点 |
| 15 | 冪等記録の照合順と保存対象の規定なし | 認証 → 認可の前提検査 → 冪等記録の照合。`request_digest` に操作者 ID を含め、成功した応答だけを保存 | 失効した資格の再送で保存済みの応答を返さない |
| 16 | 一意制約の名前の規定なし | `uq_events_stream_version`、`uq_idempotency_create`、`pk_idempotency_records` を正本の表で定め、衝突の扱いを決める | 同時の重複を 500 にしない |

## 未決事項

- マイグレーションの管理ツールと適用の自動化（[技術スタック](./tech-stack.md) で決める）。
- 追記の `ConcurrencyConflict` の自動再試行の上限と、再試行の間隔（実装開始時に、競合の頻度を測って決める）。
- `events` に UPDATE/DELETE を与えないロールでも、`game_roots` の連鎖削除が動くことの確認。動かない場合の代替（`SECURITY DEFINER` の関数、削除用のロール）。
- 投影の再構築の同時実行制御（そのゲームの追記を止めるか、アドバイザリロックを取るか）。
- 数量の上限を、`CHECK`（固定値）にするか、設定の値と照合する検査にするか（beer-game2 から継続）。
- `retention_starts_at` の起点（作成時か、終了時か。ドメインモデルの未決事項と共通）。
- 出力（`buildExport`）の結果が大きい、または要求が多い場合のキャッシュの要否（解決済み: 表 `export_packages` は廃止し、要求時に作る。キャッシュは実測で必要になれば検討）。
- `events` の長期の保持と、ゲーム削除前の分析の要否（beer-game2 から継続）。
- 同期投影のトランザクション時間の実測。書き込みを圧迫する場合は、非同期投影へ移す（設計判断 4）。
- JSON のシリアライズ方式と、アップキャストの実装の置き場所（[バックエンドアーキテクチャ](./architecture-backend.md) と [技術スタック](./tech-stack.md) で決める）。

## 出典

- [ドメインモデル設計（Kotlin 版）](./domain-model.md)
- [ガイド 関数型プログラミング（Kotlin 編）](../../reference/関数型プログラミングガイド_Kotlin編.md) 第 7 章（イベントソーシング、CQRS、永続化とトランザクション境界）
- [beer-game2 データモデル設計](../beer-game2/data-model.md)、[要件定義](../../requirements/beer-game2/requirements_definition.md)
- [ADR-005](../../adr/beer-game2/005-role-results-and-sql-read-models.md)、[ADR-007](../../adr/beer-game2/007-cascade-deletion-without-queues.md)、[ADR-008](../../adr/beer-game2/008-auto-commit-and-event-audit.md)、[ADR-009](../../adr/beer-game2/009-credential-key-versions.md)
