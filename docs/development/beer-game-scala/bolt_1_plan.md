---
type: Plan
title: "Bolt 1 計画 - 基盤・静的解析・縦の最小（ウォーキングスケルトン、Scala 版）"
description: "beer-game-scala の Bolt 1 のステップ計画（草案）。ゴール、仮説、対象の受入条件、着手前に人の判断が要る項目、TDD のステップと承認ゲート、完了条件。人の承認待ち。"
tags: [plan]
status: draft
generated: { by: claude-code/claude-sonnet-5-5, at: 2026-11-26T00:00:00Z }
---

# Bolt 1 計画 - 基盤・静的解析・縦の最小（ウォーキングスケルトン、Scala 版）

## 概要

| 項目 | 内容 |
| :--- | :--- |
| Bolt | B1（[リリース計画](./release_plan.md)） |
| Unit | U1 ウォーキングスケルトン（前半） |
| 所要（計画） | 2.5 稼働日（仮定。人の検証時間を含む。初期の見積もりは 5 日） |
| ゲート密度 | **密**（ステップごとに、人が検証する） |
| アプローチ | アウトサイドイン（[開発戦略](./development_strategy.md) の序盤）。**受け入れのシナリオと API の仕様が先** |
| テスト戦略 | Comprehensive（`simulateWeek`、集約、イベントストア）、Standard（その他） |
| 状態 | **計画は草案のまま、人の承認なし。** 2026-11-26 にユーザーが `/goal orchestrating-development U1` を指示したため、AI が B1 を自律実行中（**`/goal` の指示は、各ゲート・依存関係・マイグレーションの承認の記録ではない。実施した未承認の判断は、終了報告に列挙する**）。実施済み: Step 1（実測。結果は下記）、Step 2（土台と静的解析。`apps/beer-game-scala/scripts/check.sh` が緑）、Step 4（値と週次計算。domain 23 件・行率ツール 10 件が緑）。**未着手: Step 3 の AC 一覧・許可リスト・cucumber の入口、Step 5〜12。** 各ゲート 1〜12 は未承認 |

> **承認の状態について**: リリース計画・開発戦略・本書は、いずれも AI の草案で、ユーザーの承認を得ていません。承認の記録は、ユーザーが指示した範囲だけを追記します。

### ゴール

ゲームを、**作成 → 参加 → 役割の割り当て → 開始 → 入力 → 確定 → 状態の表示**まで、**ローカル（H2）と PostgreSQL（Testcontainers）の両方**で、構造化ログ・`/ready`・層の依存の検査・役割別の週結果の保存つきで、縦に通す。入口は、このウォーキングスケルトンの**日本語 Gherkin のシナリオ**と、`apps/beer-game-contracts/openapi.yaml` の仕様（**仕様が先**）にする。**静的解析は最初のコードより前に設定し**、以降は違反 0 件・ベースラインなしで書く（[開発戦略](./development_strategy.md) の「静的解析とルール設定」）。

### 確認したい仮説

1. Scala 3.7.4 と Cats Effect・doobie・http4s の組み合わせは動くか。
2. **ガイド第 9 章の静的解析の設定（Scala CLI で確認）は、sbt と使う版（Scala 3.7.4・WartRemover 3.6.3・Scalafix 0.14.10）で期待どおりに動くか。**
3. **H2 の PostgreSQL モードで、設計が使う機能のどれが動くか**（K21）。
4. インメモリの状態を `ConnectionIO` から読み書く方法は成り立つか（D4 の `ProjectionLock`）。
5. `Fiber` の取消と ROLLBACK、並行時の制約名、`lock_timeout` の写像は期待どおりか（テスト戦略の「B1 の受入条件」の表）。
6. cucumber-scala を sbt の別プロジェクト（`acceptance`）から実行し、共有の `.feature` を許可リストで絞れるか。
7. scoverage の XML から行率を算出でき、`domain` だけ別のしきい値にできるか（K16）。
8. AI の出力の質は、どの密度の承認ゲートが要るか（以降の Bolt の密度を決める）。

### 対象の受入条件

Kotlin 版の B1 と同じ範囲です（[ユーザーストーリー](../../requirements/beer-game-ts/user_story.md)）。**AC の一覧は、本 Bolt の Step 3 で U1〜U6 の分を番号まで確定し、人が承認して許可リストの入力にする**（Unit 定義に AC の番号がない項目があるため。ADR-001 の M3）。

| ストーリー | 受入条件 | 備考 |
| :--- | :--- | :--- |
| US1.1 | AC1.1.1、AC1.1.2 | キット準拠の作成。無効な需要系列は、対象週と修正内容を示す（誤りは項目ごとに集める。`ValidatedNec`） |
| US1.2 | AC1.2.1、AC1.2.2、AC1.2.3、AC1.2.5 | 1 役割 1 人（共同担当は B5）。受付終了のコードの拒否 |
| US2.1 | AC2.1.1、AC2.1.2、AC2.1.3 | 役割別の状況。他役割・将来需要は開示しない |
| US2.2 | AC2.2.1、AC2.2.2 | 数量の保存と検証（共同入力は B5） |
| US2.3 | AC2.3.1〜AC2.3.5 | 手動の確定、一回性、障害時の原子性、決定論、役割別の週結果の保存 |
| US6.1 | AC6.1.1、AC6.1.2、AC6.1.4 | 構造化ログ、エラーの記録、`/ready`（D2） |

### 範囲外（後続の Bolt）

CI の `check`・`integration`・`acceptance` の 3 ジョブ化、契約テストの CI 組み込み、追記専用権限の否定テスト、N-1 互換（B2）。停止・再開・代理入力・復帰・資格の失効（B4）。共同担当（B5）。カスタム条件（B6）。自動確定（B7）。振り返り（B8）以降。**ローカルでは B1 の検査を、CI では B2 で同じコマンドを載せる。**

---

## 設計の参照（B1 のスコープ）

設計は複製せず、正本を参照します。

| 内容 | 正本 |
| :--- | :--- |
| ドメイン（`Quantity`、`RoleMap`、`Game.handle`、`Events.apply`、`replay`、`simulateWeek`） | [ドメインモデル](../../design/beer-game-scala/domain-model.md) |
| イベントストア、投影、`Tx.run`、`ProjectionLock`、冪等 | [バックエンドアーキテクチャ](../../design/beer-game-scala/architecture-backend.md) |
| テーブル、DDL、ロール | [データモデル](../../design/beer-game-scala/data-model.md) |
| 画面、画面遷移、止まったゲームの文言（#15・#16） | [UI 設計](../../design/beer-game-scala/ui-design.md)、[フロントエンドアーキテクチャ](../../design/beer-game-scala/architecture-frontend.md) |
| 版、確認状況（K1〜K23） | [技術スタック](../../design/beer-game-scala/tech-stack.md) |
| B1 の受入条件の表、層ごとのルールセット、静的解析 | [テスト戦略](../../design/beer-game-scala/test-strategy.md) |

**B1 の縦の最小に含めるもの**: `game`・`session` の 2 ストリーム、`events`・`game_roots`・`idempotency_records`（Flyway V001）、`startGame` の原子的な追記、同期投影、`GameEvents.apply`（許す組の表）、`simulateWeek`、`Tx.run`、`Idempotency-Key`、http4s の最小の API、共有 `web` の接続。**含めないもの**: 資格の失効・再発行・復帰、共同担当、カスタム条件、自動確定、観察者、出力、保持と削除。

---

## 人の判断が要る項目（着手前の承認）

承認の前に、コードも `apps/beer-game-scala/` も作りません。

| # | 項目 | 内容 | 案 |
| :--- | :--- | :--- | :--- |
| 1 | リリース計画・開発戦略・本書の承認 | スコープ（U1〜U6）、Bolt の割り当て、日程の仮定、価値指標、リスク | 承認 |
| 2 | team 規約の例外の期間の再承認 | 承認済みの期間は「U1〜U3 の間」。計画は Release 1.0 までのため、期間を延ばす（SR9）。解除の条件は ADR-001 のとおり | Release 1.0 まで延ばす |
| 3 | `project.md` への記録 | 承認した例外を `## Scope Overrides` に、learnings の手続きで記録する（**AI は編集しない**。D5・SR7） | 人の承認の場で実施 |
| 4 | 依存関係の導入と版 | 下の「依存関係の一覧」。H2、doobie の RC、sbt プラグインなど。**版は導入の直前に再確認する** | 一覧のとおり承認 |
| 5 | 共有物の使い方 | `apps/beer-game-features/`・`beer-game-web`・`beer-game-contracts` を Kotlin 版・Rust 版と共有する。**共有する `.feature` に Scala 専用のタグを書かない**。Scala 側は許可リストで絞る。共有物の変更は都度確認 | 共有（複製しない） |
| 6 | AC の一覧と許可リスト | U1〜U6 の AC を番号まで確定し、許可リストの入力にする（Step 3） | Step 3 で提示して承認 |
| 7 | マイグレーション V001 | `events`・`game_roots`・`idempotency_records` の DDL（スキーマ変更は確認必須）。設計は [データモデル](../../design/beer-game-scala/data-model.md) | Step 7 の前に提示して承認 |
| 8 | NF-P2 の実測の方法 | 画面を通した実測か、GET の実測 + 3 秒間隔からの推定か（M13） | Step 12 で決めて記録 |
| 9 | ガイドの確認用コードで期待と異なった場合の代替 | B2 以降を止め、代替（技術スタックの ST4）を選ぶ | 発生時に提示 |
| 10 | カバレッジ | scoverage の XML から行 80% を算出する案 C（H6 で決定済み）。`domain` の 97% は目安で、ゲートにするかは Step 2 の実測の後に決める | Step 2 で決めて記録 |

### 依存関係の一覧（案。版は[技術スタック](../../design/beer-game-scala/tech-stack.md)の 2026-11-25 の確認値。導入の直前に再確認する）

| 区分 | 依存関係 | 版 |
| :--- | :--- | :--- |
| ビルド | Scala 3、sbt、JDK（Temurin） | 3.7.4、1.13.1、25 |
| ドメイン | cats-core | 2.13.0 |
| 効果・HTTP | cats-effect、fs2、http4s（ember、circe）、circe | 3.7.1、3.16.0、0.23.39、0.14.17 |
| 永続化 | doobie（core、postgres、hikari）、PostgreSQL JDBC、HikariCP、Flyway | 1.0.0-RC12（RC）、42.7.15、7.1.0、13.12.2 |
| ローカル DB | H2（`com.h2database:h2`。MPL 2.0・EPL 1.0） | 2.5.252 |
| ログ | log4cats-slf4j、logback-classic | 2.8.0、1.6.8 |
| テスト | munit、munit-cats-effect、munit-scalacheck、ScalaCheck、cats-laws、discipline-munit、testcontainers-scala、cucumber-scala | 1.3.6、2.2.1、1.3.1、1.20.0、2.13.0、2.0.0、0.44.1、9.3.0 |
| 静的解析・整形 | sbt-wartremover、sbt-scalafix、sbt-scalafmt（scalafmt-core）、sbt-scoverage | 3.6.3、0.14.10、2.6.2（3.11.5）、2.4.4 |

**承認の対象に注意が要るもの**: doobie は**リリース候補**（RC12）で、ガイドが記す RC13 は Maven Central に無かった。H2 の公式のサポート期限は未確認。

---

## ステップ計画

各ステップは TDD の Red・Green・Refactor で進め、**ステップごとに人が検証します（ゲート）**。🔵=調査・設定、🔴🟢🟡=Red・Green・Refactor、✅=検証。**静的解析は、Step 2 以降のすべてのコードで違反 0 件を保つ。**

### Step 0: 着手前の承認（🔵）

- 上の判断項目 1〜5 の承認を受け、記録する。
- **ゲート 0**: 承認の記録（承認した範囲だけを書く）。

### Step 1: 未確認の前提の実測（🔵。使い捨て。リポジトリの外）

テスト戦略の「B1 の受入条件」の表と、確認状況の一覧（K5・K7・K10・K11・K20・K21）の未確認の部分を、使い捨てのプロジェクトで実測し、**成立・不成立を結果の表に記録する**（確認結果を作らない）。

- **H2 の PostgreSQL モード**（K21）: アドバイザリロックの代替、`jsonb`、部分一意索引、SQLSTATE と制約名、`Left` の明示 ROLLBACK、Flyway の適用、JDK 25 との組み合わせ。Kotlin 版の実測（2026-11-14）との差を記録する。
- **`Fiber` の取消と ROLLBACK**（K7）: 失敗の経路の明示の ROLLBACK で、ロックと接続が 2 秒以内に解放される。
- **並行時の制約名**（K8）: 2 つの `Fiber` の同時の追記で、一方だけが成功し、`uq_events_stream_version` の違反が `ConcurrencyConflict` に写る。
- **`lock_timeout` と SQLSTATE の写像**（R-H6）、**H2 版 `ProjectionLock`**（D4。別スレッドでの解放、待ちの上限、COMMIT 後の解放）。
- **http4s 0.23.39**（K20）: ルート、ミドルウェア、SSE の API。
- 結果が不成立なら、**以降のステップを止め、設計の見直しを人に提示する**。
- **ゲート 1**: 実測の結果表（成立・不成立）と、不成立の項目の扱い。

#### Step 1 の実測結果（2026-11-26。AI の実施。**ゲート 1 は未承認**）

使い捨てのプロジェクト（リポジトリの外。sbt 1.13.1、JBR 25.0.4.1、Scala 3.7.4、doobie 1.0.0-RC12、H2 2.5.252、PostgreSQL 18.6（Testcontainers）で実行した。**依存関係はすべて解決し、コンパイルとテストが通った**（仮説 1: 成立）。

| 前提 | 結果 | 判定 |
| :--- | :--- | :--- |
| 並行時の制約名（K8） | 8 本の同時の追記で、成功 1・失敗 7。失敗はすべて SQLSTATE `23505` と制約名 `uq_events_stream_version` | **成立** |
| `FC.rollback` と `Left`（K5） | `Left` を返しても COMMIT される。`FC.rollback` は直前の書き込みを消し、**同じ `ConnectionIO` の以降の書き込みは新しいトランザクションとして COMMIT される**（推論が実測で確認された）。H2 でも同じ | **成立** |
| `Fiber` の取消と ROLLBACK（K7） | **実行中の SQL 文**（`pg_sleep`）を持つトランザクションの `Fiber` を取消すと、**42ms で取消が完了し、ロックは 124ms 以内に解放**された（基準は 2 秒以内）。実行中の文は残らない | **成立** |
| 取消の落とし穴 | `FC.delay` の中の **ブロッキングの `Thread.sleep` は中断できず**、取消は 29 秒かかった | **注意**: H2 版 `ProjectionLock` の待ちは、中断できる形（`interruptible`）で書く（D4。Step 7 で確認） |
| `lock_timeout` の写像（R-H6） | 排他 vs 排他、共有 vs 排他のどちらも SQLSTATE `55P03`（`set_config('lock_timeout', …, true)` で設定） | **成立**（40P01・40001 の写像は未実測） |
| アドバイザリロック（K10） | `pg_advisory_xact_lock`・`_shared` が `ConnectionIO` として実行できた | **成立**（共有と排他の相互の待ち、再構築用の排他の本実装は Step 7） |

**H2 の PostgreSQL モードの動作範囲（K21。2.5.252。`MODE=PostgreSQL;DATABASE_TO_LOWER=TRUE`）**

| 機能 | 結果 | Scala 版での扱い |
| :--- | :--- | :--- |
| 一意制約違反の SQLSTATE と制約名 | `23505`。メッセージに `uq_events_stream_version` を含む（`getServerErrorMessage` は無いため、**H2 ではメッセージから制約名を取り出す**） | H2 用の判別を別に持つ |
| `jsonb` 型、`cast(… as jsonb)`、`format json` | 動く（`bigserial`・`uuid` も動く） | そのまま |
| `timestamptz` | **キーワードが無い**（`timestamp with time zone` は動く） | DDL は `timestamp with time zone` に統一するか、H2 用の DDL を分ける |
| 部分一意索引（`where`） | **構文エラー**（42000）。生成列（`generated always as (case …)`）+ 一意制約は動く | H2 では生成列で代替（Kotlin 版と同じ方針か確認） |
| アドバイザリロック（`pg_advisory_xact_lock`） | **関数が無い**（90022） | **H2 では使えない。プロセス内のロック（D4）で代替** |
| `set_config('lock_timeout', …)` | 呼べるが、**ロック待ちの上限としては効かない**（H2 にはその機能が無い） | H2 の待ちの上限は D4 のロックの実装で持つ |
| `LISTEN`/`NOTIFY` | **構文エラー** | H2 では使わない（プロセス内の通知） |
| `CREATE ROLE … NOLOGIN` | **構文エラー**（`CREATE USER` と `GRANT` は動く） | **ロールを使う追記専用権限の否定テストは PostgreSQL だけで実行する** |
| `REVOKE`、`current_user` | 動く（H2 では権限は強制されない見込み。要確認） | 否定テストは PostgreSQL |

**Step 1 の未実測**: H2 版 `ProjectionLock` の動作（Step 7）、40P01・40001 の写像、http4s 0.23.39 のルート・ミドルウェア・SSE（Step 9）、Flyway の H2 への適用（Step 7）。

### Step 2: リポジトリの土台と静的解析（🔵）

1. `apps/beer-game-scala/` を作成する（sbt のマルチプロジェクト: `domain`・`application`・`adapterHttp`・`adapterPersistence`・`app`・`acceptance`。層の依存は `dependsOn` で守る）。
2. **使う版でガイド第 9 章の確認用コード（期待 14 件、`pureOk`・`sumOk` は報告されない）と Scalafix の確認用コード（期待 3 件）を実行**し、結果を記録する。
3. **最初のコードより前に**、scalac のオプション（`-deprecation -feature -Werror -Wunused:all -Wvalue-discard -Wnonunit-statement`）、全 Wart（13 個）、`.scalafmt.conf`、`.scalafix.conf`（`println`・時計・`Thread.sleep`・`unsafeRun*`・`.transact(` ほか）を有効にし、層ごとのルールセット（WartRemover はテストに適用しない）を分ける。
4. **ルールそのものをテストファーストで確かめる**: 違反するコードとしないコードの fixture を置き、期待件数を使う版で確かめる（`.transact(` の「落ちるべき」「落ちてはならない」の 2 方向を含む）。
5. **行率の算出スクリプトとそのテスト**（既知のフィクスチャ XML。丸め・境界値）を置く。scoverage で `domain` だけ別のしきい値を設定できるかを実測する（判断項目 10）。
6. 違反コードを 1 つ置くとローカルで失敗することを確認し、消す。
- **ゲート 2**: 確認用コードの結果、静的解析の設定の差分、fixture の期待件数、層ごとのルールセットの除外の理由。

### Step 3: 契約と受け入れの入口（🔵🔴）

1. **AC の一覧を U1〜U6 の分、番号まで確定**し、許可リストを導く（判断項目 6）。人が承認する。
2. `openapi.yaml` に、ウォーキングスケルトンの経路の API を書く（**仕様が先**。共有物の変更は Kotlin 版・Rust 版への影響を確認する）。
3. cucumber-scala を `acceptance` プロジェクトから実行し、共有の `.feature` を**許可リスト**で絞る。日本語 Gherkin のウォーキングスケルトンのシナリオを Undefined → Pending → Failing（Red）で回す。**Undefined・Pending で失敗する**ことを確認する。
- **ゲート 3**: AC の一覧と許可リスト、Gherkin のシナリオ（業務の言葉と例の妥当性）、`openapi.yaml` の差分。

### Step 4: ドメイン — 値と週次計算（🔴🟢🟡）

`Quantity`・`RoleMap`・`ValidatedNec` による設定の検証・`GameError.code`・`simulateWeek`。munit の日本語の Given/When/Then、ScalaCheck の性質、golden テスト（既知の系列）、cats-laws（`Functor[RoleMap]`・`Monoid[TeamTotals]`）。

- **ゲート 4**: テストの名前と性質、`simulateWeek` の決定論、golden の値。

### Step 5: ドメイン — Game（🔴🟢🟡）

`Game.handle`（権限が先の判定順）、`GameEvents.apply`（「許す組の表」。`case _` で許可の漏れを隠さない）、`replay`。**ScalaCheck の操作列**（表の ○ を × にすると落ちる、腕を 1 つ消すと落ちる。テスト戦略の受入条件）。

- **ゲート 5**: 許す組の表、操作列のテストが「ずらすと落ちる」こと。

### Step 6: ドメイン — Session と `startGame`（🔴🟢🟡）

Session 集約、`startGame`（2 ストリームの原子的な追記の入力）、D3 の `replacementEvents` は B4 のため範囲外。

- **ゲート 6**: 不正な遷移（`Ignored`）を止める設計、開始の原子性の単体の確認。

### Step 7: イベントストア・投影・ポート（🔴🟢🟡）

1. **マイグレーション V001 を提示して承認を受ける**（判断項目 7）。
2. `EventStore.append`（版の一意制約）、同期投影、ポート（H2 と PostgreSQL の両実装）、`ProjectionLock`（D4）、`Tx.run`（`.transact(` の唯一の入口）。
3. ポートの契約テストを**両実装**で実行する。PostgreSQL は Testcontainers（`postgres:18.6` 固定。`CI` で Docker がなければ失敗）。
- **ゲート 7**: V001、ポートの契約テストの結果（H2・PostgreSQL）、並行の追記のテスト。

### Step 8: アプリケーション（🔴🟢🟡）

コマンド処理、`Idempotency-Key` の照合（**認可の後**。B1 では認可の範囲は最小）、再試行（`RetryExhausted`）、キャンセル安全性（`Fiber` の取消、`Supervisor`）、ポートの差し替えでのテスト。

- **ゲート 8**: 再試行・冪等・キャンセル安全性のテスト。

### Step 9: HTTP と観測性（🔴🟢🟡）

http4s のルート、`problem+json`、構造化ログ（`LogRecord`・相関 ID）、`/ready`、起動時の検査。**止まったゲームの読み取り**（N-H7。`Ignored` で止まっても読み取りの 3 経路が 200）。HTTP のテスト（`HttpRoutes` を関数として呼ぶ）。

- **ゲート 9**: AC6.1.1・6.1.2・6.1.4、止まったゲームの 5 項目の確認。

### Step 10: UI（アウトサイドイン）（🔴🟢）

共有 `web` を Scala のバックエンドへ接続し、`@ui` のシナリオ（許可リストの範囲）を実行する。画面の変更は最小にする。

- **ゲート 10**: `@ui` の結果、共有物の差分（Kotlin 版・Rust 版への影響の確認）。

### Step 11: 受け入れの green（🟢）

許可リストの `@api` を H2 と PostgreSQL の両方で green にする。Undefined・Pending が 0。ドメイン直接・アプリケーション・HTTP の 3 経路の確認（関数値の経路）。

- **ゲート 11**: 許可リストの通過、2 経路の結果。

### Step 12: 検証と終了（✅）

1. 全テスト・静的解析（違反 0・ベースラインなし・抑制なし）・scoverage（行率の算出）を実行し、結果を記録する。
2. **B1 の受入条件の表の全行が成立・不成立の記録つき**であることを確認する。確認状況の一覧（tech-stack）を、根拠とともに更新する。
3. **NF-P2 の実測の方法を決めて記録する**（判断項目 8）。
4. `validating-design` を実施し、設計書との差分を、設計書（`verified` の再確認が要る）に反映する。
5. **`apply-living-documentation` を実施し、結果を Bolt 終了報告に記録する**（規約）。
6. Bolt 1 終了報告（`bolt_1_report.md`）を書く。人のデモ操作・コードの全行理解の申告欄を設ける。
- **ゲート 12**: 終了報告、設計書の差分の承認。

---

## 完了条件（Definition of Done）

- [ ] ローカル（H2）で E2E が通り、PostgreSQL（Testcontainers）でも同じシナリオが通る
- [ ] 許可リスト（B1 の範囲）の `@api` が green。Undefined・Pending が 0
- [ ] **静的解析: ガイドの確認用コードと fixture の期待件数が使う版で一致し、全コードが違反 0 件・ベースラインなし・抑制なし。違反コードを置くとローカルで失敗する**
- [ ] B1 の受入条件の表の全行が、成立・不成立の記録つき（成立しない場合は、設計の見直しを人が決めた）
- [ ] 行率の算出スクリプトとそのテストが通り、全体の行 80% が確認できる
- [ ] golden テスト、`simulateWeek` と `Game` の性質テストが通る
- [ ] 依存関係の承認と、導入した版の記録がある
- [ ] `apply-living-documentation` の実施と結果が、終了報告に記録されている
- [ ] 人による全ゲート（0〜12）の承認が記録されている（承認は、ユーザーが指示した範囲だけを記録）

### デモ項目

1. ゲームを作成し、4 役割に参加して開始する（ローカル H2）。
2. 4 役割が数量を入力し、確定して、役割別の状況（他役割・将来需要は開示されない）を表示する。
3. 同じシナリオを PostgreSQL でも実行する。
4. 違反コード（`println`・`var`・`head`）を置くと静的解析が失敗する。

---

## リスクと対策

| リスク | 対策 |
| :--- | :--- |
| H2 が設計の機能を満たさない（SR1） | Step 1 の最初に実測。受け入れの正は PostgreSQL |
| `ConnectionIO` からのインメモリ状態の扱いが成り立たない（SR2） | Step 1 で実測し、不成立なら止めて設計を見直す |
| ガイドの静的解析が sbt・使う版で動かない | Step 2 の最初に確認。動かなければ B2 以降を止めて代替を選ぶ（判断項目 9） |
| scoverage で行率・層別しきい値が出ない（SR3） | 全体のしきい値だけにし、97% は目安のまま |
| 依存関係の承認待ちで止まる（SR4） | Step 0 でまとめて承認を受ける |
| doobie が RC | 更新のたびに変更の影響を確認する。RC13 の出所は未確認 |
| 共有物の変更が Kotlin 版・Rust 版を壊す（SR5） | 共有物の変更は都度確認。複製しない |
| 人の承認待ちが日程を支配する（SR14） | ゲートごとの待ち時間を実績として記録する |

## 完了後の流れ

B1 の結果（人の検証時間を含む）で、B2 以降の見積もりを再調整する。B2 で、B1 のローカルの検査を CI の 3 ジョブに載せる。

## 更新履歴

| 日付 | 変更 | 担当 |
| :--- | :--- | :--- |
| 2026-11-26 | 初版（草案）。静的解析を最初のコードより前に設定する手順（Step 2）と、依存関係の一覧を含む | claude-code |
