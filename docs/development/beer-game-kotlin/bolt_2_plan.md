---
type: Plan
title: "Bolt 2 計画 - 規約検査・CI・テスト基盤（Kotlin 固有、Kotlin 版）"
description: "beer-game-kotlin の Bolt 2 のステップ計画。静的解析の厳格な適用（PMD の 14 ルールと fixture）、Kover、追記専用権限の否定テストと連鎖削除、CI の組み込み、API の契約テストの道具の選定。承認待ち。"
tags: [plan]
status: draft
generated: { by: claude-code/claude-sonnet-5-5, at: 2026-11-14T13:30:00Z }
---

# Bolt 2 計画 - 規約検査・CI・テスト基盤（Kotlin 固有）

## 概要

| 項目 | 内容 |
| :--- | :--- |
| Bolt | B2（[リリース計画](./release_plan.md)） |
| Unit | U1 ウォーキングスケルトン（後半） |
| 所要（計画） | 3 稼働日（仮定） |
| ゲート密度 | **密**（ステップごとに、人が検証する） |
| アプローチ | 序盤（[開発戦略](./development_strategy.md)）。**ルール・検査そのものを、テストファーストで確かめる**（fixture） |
| 状態 | **承認待ち**。本書は AI が提案したもの。**ユーザーのゴール（U1）に従い、B1 が未承認のまま、2026-11-14 に実行を開始した**（B2 のステップ計画そのものは、人が承認していない） |

### 着手前に、ユーザーが決めたこと（2026-11-14）

| # | 項目 | 決定 |
| :--- | :--- | :--- |
| 1 | PMD の導入 | **承認**（PMD 7.29.0。CI のツール。XPath の 14 個の関数型ルール） |
| 2 | detekt 1.23.8 が JDK 25 で動かない問題 | **JDK 21 専用ジョブで維持**（アプリは JDK 25 のまま。PMD と併用。detekt 2 系が安定したら見直す） |
| 3 | API の契約テスト（OpenAPI）の道具 | **公式情報で候補を調べて提示**し、ユーザーが選んで承認してから導入する。**選定と導入の承認までは、契約テストの導入（Step 5 の道具に依存する部分）に着手しない** |
| 4 | B1 のゲート 1〜12（未承認） | **未承認のまま B2 へ進む**（B1 の成果は人の確認待ちとして残す） |

### ゴール

静的解析の厳格な適用（違反 0 件、ベースラインなし、`@Suppress` なし）を CI で守らせ、追記専用権限と連鎖削除の設計が成り立つかを PostgreSQL で確かめ、Kover の計測を実態（`test`・`integrationTest`・受け入れの合算）に合わせる。

### 確認したい仮説

1. PMD は、使う版（7.29.0）で、Kotlin 2.4 の構文を解析でき、14 ルールの fixture の期待件数（ガイドの例は 17 件）と一致するか。Gradle で実行でき、層ごとのルールセットの分割と両立するか。
2. 追記専用権限（`events` に UPDATE・DELETE・TRUNCATE 無し）と `game_roots` の連鎖削除は、PostgreSQL で両立するか（リスク R6）。
3. Kover は `test`・`integrationTest`・受け入れを合算できるか。domain の行 100% を、生成コードの扱いとあわせて、どう守るか。
4. detekt の JDK 21 専用ジョブは、CI で再現できるか。

### 範囲外

API の契約テストの**実装**（道具の選定と承認の後。選定の候補の提示は B2 に含む）、N-1 互換ジョブの本実装（雛形のみ）、デプロイの定義（B3）。

---

## ステップ計画

各ステップは TDD（Red → Green → Refactor。テスト・fixture を先に書き、失敗を確認）で進めます。**ゲートは、人の確認待ち**とし、承認済みとは書きません。

### Step 1: PMD の導入（14 ルールと fixture）（🔴🟢🟡）

- [x] 1.1 🔴 ガイド §9.6 の fixture（違反するコードとしないコード）を作り、**期待する件数と行**を決める。ルールセット（14 ルール）を、**先に fixture で確かめる**（失敗を確認）
- [x] 1.2 🟢 PMD 7.29.0 を Gradle に導入（Kotlin のソースを検査。層ごとのルールセットの分割。`message` に波括弧を書かない）。fixture の期待件数と一致する
- [x] 1.3 本体のコードに適用し、**違反 0 件**にする（ベースラインなし、`@Suppress` なし。違反は修正する）。境界のコード（`main`、アダプター）とテストで外すルールは、層ごとのルールセットで明示し、理由を記録
- [x] 1.4 CI に組み込む（fixture のテストとあわせて）。**規約違反コードを 1 つ置くと CI が落ちる**ことを、detekt（JDK 21）と PMD のそれぞれで確認する（**ローカルの同じタスクで確認**。GitHub Actions 上の実行は未確認）

**ゲート 1**: ルールと fixture、層ごとの緩和を、人が確認する。**状態: 人の確認待ち**（未承認）。

#### Step 1 の結果（実測。2026-11-14）

**1. 先に fixture（Red）**

- fixture は `apps/beer-game-kotlin/config/pmd/fixtures/Fixture.kt`（ガイド §9.6 のとおり 40 行）、期待は `expected.txt`（「行 ルール名」17 件。ガイドの期待と同じ）。検査は Gradle のタスク `pmdFixtureTest`（PMD を fixture に実行して XML を読み、期待と**過不足なく**一致しなければ失敗。処理エラー・ルールの設定の誤りも失敗）。
- Red: ルールセット（`fp-kotlin-rules.xml`）が無い状態で `./gradlew pmdFixtureTest` を実行すると失敗した（PMD が `Cannot load ruleset config/pmd/fp-kotlin-rules.xml` を出し、レポートが空のため XML の読み込みで失敗）。依存の解決（`repositories { mavenCentral() }` の不足）で先に 1 度失敗したが、それは Red の理由ではないので直した。
- Green: ガイドの 14 ルールを `fp-kotlin-rules.xml` に実装して再実行し、**実際の件数 17 件、期待と一致**（`Found 17 violations.` と `pmdFixtureTest: 期待どおり 17 件`）。

**2. PMD の導入と Kotlin の解析**

- 版は `gradle/libs.versions.toml` の `pmd = "7.29.0"`（`pmd-cli`・`pmd-kotlin`。Maven Central に 7.29.0 の POM があることを確認）。
- **Kotlin 2.4 の解析: できた。** 本体・テストの全ファイル（5 モジュールの main・test・integrationTest・acceptanceTest）で、構文エラーも「式本体のローカル関数」の内部エラー（ガイドの注意）も出なかった。ただし、PMD 7.29.0 が内蔵する Kotlin の字句・構文解析は kotlin-compiler-embeddable 2.4.0 に依存して動いており、**PMD が Kotlin 2.4 の全構文を保証するとは確認していない**（未確認。今回のコードで解析できたという事実のみ）。
- Gradle の `pmd` プラグインは Java 用なので使わず、`PmdCli` を `JavaExec` で実行する（`pmdTool` 構成。`workingDir` はプロジェクトのルート）。タスク: `pmdFixtureTest`、`pmdDomainApplication`、`pmdAdapter`、`pmdMain`、`pmdTest`、まとめて `pmd`。各モジュールの `check` にも `pmd` を依存させた。実行時の `No auxClasspath configured for Kotlin` の警告は、型情報を使わない構文の検査なので無視してよい（ガイドのとおり）。`sun.misc.Unsafe` の警告も出るが、PMD 7.29.0 が内蔵する kotlin-compiler-embeddable によるもので、結果には影響しない。
- 実行時間（実測。他の Gradle・PMD が同時に動いていて、負荷が高かったときの値）: `pmd` 全体で 2〜15 分と大きくばらついた（`pmdTest` が最も重い）。CI の `timeout-minutes: 20` に収まるかは**未確認**（GitHub Actions 上では未実行）。

**3. 層ごとのルールセット（`config/pmd/`）**

| ファイル | 対象 | 外すもの（理由） |
| :--- | :--- | :--- |
| `fp-kotlin-rules.xml` | 14 ルールの定義（正本） | — |
| `ruleset-domain.xml` | `domain/src/main`・`application/src/main` | 14 ルール + 標準（bestpractices・errorprone）。外すルールは**なし**。**標準の `FunctionNameTooShort` の閾値だけ 3 文字→2 文字に下げた**（ルールは外していない）。理由: 失敗を `Either` で返す工場関数 `of`（`Quantity.of`・`Week.of`・`Settings.of` など 14 か所）が 2 文字。閾値は XPath に固定でプロパティが無いため、`xpath` を上書きした |
| `ruleset-adapter.xml` | `adapter-persistence/src/main`・`adapter-http/src/main` | `NoThrow`（コルーチンの取消 `CancellationException` の再送出、LISTEN の失敗を `SQLException` で再試行へ伝える）、`NoVarProperty`・`NoVarClassParameter`（JDBC の位置番号、設定の受け渡し、試行の窓の件数）、`NoMutableCollectionFactory`（`ResultSet` からの集計、コミット後のフック、試行の窓の表）、`NoRawConcurrency`（試行の窓の `@Synchronized`）、`SideEffectInNonSuspendFunction`（相関 ID の `UUID.randomUUID`）、標準の `LooseCoupling`（`LinkedHashMap` を型に使う）。`FunctionNameTooShort` は閾値 2 |
| `ruleset-main.xml` | `app/src/main` | `NoRunBlocking`（起動時に実際のポートを同期で取得する 1 か所）、`SideEffectInNonSuspendFunction`（本物の時計・ID を組み立てる `Bootstrap.kt`・`Wiring.kt`）、`NoRawConcurrency`（シャットダウンフックの `Thread`）。`FunctionNameTooShort` は閾値 2 |
| `ruleset-test.xml` | 全モジュールの `test`・`integrationTest`・`acceptanceTest` | `NoVarProperty`・`NoVarClassParameter`・`NoMutableCollectionFactory`（Cucumber の World、試験の台本の累積）、`SideEffectInNonSuspendFunction`（試験データの時計・ID）、`NoRunBlocking`（同期のステップから suspend を呼ぶ）、`NoThrow`（アサーション）、`NoRawConcurrency`（実プロセスのサーバーの部品）、標準の `FunctionNameTooShort`（ドメインの試験の `q`・`u`・`w`・`m` の 1 文字の記法）。**外さない**: `NoNotNullAssertion`、`NoReduce`、`NoGenericCatch`、`NoNestedFlatMap`、`NoGlobalScope`、`NoThreadSleep`、`NoMutableCollectionInSignature` |

- 緩和は**層ごと（ルールセット単位）**で、`@Suppress` は使っていない。層の中の**新しい違反も、外したルールについては検出されなくなる**（件所ごとではない）。この粗さが許容できるかは、ゲート 1 で人が判断する。戦略（development_strategy.md）の「ルールの緩和は理由を ADR に記録し、人が承認」は、**ADR をまだ書いていない**（未実施。承認後に ADR にする）。
- 各ルールセットの冒頭の XML コメントに、外した理由と、**現に報告された箇所**（ファイル名）を書いた。

**4. 本体への適用と違反**

- 初回の実測（全層に「全ルール有効」の同じルールセットを適用。層ごとの緩和の前）: ドメイン・アプリケーションの `main` 14 件（すべて `of` の `FunctionNameTooShort`）、アダプター 15 件、`app` の `main` 5 件、テスト 101 件。ルールを外さずに**コードを直した違反**: `!!`（`NoNotNullAssertion`）20 件を `checkNotNull` に置き換えた（`app/src/test`: `HttpFlowSpec.kt` 12 件・`MainSpec.kt` 2 件、`app/src/acceptanceTest`: 3 件、`app/src/integrationTest`: `PostgresHttpSpec.kt` 3 件）。ほかは上の層ごとの緩和で扱った。
- **`adapter-persistence/` のコードは修正していない**（別の作業の編集中。指示のとおり）。`adapter-persistence` の違反は、すべて層ごとのルールセットの緩和で扱った（`ChangeNotifiers.kt` の `throw`、`JdbcEventStore.kt`・`JdbcTx.kt` の可変コレクション、`JdbcSupport.kt` の `var`）。**これらをコードで直すかは、人の判断**（設計に関わる。たとえば `JdbcSupport.kt` の位置番号は `var`）。
- 最終の実測: `pmdAdapter`・`pmdDomainApplication`・`pmdMain`・`pmdTest` が、それぞれ `Found no violations.`、`pmdFixtureTest` が 17 件で一致（`./gradlew pmd --continue` と、`pmdTest` の再実行で確認）。`./gradlew pmdTest :app:ktlintCheck :app:test :app:compileIntegrationTestKotlin :app:compileAcceptanceTestKotlin` も成功（`!!` の置換で、`app` の `test` は緑のまま）。

**5. 規約違反コードで CI のタスクが落ちること（1.4）**

- `domain/src/main/kotlin/beergame/domain/ConventionViolation.kt`（`var leaked: Int = 0` と `fun readClock(): Instant = Instant.now()`）を一時的に置いた。
  - PMD（JDK 25）: `./gradlew pmdDomainApplication` が失敗（`NoVarProperty`（6 行目）と `SideEffectInNonSuspendFunction`（8 行目）の 2 件、終了コード 4、`BUILD FAILED`）。
  - detekt（JDK 21）: `./gradlew :domain:detektMain` が失敗（`ForbiddenMethodCall`: `java.time.Instant.now`（8 行 36 桁）、`BUILD FAILED`）。
- ファイルは削除して、戻した（`git status` に残っていない）。

**6. CI（`.github/workflows/beer-game-kotlin.yml`、4.1 の一部）**

- ジョブ `pmd`（JDK 25）を追加: 先に `./gradlew pmdFixtureTest`、次に `./gradlew pmdDomainApplication pmdAdapter pmdMain pmdTest`。detekt は既存の JDK 21 の専用ジョブのまま。`verify` ジョブの `check` も、`pmd` に依存するため PMD を重ねて実行する（重複。実行時間が問題なら整理する）。YAML は `ruby -ryaml` で構文を検証した（`ok`）。GitHub Actions 上では**未実行**。

**7. 見つけた制約・未確認**

- ルールセットの読み込みに失敗すると、PMD は `Found no violations.` を表示する（ログの最後）が、その前に ERROR を出して終了コードは非 0 になる。fixture のテストは、`configerror` と処理エラーの有無も検査している。層ごとのタスク（`pmd*`）は終了コードに頼るので、同様に落ちる（今回、設定の誤りで 1 度失敗して確認した）。
- 標準の `FunctionNameTooShort` は、閾値がプロパティでなく XPath に埋め込まれている。変えるには `xpath` を上書きする。
- 依存の追加: PMD のみ（CI のツールで、実行時の依存関係ではない）。契約テストの道具は入れていない。detekt の設定は変えていない。
- 未確認: GitHub Actions 上の実行と時間。`integrationTest`・`acceptanceTest` の実行（Docker・Cucumber。今回はコンパイルのみ）。PMD が Kotlin 2.4 の全構文を解析できるか。`web/`（TypeScript）は対象外。

### Step 2: Kover の合算とゲート（🔴🟢）

- [ ] 2.1 Kover が `test`・`integrationTest`・受け入れを合算できるか実測する
- [ ] 2.2 層ごとの目標と、全体のゲート（行 85%・分岐 75%）を、実測に基づいて設定する。**domain の行 100% と、生成コード（`value class` の生成メンバー）の扱い**を調べ、**人の判断が要る場合は、閾値を黙って下げず、事実と選択肢を記録する**

**ゲート 2**: 実測と、ゲートの設定を、人が確認する。

### Step 3: 追記専用権限の否定テストと連鎖削除（🔴🟢）

- [x] 3.1 🔴 PostgreSQL（Testcontainers）の否定テスト: 書き込みロールが `events` を UPDATE・DELETE・TRUNCATE できない／`game_roots` を DELETE できない／各ロールが表の所有者・所有者ロールのメンバーでない／削除ロールが `game_roots` 以外を直接 DELETE できない。**連鎖削除が、`events` に DELETE 権限が無いロールで動くか**の Red のテスト
- [x] 3.2 🟢 マイグレーション V101（PostgreSQL 専用。ロールと GRANT）。結果に合わせて設計を確定（動かない場合の代替: `SECURITY DEFINER` の関数、削除用ロール）

**ゲート 3**: 権限の設計と、マイグレーションを、人が確認する。**（待ち。承認済みではない）**

#### Step 3 の結果（実測。2026-11-14）

**変更したファイル**: `adapter-persistence/src/main/resources/db/migration/postgres/V101__database_roles.sql`（新規）、`adapter-persistence/src/integrationTest/kotlin/beergame/persistence/RolePrivilegesSpec.kt`（新規。11 件）、同 `PostgresSupport.kt`（別データベースの作成と、所有者での接続の道具を追加）。依存の追加なし、`@Suppress` なし。

**Red の確認（先に書いて失敗を確認）**: V101 を置く前に `RolePrivilegesSpec` を書いて実行した。ロールが無いため、`role "beergame_writer" does not exist`（`SET ROLE`）などで失敗した（Red）。その後 V101 を置き、11 件が緑になった。なお、Red 中に分かった試験側の不備（`openFixture` の LISTEN 用の接続、台本が書かない `current_decisions`・`week_team_totals` の行）は、V101 の前に直した。
**変異による確認（常に通るテストでないこと）**: V101 に一時的に `GRANT UPDATE, DELETE, TRUNCATE ON events TO beergame_writer`、`GRANT DELETE ON game_roots TO beergame_writer`、`GRANT SELECT ON game_join_codes TO beergame_observer`、`GRANT DELETE ON events TO beergame_deleter`、`GRANT beergame_deleter TO beergame_reader` を足すと、11 件中 6 件が失敗した（追記専用 2、所有者・メンバー、削除ロールの範囲、観察者の 3 表、連鎖削除の前提）。変異を戻して 11 件が緑に戻ることを確認した。

**実行したコマンドと結果**（JDK 25）:

- `./gradlew :adapter-persistence:integrationTest --tests '*RolePrivilegesSpec*'`: 緑（11 件、0 失敗）。
- `./gradlew :adapter-persistence:test :adapter-persistence:integrationTest :adapter-persistence:ktlintCheck`: 緑（`PostgresPersistenceSpec` 44 件、`RolePrivilegesSpec` 11 件。ktlint 0。警告エラー化は既存の設定のまま）。
- `./gradlew :app:integrationTest`: 緑（V101 を含めて適用しても、単一の接続ユーザーのアプリは壊れない）。
- 受け入れ（`acceptanceTest`）は、**未実行**（ルートの Gradle と CI を別のエージェントが編集中のため。アプリのコードは変えていないので影響は無い見込みだが、未確認）。

**連鎖削除の可否の実測（仮説 2、リスク R6）**: **動いた**。削除ロールに `events` の DELETE 権限が無い状態（`has_table_privilege('beergame_deleter', 'events', 'DELETE')` が false）で、`DELETE FROM game_roots WHERE game_id = ?` を 1 回実行すると、`game_id` 列を持つ`game_id` 列を持つ全表（`information_schema.columns` から取得。件数は未計測）から当該ゲームの行が消え、別のゲームの行は残った。事前に全表に行があることも検査した（台本が書かない表は直接 INSERT で補った）。理由は、PostgreSQL が参照の整合性のトリガーを子の表の所有者の権限で実行するため。したがって**代替（`SECURITY DEFINER` の関数、別の削除用ロール）は不要**で、試していない。ADR-010 の「トリガーを足さない」方針も維持できた。仮説 2 は支持された（PostgreSQL 18、`postgres:18-alpine`、1 回の実測）。

**ロールと GRANT の設計（V101）**: ロールは `beergame_writer`・`beergame_reader`・`beergame_observer`・`beergame_deleter`（`NOLOGIN`、非特権、継承なし。`CREATE ROLE` は存在しなければ作る）。

| ロール | 権限 |
| :--- | :--- |
| `beergame_writer` | `events`・`game_roots` は SELECT・INSERT のみ。投影・周辺ストア・冪等記録・`projection_checkpoints` は SELECT・INSERT・UPDATE・DELETE（再構築が行を消すため） |
| `beergame_reader` | 投影の表（`projection_checkpoints`・`game_join_codes`・`game_settings` を含む。V101 の GRANT の一覧のとおり）と `display_profiles` の SELECT のみ |
| `beergame_observer` | `game_overview`・`session_overview`・`week_team_totals` の SELECT のみ |
| `beergame_deleter` | `game_roots` の SELECT・DELETE のみ（WHERE 句の列の参照に SELECT が要る） |

所有者は新しいロールを作らず、マイグレーションを実行する接続のユーザー（テストでは Testcontainers のスーパーユーザー）とした。否定テストは、所有者の接続を `SET ROLE` で切り替えて行い、拒否は SQLState 42501 で確かめた。検査の内訳: (a) 書き込みロールの `events` の UPDATE・DELETE・TRUNCATE、(b) `game_roots` の DELETE・UPDATE・TRUNCATE（`CASCADE` つきを含む）、(c) 4 ロールが表の所有者でも所有者ロールのメンバーでもなく、特権属性（superuser など）も他ロールのメンバーシップも無い、(d) 削除ロールの DELETE 権限が `game_roots` だけ（全表を `pg_tables` から列挙）、(e) 観察者の SELECT 可能な表が設計書の 3 表と完全に一致、観察者と読み取りに書き込み権限がどの表にも無い、(f) 連鎖削除。加えて、書き込みロールが過剰に絞られていない（INSERT・SELECT ができる）ことと、全ロールが `flyway_schema_history` を読めないことも検査した。

**設計書との食い違い・未決・未確認**（設計書は直していない。人の判断で反映する）:

- 読み取りロールの権限は設計書（「投影の SELECT のみ」）に表の一覧が無いため、`display_profiles`（ロビーの表示名の結合）を含めた。**これは本 Step の判断**であり、`credentials`・`browser_sessions`・`idempotency_records` は含めていない。認証と冪等記録を読み取り側の問い合わせが使うかは、B3 で用途別のプールを配線するときに確定する（未決）。
- ロールの名前（`beergame_*`）は設計書に規定が無いため、本 Step で付けた。`data-model.md` と `architecture-infrastructure.md` の「データベースのロール」の表に、名前と GRANT の表を追記する必要がある。連鎖削除の未決事項（`data-model.md` の未決、`test-strategy.md` の未決、ADR-010 の「未検証」）は「実測済み」に更新できる。
- 「所有者」のロールは、独立したロールとして作っていない（マイグレーションの接続ユーザー）。本番の RDS で、マイグレーション用のユーザーをどう作るかは未決（B3 以降）。
- 通知の受信（`LISTEN` のみ）のロールは作っていない（設計書の表にあるが、LISTEN は特別な権限が要らない。専用の接続の配線は B3 以降。未決）。
- `deletion_*`（V006、B11）の GRANT は、その表を作るマイグレーションで書く（既定の権限は与えていない）。設計書の削除ロールの権限「`deletion_*` の読み書き」は、B11 に持ち越し。
- V101 は V102 より小さい番号で、**すでに V102 まで適用済みの既存の DB には、そのままでは適用できない**（Flyway は、適用済みの最大の版より小さい未適用の版を、既定で検証エラーにする）。現時点で PostgreSQL に永続の環境が無い前提（ローカルは H2、CI は使い捨て）なので問題にならないが、ステージング・本番を作る前に確認が要る（B3 以降）。
- アプリのコードを用途別のロール・接続に切り替える作業は、本 Step の範囲外（アプリは単一の接続ユーザーのまま）。観察者の接続プールの配線の検査（H13）も未実施（B3 以降）。
- 統合テストは、同一コンテナ内の専用データベース（`beergame_roles`）を毎回作り直して実行する。ロールはクラスタ全体のため、他の統合テスト（`beergame_test`）も V101 でロールを作るが、`CREATE ROLE` は存在確認つきで、実行は直列（並列実行の設定なし）。
- 1 回の実測であり、PostgreSQL 18 以外の版では未確認。権限の否定テストの実行時間は、Testcontainers の起動を除いて数秒。

### Step 4: CI の整備（🟢）

- [ ] 4.1 CI の工程（ktlint、detekt（JDK 21 の専用ジョブ）、PMD、fixture、`test`、`integrationTest`、受け入れ（`@api`）、カバレッジ）を整える。DB の統合が 1 件も実行されなければ失敗、Undefined・Pending で失敗
- [ ] 4.2 N-1 互換ジョブの雛形（直前のリリースが無い間は実行しない）

**ゲート 4**: CI の構成を、人が確認する。

### Step 5: API の契約テストの道具の候補の提示（🔵）

- [ ] 5.1 OpenAPI の妥当性の検査、応答のスキーマ適合の検査、TypeScript の型の生成の候補を、公式の情報（Maven Central、npm）で確認し、比較表にする（版、保守状況、Kotlin／Ktor との相性、problem+json の `code` の列挙や SSE の表現力、新規依存の数）
- [ ] 5.2 **人が選び、承認する**。承認後に、契約テストと型の生成を CI に組み込む（**本 Bolt の範囲に含めるかは、承認の時点で判断**）

**ゲート 5**: 道具の選定と、導入の承認（人）。

### Step 6: 検証と終了（✅）

- [ ] 6.1 全テスト、静的解析、Kover、CI の確認
- [ ] 6.2 設計書の更新と、`validating-design` の完了時の実施。Bolt 終了報告（`bolt_2_report.md`）。人の確認待ちの項目の一覧

---

## 完了条件（Definition of Done）

- [ ] 規約違反コードを置くと CI が落ちる（detekt（JDK 21）と PMD のそれぞれ）。PMD の fixture のテストが期待どおり
- [ ] 違反 0 件・ベースラインなし・`@Suppress` なしで全コードが緑
- [ ] 追記専用権限の否定テストが通り、連鎖削除の可否が確定している
- [ ] Kover の合算の可否と、ゲートの設定が記録されている（domain の行 100% の扱いは人の判断）
- [ ] API の契約テストの道具の候補が提示されている（選定と導入は人の承認の後）
- [ ] `validating-design` を実施済み。コードを、人が全行理解して承認した（**未実施。人の確認待ち**）

## リスクと対策

| リスク | 影響 | 対策 |
| :--- | :---: | :--- |
| PMD が Kotlin 2.4 の構文を解析できない、または Gradle で動かない | 高 | fixture で最初に確かめる。動かなければ、事実を記録して止め、人に判断を仰ぐ（代替: ktlint のカスタムルールなど） |
| 追記専用と連鎖削除が両立しない | 高 | Step 3 の Red のテストで確かめ、動かない場合の代替を設計（`SECURITY DEFINER` など） |
| 厳格な適用で、本体の違反の修正が多く、所要が膨らむ | 中 | 違反は修正する（ベースラインにしない）。膨らんだら B16（予備）で吸収 |
| domain の行 100% が生成コードで届かない | 中 | 事実と選択肢を記録し、人の判断を仰ぐ |

## 更新履歴

| 日付 | 更新内容 | 更新者 |
| :--- | :--- | :--- |
| 2026-11-14 | 初版作成（AI が提案。**ステップ計画は人の承認待ち**。ユーザーの決定 4 件を反映し、ゴール U1 に従って実行を開始） | claude-code/claude-sonnet-5-5 |
