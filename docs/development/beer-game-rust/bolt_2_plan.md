---
type: Plan
title: "Bolt 2 計画 - 縦の最小（ウォーキングスケルトン、Rust 版）"
description: "beer-game-rust の Bolt 2 のステップ計画。イベントストア・execute・axum・投影・共有する features の許可リスト・DB を要する前提の検証・NF-P2 の実測。着手前に人の判断が要る項目を含む。人の承認待ち。"
tags: [plan]
status: draft
generated: { by: claude-code/claude-sonnet-5-5, at: 2026-11-21T04:14:03Z }
---

# Bolt 2 計画 - 縦の最小（ウォーキングスケルトン、Rust 版）

## 概要

| 項目 | 内容 |
| :--- | :--- |
| Bolt | B2（[リリース計画](./release_plan.md)）。Unit U1 |
| 所要（計画） | 4 稼働日（仮定。B1 の実績の人の検証時間は未計測） |
| ゲート密度 | **密**（ステップごとに人が検証） |
| アプローチ | **アウトサイドイン**（[開発戦略](./development_strategy.md) の序盤）。共有する日本語 Gherkin の許可リスト → API の契約 → 内側へ一段ずつ |
| 準拠するガイド | [関数型プログラミングガイド（Rust 編）](../../reference/関数型プログラミングガイド_Rust編.md)（第 4・5・7 章: 副作用の境界、async、キャンセル、ポートとトランザクション境界） |
| 状態 | **着手前の判断項目 1〜8 は 2026-11-21 にユーザーが「案どおり」承認した**（9 は超過時の扱い）。計画全体の `verified` は未記録。Step ごとのゲートは人の検証待ち |

### ゴール

**作成 → 参加 → 割り当て → 開始 → 入力 → 確定 → 状態の表示**を、実 PostgreSQL 18 に対して、axum の HTTP で縦に通す。構造化ログ、`/health`、`/ready`、イベントストアと同期投影、`execute`（RB2）を含む。入口は、共有する `features/` の**許可リスト**（`@api`）と `contracts/openapi.yaml`（共有。変更しない）。**DB を要する前提と NF-P2 を実測して記録する。**

### 確認したい仮説

1. **RB2**: `execute` を `tokio::spawn` で実行し、失敗の経路で ROLLBACK を明示し、`Tx` の drop を保険にする設計は成り立つか。sqlx の drop での ROLLBACK はいつ送られるか（測定して記録）。
2. sqlx のエラーから制約名（`uq_events_stream_version`）を取り出して `ConcurrencyConflict` に写せるか。実際の並行（複数タスク）で、一方だけが成功するか。
3. testcontainers で `postgres:18.6` を固定して起動できるか。`CI` 環境変数があり Docker が無いとき失敗にできるか。DB の分離（テンプレート DB）は成り立つか。
4. 共有する `web/` と `features/`（`@ui`）は、Rust のバックエンドで動くか（RF2）。**B2 では `@api` の許可リストまでを範囲とし、`@ui` は Rust のバックエンドに向けて起動できることの確認にとどめる。**
5. **NF-P2**（確定から他の参加者の画面への反映）は、3 秒のポーリングで何秒か。方式（SSE／間隔の短縮／目標の再定義）は、**測ってから人が決める**。

### 対象の受入条件

B1 のドメインの範囲に、HTTP・永続化・認証を加えたもの（共有する `features/` の許可リストに載せる代表シナリオ）。

| ストーリー | 受入条件 | 備考 |
| :--- | :--- | :--- |
| US1.1 | AC1.1.1、AC1.1.2 | キット準拠の作成。誤りは項目ごとに集めて返す |
| US1.2 | AC1.2.1〜AC1.2.3、AC1.2.5 | 参加コードでの参加、受付終了、開始条件 |
| US2.1 | AC2.1.1〜AC2.1.3 | 役割別の状況。他役割・将来需要は開示しない |
| US2.2 | AC2.2.1、AC2.2.2 | 数量の保存と検証 |
| US2.3 | AC2.3.1〜AC2.3.5 | 手動の確定、一回性、原子性、決定論、役割別の週結果 |
| US6.1 | AC6.1.1、AC6.1.2、AC6.1.4 | 構造化ログ、エラーの記録、`/ready` |

### 範囲外

共同担当・復帰・失効・代理入力・停止（B6 以降）、カスタム条件、自動確定、観察者、出力、削除、再構築。規約検査の CI の完成・hook（B3）。コンテナ（B4）。振り返り（B5）。

---

## 人の判断が要る項目（着手前の承認）

| # | 項目 | 案 | 備考 |
| :--- | :--- | :--- | :--- |
| 1 | **新規依存関係**（クレート） | **実行時**: `tokio` 1.54.1（`rt-multi-thread`・`macros`・`signal`・`time`）、`axum` 0.8.9、`tower` 0.5.3、`tower-http` 0.7.1（トレース・リクエスト ID・タイムアウト・ヘッダー。使う機能だけ）、`sqlx` 0.9.1（`postgres`・`runtime-tokio`・`migrate`・`json`・`uuid`・`time`）、`serde` 1.0.229、`serde_json` 1.0.154、`uuid` 1.29.3、`time` 0.3.55、`tracing` 0.1.44、`tracing-subscriber` 0.3.23（JSON）、`sha2` 0.11.1・`hmac` 0.13.0・`rand` 0.10.4・`base64` 0.23.1（資格のダイジェストと乱数）、`thiserror` 2.0.21（アプリ・アダプターのエラー）。**開発時**: `testcontainers` 0.28.0・`testcontainers-modules` 0.15.0、`http-body-util` 0.1.5（axum のルーターを直接呼ぶテスト）。**契約テストの道具（`jsonschema` ほか）は B3** | 版は技術スタックの確認値（2026-11-19）。**導入の直前に再確認**。新規クレートの導入は、`cargo deny` の検査を通す。**domain の依存は変えない（DS-4）**。Rust 1.97.1 の MSRV を確認 |
| 2 | **データベースのスキーマ** | Kotlin 版のマイグレーション（共通 V001〜V008、postgres 固有 V101〜V103）を**参考に**、Rust 版（`sqlx` の migrate）で、B2 に必要な 001〜005 相当（`game_roots`・`events`・`projection_checkpoints`、周辺ストア、投影）を**新規に作る**。設計は [データモデル](../../design/beer-game-rust/data-model.md)。006 以降（保持など）は後の Bolt | **データベースのスキーマ変更は確認必須**。DDL を作る前に、データモデルの該当部との差を一覧にして人が検証する（Step 3 のゲート） |
| 3 | **クレートの追加** | `application`・`adapter-http`・`adapter-persistence`・`app` | 構造は [バックエンドアーキテクチャ](../../design/beer-game-rust/architecture-backend.md) のとおり。domain は依存方向を変えない |
| 4 | **ローカルの DB** | **PostgreSQL 18（Docker）**（承認済み）。Docker の起動は人が行う | testcontainers が使う。ローカルの手動起動用の `compose.yaml` の要否は B2 で判断 |
| 5 | **共有物の変更** | **変更しない**（`contracts/openapi.yaml`・`features/`・`web/`）。差異（契約の逸脱）が見つかったら、**Rust のバックエンドで直す**（RU2）。**RF3（`web/support/hooks.mjs` の編集）は B2 では行わない**（`@ui` の Rust 向けの起動は別の方法を提案して、再度確認） | Kotlin 版に影響するため |
| 6 | **認証と資格（ADR-015・016・020 の引き継ぎ）** | B2 は **B1 相当の最小**: 作成時に進行役の資格、参加時に参加者の復帰資格を発行し、Cookie（`HttpOnly`・`Secure`・`SameSite=Strict`）で送る。**期限・失効・再発行・復帰・鍵の版は B6**。資格のダイジェストの方式（HMAC-SHA256 ほか）は Kotlin 版の設計を引き継ぐ | **認証・認可の実装は確認必須**。資格の設計の差分（Rust 版で変える点）があれば先に提示 |
| 7 | **許可リスト** | B2 の許可リストは、ウォーキングスケルトン（US1.1・1.2・2.1〜2.3）の `@api` 代表シナリオ。**対象のファイルとシナリオ ID の一覧を Step 1 で提示し、人が合意する** | 共有する `.feature` に Rust 専用のタグを書かない |
| 8 | **RT1 の区切りと暫定の緩和**（B1 の申し送り） | `__` を続けるか単一の `_` にするか。cargo-deny の暫定の許可（`RUSTSEC-2026-0542`、`BlueOak-1.0.0`）の承認 | [Bolt 1 終了報告](./bolt_1_report.md) |
| 9 | **所要が 4 日を超える場合** | Step が 10 あり、4 日では厳しい見込み | `@ui` の起動確認を後ろへ回す。それでも超える場合は予備 B17 で吸収し、リリース計画を再調整（人が判断） |

---

## ステップ計画

記号: 🔵 土台・検証、🔴 Red、🟢 Green、🟡 Refactor、✅ 検証。各ステップの終わりが**承認ゲート**。1 ステップ 1 コミット（構造と動作を分ける）。

### Step 1: 入口の合意（🔵🔴）

- 共有する `features/` から、許可リストの対象を選び、**対象のファイルとシナリオ ID の一覧**を提示して、人が合意する。許可リストは Rust 側のファイルで管理（共有物に書き込まない）。
- `crates/acceptance` の許可リスト方式（未許可は「未対応」として一覧に出す。許可したものに Undefined・Pending があれば失敗）。まず Red（ステップ定義が無い）。
- `contracts/openapi.yaml` の該当経路（`/games`、`/participations/join`、`/games/{id}/participants/{id}/role`、`/games/{id}/start`、`/sessions/{id}/decisions`、`/sessions/{id}/weeks/{week}/commit`、`/sessions/{id}/state`、`/games/{id}/state`、`/games/{id}/lobby`、`/health`、`/ready`）を読み、Rust 側の型との差を一覧にする（変更しない）。

### Step 2: クレートの土台と `execute` のポート（🔵🔴🟢）

- `application`・`adapter-http`・`adapter-persistence`・`app` を追加（依存方向の検査 DS-4 を拡張: application は sqlx・axum に依存しない）。
- ポート（トレイト。`impl Future + Send`）: `EventStore`、`Tx`、`Projection`、`Clock`、`Ids`、`Credentials`。**メモリ実装**で、`execute` の振る舞い（成功は commit だけ、競合ごとに rollback して再試行、上限で枯渇、業務失敗は rollback。スケッチ済みの 4 件）をテスト（Given/When/Then）。

### Step 3: マイグレーションとイベントストア（🔴🟢）— **ゲート: DDL の検証**

- 判断項目 2 の差の一覧 → 人が検証 → `sqlx` の migrate で 001〜005 相当。
- `PgEventStore`（追記専用、`uq_events_stream_version`、`game_roots`、部分一意索引）。testcontainers の `postgres:18.6`。
- **DB を要する前提の検証**: ①`Tx` の drop での ROLLBACK のタイミング（RT2）、②制約名の取得と実際の並行、③`CI` で Docker が無いとき失敗、④テンプレート DB による分離。**成立・不成立を記録**。

### Step 4: 投影と周辺ストア（🔴🟢）

- 同期投影（ロビー、進行、結果）。資格・表示名・冪等記録の周辺ストア。

### Step 5: アプリケーション（🔴🟢🟡）

- ユースケース 6 つ（`create_game`・`join_game`・`assign_role`・`start_game`・`save_decision`・`commit_week`）。順序は「認証 → 認可の前提検査 → 冪等記録の照合 → 読み込み → `decide` → 追記・投影」（認可を冪等記録の照合より先に）。`spawn` とキャンセル安全性（RT2）。

### Step 6: HTTP と観測性（🔴🟢）

- axum のルーター、problem+json、`code` の写像（`match` の網羅）、Cookie、`/health`・`/ready`、構造化ログ（相関 ID。資格・表示名を含めない）、タイムアウトは `type` なしの 504、プール取得の失敗は 503。**ルーターを直接呼ぶ統合テスト**。

### Step 7: 受け入れの green（🟢）

- 許可リストのシナリオが、実 PostgreSQL に対して green（Undefined・Pending 0）。**Rust の起動（`app`）、SIGTERM は B4**。

### Step 8: NF-P2 の実測（🔵）

- 確定から、別の参加者の状態の取得に反映されるまでの時間を、3 秒のポーリングを想定して**測って記録**する（方式は決めない）。

### Step 9: `@ui` の起動確認（🔵）

- 共有する `web/` を、Rust のバックエンドに向けて起動できるか（RF2）。**`web/` は変更しない。** 起動の方法が共有物の変更を要するなら、提案して人の判断を待つ（RF3）。

### Step 10: 検証と終了（✅）

- 品質チェック一式。`validating-design`。設計書の変更が要る点を列挙（人が判断）。`bolt_2_report.md`。ゲート: Bolt の承認。

---

## Step 1 の結果（ゲート: 許可リストの合意待ち）

実施済み（2026-11-21、AI）。**人の合意は未取得**。

- **許可リストの仕組み**: `crates/acceptance/allowlist.txt`（Rust 側のファイル。共有する `.feature` は変更しない）。許可したファイルだけを、`target/acceptance-features/` に**読み取り専用のシンボリックリンク**で並べて実行する。許可の外の `@api` は「未対応」として件数を表示（現在: `@api` 159 件のうち、実行 4 件、未対応 155 件）。許可したシナリオに Undefined・Pending があれば失敗（`fail_on_skipped`）。
- **発見**: Rust の `gherkin`（0.16）は、日本語の **`ルール:`**（`operations/metrics-and-alarms.feature`、B14 の範囲）を解析できず、**ディレクトリ全体を渡すと実行が止まる**（"1 parsing error"）。許可したファイルだけを渡すことで回避した。**B14 でこのファイルを許可するときは、対処が要る**（共有物の変更は不可のため、Rust 側の回避を検討し、人に提示）。
- **B2 の許可リストの提案（20 シナリオ。`@api` のみ）**。いずれも `allowlist.txt` には**まだ入れていない**（ステップ定義ができた Step 7 で、green になったものから入れる）:
  - `game-setup/game-creation.feature`（2）: 作成、無効な需要系列
  - `game-setup/joining.feature`（5）: 参加、無効なコード、受付終了、不足の役割を示す開始の拒否、付け替え
  - `weekly-play/situation.feature`（4）: 役割ごとの開示
  - `weekly-play/decision.feature`（3）
  - `weekly-play/week-commit.feature`（6）: 確定、冪等、一回性、決定論、結果の項目、入力不足
  - **除外**: 共同担当（`co-assignment`・`co-input`）、復帰・失効（`continuation`）、カスタム条件、自動確定、観察、出力、保持。B1 で書いた `co-assignment`（ドメインに対して実行）は、B2 の HTTP 化に合わせて、B6 まで許可リストから外す予定。
- **契約（`openapi.yaml`）との差の一覧**: Step 6（HTTP）の着手時に、各経路のリクエスト・レスポンスの項目を、Rust 側の型と突き合わせて一覧にする（変更しない。差は Rust で直す。RU2）。

---

## Step 2・3 の結果（ゲート: 人の検証待ち）

実施済み（2026-11-21、AI）。**人のゲートは未承認**。

- **Step 2（`application` クレート）**: ポート（`EventStore`、`AppFailure`、`StreamRead`）と `execute`（読む → 再生 → decide → 追記）。メモリ実装で 6 件（成功は commit だけ / 競合ごとに rollback して再試行 / 上限で `RetryExhausted` / 業務の失敗は rollback / 空の列は追記しない / 再生で `Ignored` なら fail closed）。依存方向の検査（DS-4）を application に広げた（sqlx・axum などに依存しない）。
- **Step 3（`adapter-persistence`、0001 のみ）**: マイグレーション 0001（設計書の検証済みの DDL）と `PgEventStore`（sqlx 0.9.1）。実 PostgreSQL 18.6（testcontainers）の測定結果（**RB2 の前提**）:

| 前提 | 結果 |
| :--- | :--- |
| 制約名（`uq_events_stream_version`）の取得 | **成立**。`sqlx::Error::Database` の `code() == "23505"` と `constraint()` で判別できた |
| 実際の並行（2 タスク、同じ版へ追記） | **成立**。一方だけが成功し、他方は `ConcurrencyConflict` |
| 明示の `rollback` の後、同じ版への追記 | **成立**。約 7 ms で通る（ロック残りなし） |
| **`Tx` の drop（rollback なし）の後、同じ版への追記** | **成立（保険として有効）**。約 8 ms で通った（sqlx 0.9.1 は drop で ROLLBACK を送る）。ただし測定は 1 回・ローカル。負荷時の遅れは B3 以降で追う |
| `postgres:18.6` のタグ固定 | **成立**（`SHOW server_version` が 18.6） |
| Docker が無いとき | `CI` があれば失敗、無ければスキップ（DS-13 の入口。**実行件数が 0 なら失敗にする検査は B3**） |
| テンプレート DB による分離 | **未確認**（テストごとに別コンテナ。約 22 秒/5 テスト。B3 で方式を決める） |

- **発見（技術スタックの食い違い）**: `testcontainers-modules` 0.15.0 は `testcontainers` ^0.27 を要し、技術スタックの組（`testcontainers` 0.28.0 と `testcontainers-modules` 0.15.0）は**同時に解決できない**。`testcontainers` 0.28.0 の `GenericImage` だけで足りたため、**`testcontainers-modules` は導入しない**（依存が 1 つ減る）。設計書（tech-stack）の更新が要る。
- **発見（ライセンス・勧告）**: 新規依存で、ISC・BSD-3-Clause・Zlib のライセンスと、`astral-tokio-tar`（testcontainers の依存）の非メンテナンスの勧告（RUSTSEC-2026-0440）が出た。`deny.toml` に**暫定の許可・無視**を入れた（承認待ち。B1 の 2 件と同じ扱い）。

### ゲート: DDL（0002〜0005）の検証 — **着手前の承認が要る**

0001 は設計書の検証済みの DDL で作成済み。0002〜0005 は、Kotlin 版の `V002`〜`V005` を元にします。**差の一覧**（人が検証してから、DDL を作る）:

| # | Kotlin 版 | Rust 版 | 理由 |
| :--- | :--- | :--- | :--- |
| 1 | `${json_type}`（H2 と PostgreSQL の切り替え） | `jsonb` | H2 を使わない |
| 2 | `timestamp with time zone` | `timestamptz` | 同じ型の別名。0001 と揃える |
| 3 | 共通（V002〜V005）と PostgreSQL 固有（V101）の 2 系統 | **1 系統**。V101 の部分一意索引 `uq_idempotency_create` は 0002 に含める | 方言がない |
| 4 | 表: `display_profiles`・`credentials`・`browser_sessions`・`idempotency_records`（V002）、`game_overview`・`game_join_codes`・`game_settings`・`lobby_participants`・`lobby_observer_invitations`・`lobby_observers`（V003）、`session_overview`・`role_current_states`・`current_decisions`（V004）、`week_commits`・`week_role_results`・`week_team_totals`（V005） | **同じ 15 表・同じ列・同じ制約名** | API・投影の契約を保つ |
| 5 | V006（保持）・V007（`lobby_participants.replaced_at`）・V008（`participation_attempts`） | **B2 では作らない**（B6・B12 の範囲） | B2 の範囲外 |
| 6 | V102・V103（ロールと GRANT） | **B3 で作る**（追記専用権限の否定テストと同時） | 表より後ろの番号に置く（既定の権限は与えない） |
| 7 | 番号 `V002`〜`V005` | `0002`〜`0005`（sqlx の `<番号>_<名前>.sql`） | sqlx の命名 |

承認をお願いします（差の一覧どおりに DDL を作ってよいか）。

---

## 完了条件（Definition of Done）

- [ ] 判断項目 1〜8 が承認され、版が出典つきで記録されている
- [ ] 許可リストのシナリオが、実 PostgreSQL で green（Undefined・Pending 0）。許可リストの外は「未対応」の一覧
- [ ] `execute` の 4 つの振る舞い（メモリ実装）と、RB2 の検証（drop・ROLLBACK のタイミング、制約名、並行、Docker なしで CI が失敗）が記録されている
- [ ] 認可は冪等記録の照合より先。失効した資格の再送の否定は B6 だが、**認可が先**であることをテストで固定
- [ ] ログに資格・表示名を含まない（テスト）。`/ready` が DB 未接続で 503
- [ ] NF-P2 の実測値が記録され、方式の判断が人に渡されている
- [ ] 品質チェック一式が CI で緑（DS-1〜6・14 を維持）。`domain` の行 100%
- [ ] 設計書・ADR が実装と一致（差は列挙して人が判断）

### デモ項目

1. 作成 → 参加 → 割り当て → 開始 → 入力 → 確定 → 状態の表示が、HTTP で通る（許可リストのシナリオ）。
2. 同時の保存・確定で、一方だけが成功する。
3. `/ready` が DB を止めると 503、再開で 200。

## リスクと対策

| リスク | 対策 |
| :--- | :--- |
| sqlx の drop での ROLLBACK が想定と異なる | 明示の ROLLBACK を唯一の手段にする（RB2 の見直し）。人に提示 |
| 認証・資格の設計が大きい | B2 は最小。残りは B6 |
| 共有物の変更が要る | 変更しない。提案して確認（R5） |
| 新規依存のビルド時間・`cargo deny` の指摘 | 導入のたびに deny を通す。指摘は人に提示 |
| 4 日を超える | 判断項目 9 |

---

## 更新履歴

| 日付 | 更新内容 | 更新者 |
| :--- | :--- | :--- |
| 2026-11-21 | 初版作成（人の承認待ち） | claude-code |
