---
type: Plan
title: "Bolt 1 計画 - 基盤と縦の最小（ウォーキングスケルトン、Kotlin 版）"
description: "beer-game-kotlin の Bolt 1 のステップ計画。ゴール、仮説、対象の受入条件、着手前に人の判断が要る項目、TDD のステップと承認ゲート、完了条件。承認待ち。"
tags: [plan]
status: draft
generated: { by: claude-code/claude-sonnet-5-5, at: 2026-11-14T08:49:39Z }
---

# Bolt 1 計画 - 基盤と縦の最小（ウォーキングスケルトン、Kotlin 版）

## 概要

| 項目 | 内容 |
| :--- | :--- |
| Bolt | B1（[リリース計画](./release_plan.md)） |
| Unit | U1 ウォーキングスケルトン（前半） |
| 所要（計画） | 4 稼働日（2026-11-16〜2026-11-19。仮定） |
| ゲート密度 | **密**（ステップごとに、人が検証する） |
| アプローチ | アウトサイドイン（[開発戦略](./development_strategy.md) の序盤）。**受け入れのシナリオと API の仕様が先** |
| テスト戦略 | Comprehensive（`simulateWeek`、集約、イベントストア）、Standard（その他） |
| 状態 | **承認待ち**（下の「人の判断が要る項目」の承認を含む）。本書は AI が提案したもので、人が承認するまで実行しません |

> **承認の状態について**: リリース計画と開発戦略の承認は、文書にはまだ記録していません（2026-11-14 に、承認の記録を文書へ書く操作が、自動モードの分類器に拒否されたため。ユーザーの確認を待っています）。本書の実行は、リリース計画の承認と、本書の承認が前提です。

### ゴール

キット準拠のゲームを、**作成 → 参加 → 役割の割り当て → 開始 → 入力 → 確定 → 状態の表示**まで、**ローカル（H2）と PostgreSQL（Testcontainers）の両方**で、構造化ログ、`/ready`、層の依存の検査、役割別の週結果の保存つきで、縦に通す。入口は、このウォーキングスケルトンの**日本語 Gherkin のシナリオ**と、`contracts/openapi.yaml` の仕様（仕様が先）にする。

### 確認したい仮説

1. 2 ストリーム（`game`・`session`）と `startGame` の原子的な追記、同期投影は妥当か（[ADR-002](../../adr/beer-game-kotlin/002-event-sourcing-and-cqrs.md)、[ADR-003](../../adr/beer-game-kotlin/003-synchronous-projections.md)）。
2. Kotlin 2.4・JDK 25・Gradle・Ktor・Arrow の組み合わせは動くか（[ADR-013](../../adr/beer-game-kotlin/013-tech-stack-versions.md)）。
3. **H2 の PostgreSQL モードで、設計が使う機能のどれが動くか**（[ADR-014](../../adr/beer-game-kotlin/014-h2-for-local-development.md)）。
4. **Cucumber-JVM と Cucumber-JS の 2 つの処理系で、フィーチャーファイルを 1 か所から参照できるか。** 日本語 Gherkin を、Undefined → Pending → Failing → Passing の順に回せるか（[ADR-012](../../adr/beer-game-kotlin/012-gherkin-and-cucumber.md)）。
5. AI の出力の質は、どの密度の承認ゲートが要るか（以降の Bolt のゲート密度を決める）。

### 対象の受入条件

beer-game2 の B1 と同じ範囲です（[ユーザーストーリー](../../requirements/beer-game2/user_story.md)）。

| ストーリー | 受入条件 | 備考 |
| :--- | :--- | :--- |
| US1.1 | AC1.1.1、AC1.1.2 | キット準拠の作成。**無効な需要系列は、対象週と修正内容を示す**（誤りは項目ごとに集めて返す） |
| US1.2 | AC1.2.1、AC1.2.2、AC1.2.3、AC1.2.5 | 1 役割 1 人（共同担当は B6）。受付終了のコードの拒否。AC1.2.5 は、付け替えの解釈（[ドメインモデル](../../design/beer-game-kotlin/domain-model.md) D9） |
| US2.1 | AC2.1.1、AC2.1.2、AC2.1.3 | 役割別の状況。他役割・将来需要は開示しない。小売店は当週の需要を読む |
| US2.2 | AC2.2.1、AC2.2.2 | 数量の保存と検証（共同入力は B6） |
| US2.3 | AC2.3.1〜AC2.3.5 | 手動の確定、一回性、障害時の原子性、決定論、**役割別の週結果の保存** |
| US6.1 | AC6.1.1、AC6.1.2、AC6.1.4 | 構造化ログ、エラーの記録、`/ready`（メトリクス AC6.1.3 は B13） |

### 範囲外（後続の Bolt）

規約検査の厳格な適用と PMD、API の契約テストと型の生成の CI への組み込み、追記専用権限の否定テスト、N-1 互換（B2）。デプロイの定義（B3）。振り返りの画面（B4）。停止・再開・代理入力・復帰・資格の失効（B5）。共同担当（B6）。カスタム条件（B7）。自動確定（B8）。観察者（B9）。出力（B10）。削除（B11）。投影の再構築（B12）。

---

## 人の判断が要る項目（着手前の承認）

| # | 項目 | 内容 | 提案 |
| :--- | :--- | :--- | :--- |
| 1 | **新しい依存関係の導入** | B1 で使う: Ktor、Arrow、kotlinx.coroutines・serialization・coroutines-test、PostgreSQL JDBC、HikariCP、Flyway、Logback、Kotest、Testcontainers、Kover、detekt、ktlint、**Cucumber-JVM（導入は決定済み）、Cucumber-JS（同）、H2（ローカル開発用）**。版は [技術スタック](../../design/beer-game-kotlin/tech-stack.md) の 2026-11-14 の確認値。**PMD と、API の契約テストの道具は B2 で承認を求める** | 承認をお願いします。版は、導入の直前に、あらためて公式の情報で確認します。フロントエンド（React、Vite、Playwright など）の版は、beer-game2 の確認値（2026-11-09）で、再確認していません |
| 2 | **ローカルの環境** | JDK 25 は入っている（JetBrains Runtime 25.0.4.1。CI は Temurin の想定で、配布が違う）。Gradle は未導入で、**Gradle ラッパーで固定**する。Node は 24.11.0 で、設計は **Node 26 LTS**（`nvm` で入れ、`.nvmrc` で固定する環境の変更）。Docker は入っている | Node 26 の導入を承認してください。ローカルの JDK は、動作確認の用途ならこのままで進め、版の差で問題が出れば Temurin に揃えます |
| 3 | **新規ファイルの作成** | `apps/beer-game-kotlin/` の一式（Gradle のモジュール、`contracts/openapi.yaml`、`features/`、フロントエンド、`.nvmrc`、`compose.yaml` ほか）と、CI の `.github/workflows/beer-game-kotlin.yml`（検証のみ。デプロイはしない） | この計画の承認で、作成してよいとします。**ディレクトリ `apps/beer-game-kotlin/` は、`.gitkeep` のみの状態で作成済み** |
| 4 | **フロントエンドの配置** | beer-game2 の UI を再利用するか、新規か | **`apps/beer-game-kotlin/web/`（React + Vite）に新しく実装し、beer-game2 の UI は参考にする（コピーしない）**。API の型は、仕様から生成する |
| 5 | **フィーチャーファイルの配置** | 共有の `features/` か、処理系ごとか | **`apps/beer-game-kotlin/features/<機能領域>/` に 1 か所にまとめ、Cucumber-JVM と Cucumber-JS の両方から参照する**（仮説 4 で確かめる。できなければ、処理系ごとに分ける） |
| 6 | **環境変数の名前** | `DB_KIND`（`postgres` / `h2`）と `APP_ENV`（`local` / `staging` / `production`）は提案の名前 | この名前で確定してよいか。`DB_KIND=h2` を許すのは `APP_ENV=local` だけで、それ以外は起動に失敗する |
| 7 | **仮の既定値** | 数量の上限 1000、最終週の上限 50（[非機能要件](../../design/beer-game-kotlin/non-functional.md)） | 暫定の値で進めます。資格の期限などは B5 で、運営者と合意して確定する |
| 8 | **beer-game2 のコードの扱い** | `apps/beer-game2` は参照のみ（変更しない）。`simulateWeek` などは、beer-game2 を**参考にして、テストを先に書いて、Kotlin で新しく実装する**（コピーしない） | この方針で進めます |
| 9 | **所要が 4 日を超える場合** | Step が 12 あり、4 日では厳しい見込み | UI（Step 10）を最小にする。それでも超える場合は、予備 B16 で吸収し、[リリース計画](./release_plan.md) を再調整する（人が判断） |

---

## ステップ計画

各ステップは **TDD（Red → Green → Refactor）**で進めます。ステップの終わりが承認ゲートで、**人が、テストとコードを全行理解して**承認してから、次へ進みます。テスト名には、ストーリー・受入条件の ID を含めます（Kotest は `[US2.3/AC2.3.2] Given … When … Then …`、Gherkin はタグ `@US2.3 @AC2.3.2`）。

凡例: 🔵 設計・準備　🔴 Red（失敗するテスト）　🟢 Green（最小の実装）　🟡 Refactor　✅ 検証

### Step 1: H2 の PostgreSQL モードの実測（🔵）

**最初に行います**（[ADR-014](../../adr/beer-game-kotlin/014-h2-for-local-development.md)）。結果で、H2 版で置き換える・省略する制約を確定します。

- [ ] 1.1 H2（2.5.252）の PostgreSQL モードで、次が動くかを、小さな検証用のコード（使い捨て。成果物にしない）で実測する: アドバイザリロック、`LISTEN` / `NOTIFY`、部分一意索引、`CREATE ROLE` / `GRANT` / `REVOKE`（`TRUNCATE` を含む）、`jsonb`、一意違反と直列化失敗の SQLSTATE、分離レベル（READ COMMITTED、REPEATABLE READ）、`ON DELETE CASCADE`、Flyway の適用
- [ ] 1.2 結果を表にして、[データモデル](../../design/beer-game-kotlin/data-model.md) の「ローカル開発」節と未決事項に記録する（動いた／動かなかった／部分的）
- [ ] 1.3 H2 版で置き換える・省略する制約の一覧を確定する（省略した制約は、ローカルでは守られないと明記する）

**ゲート 1**: 実測の結果と、H2 版の置き換え・省略の一覧を、人が確認する。結果が悪ければ（設計が H2 で成り立たなければ）、ここで止めて方針を相談する。

### Step 2: リポジトリの土台（🔵）

- [ ] 2.1 Gradle ラッパー（Gradle 9.9.1 の予定）、バージョンカタログ（確認済みの版で固定）、`.editorconfig`、`.gitignore`、`.nvmrc`（26）
- [ ] 2.2 Gradle のマルチモジュール: `domain`、`application`、`adapter-persistence`、`adapter-http`、`app`。**`domain` は Kotlin 標準と Arrow だけに依存**（ビルドで強制）
- [ ] 2.3 ktlint と detekt（標準ルール。違反 0）の最小の設定、Kover の最小の設定、`ForbiddenMethodCall`（ドメインでの時計・乱数・UUID の禁止）。**厳格な適用の完成（PMD の 14 ルール、fixture、ベースラインなし・`@Suppress` なし）は B2**
- [ ] 2.4 `compose.yaml`（PostgreSQL 18）、`.github/workflows/beer-game-kotlin.yml`（ktlint、detekt、`test`、`integrationTest`。PostgreSQL 18 のサービス。検証のみ）
- [ ] 2.5 空の状態で、`./gradlew` の検査・テストが緑で、モジュールの依存の違反を実際に検出する（意図的な違反で失敗し、戻して成功）

**ゲート 2**: 構成、依存関係の導入の承認の記録、モジュールの依存の検査を、人が確認する。

### Step 3: 契約と受け入れの入口（🔵🔴）

- [ ] 3.1 `contracts/openapi.yaml` に、ウォーキングスケルトンの経路（作成、参加、割り当て、開始（`POST /games/:id/start`）、入力、確定、状態の表示）と、`problem+json` の `code` の一覧を書く（**仕様が先**。契約テストの CI への組み込みは B2）
- [ ] 3.2 `features/<機能領域>/` と、タグの文書化（`TAGS.md`）。**最初のシナリオを、日本語 Gherkin で書く**（例: 4 役割が揃ったゲームで、1 週を確定すると、役割別の状況が更新される。`@US2.3 @AC2.3.1 @api @acceptance-criteria`。画面を通す 1 本は `@ui`）
- [ ] 3.3 Cucumber-JVM（`@api`。`acceptanceTest` を想定）と Cucumber-JS + Playwright（`@ui`）の基盤。2 つの処理系から `features/` を参照できるか確かめる
- [ ] 3.4 🔴 シナリオを実行し、**Undefined** になることを確認する（ステップ定義を書いて Pending → Failing を確認する）

**ゲート 3**: **シナリオ（業務の言葉）と仕様**を、人が確認し、契約として承認する。処理系の構成（仮説 4）を確認する。

### Step 4: ドメイン — 値オブジェクトと週次計算（🔴🟢🟡）

- [ ] 4.1 🔴 値オブジェクト（`value class`）のテスト: `Role`、`Quantity`（0〜1000）、`Week`（1〜50）、`Money`、`DisplayName`、`StreamVersion`、`DecisionVersion`。誤りを集めて返す検証（`Either` と `zipOrAccumulate`）
- [ ] 4.2 🟢 値オブジェクトの実装
- [ ] 4.3 🔴 `simulateWeek` の **golden テスト**（既知の系列。2 週遅延）と、**プロパティテスト**（決定論、非負、保存、費用、遅延、役割別の合計 = チームの合計）。次週の入荷・受注（小売店は当週の需要）も返す
- [ ] 4.4 🟢 `simulateWeek` の実装（純粋関数）。**役割別の週結果**を返す
- [ ] 4.5 🟡 Refactor

**ゲート 4**: golden の期待値が教材（要件定義の BR-02〜BR-09）と一致することを、人が確認する。ドメインの `var`・可変コレクション・`!!`・`throw` が無いことを確認する。

### Step 5: ドメイン — Game（🔴🟢🟡）

- [ ] 5.1 🔴 `decideGame` のテスト（Given = 過去のイベント、When = コマンド、Then = イベントまたはエラー）: キット準拠の作成（`KitPreset`）、設定の検証（無効な需要系列は対象週と修正内容）、参加、役割の割り当て（1 人 1 役割。別の役割から移す場合の扱い）、不足している役割の通知
- [ ] 5.2 🟢 `decideGame` / `evolveGame` の実装。`evolve` は全域（強制キャストなし）
- [ ] 5.3 🟡 Refactor

**ゲート 5**: ルールが `decide` に集まり、`evolve` が計算をしていないことを確認する。

### Step 6: ドメイン — Session と `startGame`（🔴🟢🟡）

- [ ] 6.1 🔴 `decideSession` のテスト: 入力の保存、手動の確定（週と `basis` の一致）、一回性、最終週の終了、`WeekAdvanced`。`startGame`（2 ストリームへ原子的に追記する唯一のコマンド）
- [ ] 6.2 🟢 `decideSession` / `evolveSession` と `startGame` の実装。`WeekCommitted` に結果と `nextStates` を含める（D5）
- [ ] 6.3 🔴🟢 D5 の検証（違う `nextStates` を持つ `WeekCommitted` を Given にして、状態がその値を採用する）。`InvalidTransition` の検知
- [ ] 6.4 🟡 Refactor

**ゲート 6**: 集約の粒度と、`startGame` の原子性の設計（仮説 1）を確認する。誤りが分かれば、ここで止めて設計を見直す。

### Step 7: イベントストア・投影・ポート（🔴🟢🟡）

- [ ] 7.1 🔴 PostgreSQL（Testcontainers）の統合テスト: `append`（版の一意制約 `uq_events_stream_version`）、冪等記録、`startGame` の 2 ストリームの原子性、同期投影（追記と同じトランザクション。`Left` で ROLLBACK）
- [ ] 7.2 🟢 Flyway 001（`events`、`game_roots`、`idempotency_records`、投影の最小の表）、`EventStore`、`EventCodec`、`Projection`（`Event -> List<RowChange>`）
- [ ] 7.3 🔴🟢 ポート `ProjectionLock`・`ChangeNotifier` の **PostgreSQL 版と H2 版**と、**契約テストを両実装で**実行（排他・共有、コミット後の通知、ロールバックでは通知しない。H2 版は単一プロセスのみ）
- [ ] 7.4 🟢 実行の選択（`DB_KIND`）。H2 版のマイグレーション（共通の部分を最大化し、差分だけを分ける。配置はここで確定）
- [ ] 7.5 🟡 Refactor

**ゲート 7**: 版・冪等・原子性のテストと、ポートの契約テストが両実装で緑であることを、人が確認する。マイグレーション 001 を承認する。

### Step 8: アプリケーション（🔴🟢🟡）

- [ ] 8.1 🔴 関数の束（`Ports` をスタブに差し替え）のテスト: 「認証 → 認可の前提検査 → 冪等記録の照合 → 読み込み → `decide` → 追記・投影」の順序。成功した応答だけを保存。失効した資格の再送は 403。`AppFailure`
- [ ] 8.2 🟢 `execute` と、認可、冪等、再試行（`ConcurrencyConflict` の上限つき）の実装
- [ ] 8.3 🟡 Refactor

**ゲート 8**: 処理の順序（[ADR-004](../../adr/beer-game-kotlin/004-idempotency-after-authorization.md)）と、業務ルールが関数の束に漏れていないことを確認する。

### Step 9: HTTP と観測性（🔴🟢🟡）

- [ ] 9.1 🔴 `testApplication` のテスト: 認証・認可（無効な資格は同じ応答）、入力の検証、problem+json（`type` が `/problems/{code}`）、応答は `versions` だけ、`/ready`（DB を止めると失敗）
- [ ] 9.2 🟢 Ktor のルート（仕様 `contracts/openapi.yaml` のとおり）、構造化ログ（資格・表示名・非公開の値を含めない）、`/ready`
- [ ] 9.3 🔴🟢 **本番での H2 の拒否**（`APP_ENV` が `staging`・`production` で `DB_KIND=h2` なら起動に失敗する）。本番相当の設定で、鍵が無ければ起動に失敗する
- [ ] 9.4 🟡 Refactor

**ゲート 9**: 仕様と実装が手で照合できる範囲で一致していること（契約テストの自動化は B2）、ログの内容、H2 の拒否を確認する。

### Step 10: UI（アウトサイドイン）（🔴🟢）

- [ ] 10.1 🔴 `@ui` のシナリオ（画面を通す 1 本）と、コンポーネントのテスト。API の型は仕様から生成する
- [ ] 10.2 🟢 React + Vite の最小の画面（ゲームの作成、参加、割り当て、開始、入力、確定、状態の表示）。**最小に絞る**
- [ ] 10.3 🟡 Refactor

**ゲート 10**: 画面が、API の仕様と型に従っていることを確認する。

### Step 11: 受け入れの green（🟢）

- [ ] 11.1 `@api` のシナリオが、**PostgreSQL とローカル（H2）の両方**で green（受け入れの正は PostgreSQL）
- [ ] 11.2 `@ui` のシナリオと、ウォーキングスケルトンの E2E が green
- [ ] 11.3 **Undefined・Pending のステップが無い**

**ゲート 11**: シナリオが、業務の言葉のまま green であることを、人が確認する。

### Step 12: 検証と終了（✅）

- [ ] 12.1 全テスト（`test`、`integrationTest`、受け入れ）、ktlint、detekt、Kover（domain の行 100%）が緑
- [ ] 12.2 ログ・`/ready`・H2 の拒否のデモ。依存関係の導入の承認と版の確認の記録がある
- [ ] 12.3 Bolt 終了報告（`bolt_1_report.md`）。**デモ項目の実操作の申告**。実績の所要（人の検証時間を含む）を記録し、リリース計画の残りの Bolt の所要を再調整する
- [ ] 12.4 判断と学びを、ジャーナルに書く

**ゲート 12（Bolt の承認）**: 人が、完了条件を確認し、Bolt を承認する。

---

## 完了条件（Definition of Done）

- [ ] 対象の受入条件（上記）が、テストと Gherkin のシナリオでパスしている（テスト名とタグにストーリー ID を含む）
- [ ] ローカル（H2）と PostgreSQL の両方で、作成から確定までのシナリオが通る（受け入れの正は PostgreSQL）
- [ ] **Undefined・Pending のステップが無い**。タグの一覧と意味が文書化されている
- [ ] `contracts/openapi.yaml` に、ウォーキングスケルトンの経路が書かれ、`@api` のシナリオと一致している
- [ ] H2 の実測の記録がある。ポート `ProjectionLock`・`ChangeNotifier` の契約テストが、両実装で green
- [ ] DB 統合テストが、CI で**必ず実行される**（スキップされない）。domain の行 100%
- [ ] ktlint・detekt が違反 0 で通り、モジュールの依存の違反を検出する
- [ ] ログに、資格・表示名・非公開値が含まれない（テストで確認）。本番相当の設定で、鍵が無い、または H2 が選ばれると、起動に失敗する
- [ ] 依存関係の導入の承認と版の確認の記録がある
- [ ] **コードを、人が全行理解して承認した**

### デモ項目

1. ローカル（H2）で、1 ゲーム（4 役割、数週）を、ブラウザで通す。同じシナリオを PostgreSQL でも通す。
2. 日本語 Gherkin のシナリオを実行し、Undefined → Pending → Failing → Passing の流れを示す。
3. ログ（構造化 JSON）と、`/ready`（DB を止めると失敗する）、本番設定での H2 の拒否を示す。

---

## リスクと対策

| リスク | 影響 | 対策 |
| :--- | :---: | :--- |
| H2 の PostgreSQL モードで、設計が使う機能が動かず、ローカルの構成が成り立たない | 中 | Step 1 で最初に実測し、ゲート 1 で止めて方針を相談する（置き換え・省略の確定） |
| 集約の粒度・`startGame` の原子性が誤っている | 高 | Step 5〜7 で早期に検証し、誤りが分かればゲートで止めて設計を見直す |
| Kotlin 2.4・JDK 25・Gradle・Arrow・Kover・Kotest の組み合わせの不具合 | 中 | Step 2 で、空の状態から確認する。問題があれば、版を一段下げる判断を、人が行う |
| Cucumber の 2 処理系から `features/` を共有できない | 中 | Step 3 で確かめる。できなければ、処理系ごとに分ける |
| 計算の期待値が、教材とずれる | 高 | golden の期待値を、要件定義の BR と照合してから実装する（ゲート 4） |
| AI が層の規則を破る、ルールをアプリケーション層に書く | 中 | モジュールの依存の検査と、ゲートで確認する |
| 所要が 4 日を超える | 中 | UI（Step 10）を最小にする。超過は B1 の実績として、リリース計画を再調整する（予備 B16 で吸収） |

## 完了後の流れ

- Bolt 終了報告（`bolt_1_report.md`）と、判断と学びのジャーナル。
- **B1 の実績（所要、AI の出力の質、H2 の実測）で、リリース計画の所要とゲート密度を再調整する。**
- B2（規約検査・CI・テスト基盤）の計画を作成し、承認を得る。**B2 の結果が悪ければ（detekt・PMD と Kotlin 2.4 の互換、Kover、連鎖削除）、B3 以降を止める。**

## 更新履歴

| 日付 | 更新内容 | 更新者 |
| :--- | :--- | :--- |
| 2026-11-14 | 初版作成（AI が提案。人の承認待ち） | claude-code/claude-sonnet-5-5 |
