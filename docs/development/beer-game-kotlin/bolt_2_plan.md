---
type: Plan
title: "Bolt 2 計画 - 規約検査・CI・テスト基盤（Kotlin 固有、Kotlin 版）"
description: "beer-game-kotlin の Bolt 2 のステップ計画。静的解析の厳格な適用（PMD の 14 ルールと fixture）、Kover、追記専用権限の否定テストと連鎖削除、CI の組み込み、API の契約テストの道具の選定。承認済み（2026-11-15。ステップ計画のみ。ゲートは人の確認待ち）。"
tags: [plan]
status: stable
generated: { by: claude-code/claude-sonnet-5-5, at: 2026-11-15T00:30:43Z }
verified:
  - { by: human:kakimomokuri, at: 2026-11-15T00:30:44Z }
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
| 状態 | **実装は完了（2026-11-15）。ステップ計画（本書）は、2026-11-15 にユーザーが承認した（実装の後の事後の承認。ユーザーの選択: 「B2 と B3 のステップ計画を承認」）。ゲート 1〜5 と Bolt の承認（ゲート 6）は、承認の対象に含まれず、すべて人の確認待ち（未承認）**。ユーザーのゴール（U1）に従い、B1 が未承認のまま 2026-11-14 に実行を開始した。結果は [Bolt 2 終了報告](./bolt_2_report.md) |

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

API の契約テストの**実装**（道具の選定と承認の後。選定の候補の提示は B2 に含む）、N-1 互換ジョブの本実装（雛形のみ。B12）、デプロイの定義（B3）。**契約テストの実装は、2026-11-14 にユーザーが道具を選定・承認したため、Step 5 で実施した**（上の記述は着手前のもの）。

**範囲外・未実施（検証で追記）**: リリース計画の B2 の行にある**`InvalidTransition` の性質テスト**は、この計画に Step が無く、実施していない（人の判断で、B3 以降へ回すか決める）。B1 の申し送りのうち、生きたドキュメントの公開の導線、Cucumber のタグ（`@US`・`@AC`）の整合検査、フロントエンドの lint での握りつぶしの検出、`@Suppress`・ベースラインの機械検査（CI）、`TAGS.md` の除外も、この計画に項目が無く、未実施（[終了報告](./bolt_2_report.md) の #20）。

## 設計（4 図の扱い）

B2 は、規約検査・CI・テスト基盤が主で、**新しい集約・イベント・テーブル・画面を作らない**。開発戦略の軸 B の「4 図」は、次のとおり、B2 で変わらない。

| 図 | B2 での扱い |
| :--- | :--- |
| ドメインモデル図 | 変更なし（B2 でドメインのコードを変えていない。`!!` の置換はテストのコードのみ） |
| 状態遷移図 | 変更なし（状態を持つ集約の変更なし） |
| ER 図 | 変更なし（V101 はロールと GRANT だけで、表を作らない。権限は [データモデル](../../design/beer-game-kotlin/data-model.md) の表で示す） |
| 画面遷移図 | 変更なし（画面を作らない。`web/src/api/types.ts` の型を生成物に置き換えたが、画面の遷移は変えていない） |

設計書への反映（B2 の実装で変わった点）は、各文書の変更表に記録した（テスト戦略、バックエンド、データモデル、フロントエンド、インフラ、技術スタック。ADR-008・010・011）。

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

- 緩和は**層ごと（ルールセット単位）**で、`@Suppress` は使っていない。層の中の**新しい違反も、外したルールについては検出されなくなる**（件所ごとではない）。この粗さが許容できるかは、ゲート 1 で人が判断する。戦略（development_strategy.md）の「ルールの緩和は理由を ADR に記録し、人が承認」は、**ADR をまだ書いていない**（Step 1 の時点）。**Step 6 で、記録を [ADR-011](../../adr/beer-game-kotlin/011-strict-static-analysis.md) に追記した**（提案として記録。**人の承認は未**）。
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

- [x] 2.1 Kover が `test`・`integrationTest`・受け入れを合算できるか実測する
- [x] 2.2 層ごとの目標と、全体のゲート（行 85%・分岐 75%）を、実測に基づいて設定する。**domain の行 100% と、生成コード（`value class` の生成メンバー）の扱い**を調べ、**人の判断が要る場合は、閾値を黙って下げず、事実と選択肢を記録する**（全体のゲートは設定済み。**domain の行 100% は、除外も閾値の引き下げもせず、テストの追加とコンパイラ設定 1 つで到達し、ゲートを 100% にした（2026-11-15 の追補。下の 4）**。ゲートの設定そのものは、人の確認待ち）

**ゲート 2**: 実測と、ゲートの設定を、人が確認する。**（待ち。承認済みではない）**

#### Step 2 の結果（実測。2026-11-15）

**1. 合算の可否（2.1）: 合算できる。**

- Kover 0.9.11 は、ルート（`build.gradle.kts`）で `kover` プラグインを適用し、`dependencies { kover(project(":domain")) ... }` で全 5 モジュールを集めると、ルートの `koverXmlReport`・`koverVerify` が全モジュールを合算する。
- 公式ドキュメント（kotlin.github.io/kotlinx-kover。取得した版は 0.9.8 の記述）の記述: 「既定ではすべてのテストタスクを計測する」。実測でも、`adapter-persistence` と `app` の `build/kover/bin-reports/` に `test.ic`・`integrationTest.ic`・`acceptanceTest.ic`・`acceptanceTestH2.ic` が生成された。`./gradlew koverVerify --dry-run` で、`koverVerify` が `test`・`integrationTest`・`acceptanceTest`・`acceptanceTestH2` をすべて先に実行する依存を確認した（追加の設定は不要）。
- **落とし穴（実測）**: `integrationTest`・`acceptanceTest` のソースセットのクラス（`beergame.acceptance.*`、`PostgresSupport` など）が、本番コードとして行数に入った（`beergame/acceptance` が 549 行カバー）。各モジュールで `kover { currentProject { sources { excludedSourceSets.addAll("integrationTest", "acceptanceTest") } } }` を設定して外した。
- 公式ドキュメントで**確認できなかった事項**: `excludedSourceSets` の記述そのもの（ビルドが通り、効果を実測で確認しただけ）。0.9.11 の版固有のドキュメントは未確認。

**2. カバレッジの実測（合算。`./gradlew check -x pmd integrationTest acceptanceTest acceptanceTestH2 koverVerify koverXmlReport`）**

| 範囲 | 行 | 分岐 |
| :--- | ---: | ---: |
| **全体（合算）** | **3141/3245 = 96.8%** | **804/1030 = 78.1%** |
| domain | 784/804 = 97.5% | 160/163 = 98.2% |
| application | 569/576 = 98.8% | 98/127 = 77.2% |
| adapter-persistence | 921/938 = 98.2% | 165/233 = 70.8% |
| adapter-http | 587/615 = 95.4% | 257/335 = 76.7% |
| app | 280/312 = 89.7% | 124/172 = 72.1% |

- B1（`test` のみ、モジュール別）との差: adapter-http の行は 70.4% → 95.4%、分岐は 55.8% → 76.7%（受け入れ・統合が HTTP を通すため）。合算で、設計の層ごとの目安（adapter-http 行 90%・分岐 75%）を満たした。application の分岐（目安 85%）と adapter-persistence の分岐（目安 75%）は、目安に届かない（目安で、ゲートではない）。app の行は、起動部を含む（設計は「起動部は除外」としたが、除外は未設定）。
- 上の数値の読み方: 層の値は、合算の報告をパッケージ（`beergame/domain` など）で集計した。

**3. ゲートの設定（2.2）**

| ゲート | 設定 | 場所 | 実測 |
| :--- | ---: | :--- | ---: |
| 全体の行 | 85% | `build.gradle.kts`（ルート。合算） | 96.8% |
| 全体の分岐 | 75% | 同上 | 78.1%（余裕 3.1 ポイント） |
| domain の行 | **100%**（2026-11-15 に暫定の 97% から引き上げ。下の 4 の追補） | `domain/build.gradle.kts`（モジュール単位） | 100%（未到達 0 行） |

- 設計の目標のうち、層ごとの他の目標は「目安」なので、ゲートにしていない（設計どおり）。
- Kover 0.9.11 の検査の規則（`rule`）には、パッケージで絞る `filters` が無い（実測: コンパイルエラー）。そのため domain の行は、domain モジュールの `koverVerify`（domain の `test` だけの計測。値は合算と同じ 784/804）に置いた。
- **閾値割れで失敗すること（実測）**: 全体の分岐を 85%、domain の行を 100% に一時的に変えて `./gradlew koverVerify --continue` を実行し、`:koverVerify`・`:domain:koverVerify` が FAILED になることを確認した。その後、元の値（75%・97%）に戻した。戻したあと `./gradlew koverVerify` は BUILD SUCCESSFUL。

**4. domain の行 100% の事実と選択肢（人の判断）**

**追補（2026-11-15）: 100% に到達した。** 除外・閾値の引き下げはしていない。以下の「未到達の 20 行」以降は、到達前の記録として残す。
- **実測した未到達の行は 19 行**（Kover の XML の `ci=0`）。「20 行」は再現できなかった（差の 1 行は内訳不明のまま。集計の違いの可能性。**未確認**）。内訳は下の記述どおりで、`Foundation.kt` 56 行の原因が確定した: **`Actor` の interface の既定メソッドに、コンパイラが互換用に生成する `Actor$DefaultImpls`（呼ばれない）**。`value class` の 9 行の原因は、ボックス化した値のインスタンスの `getValue`（Kotlin のコードからは unbox 経由のため呼ばれず、JVM の呼び出しからだけ到達する）。
- **到達させた方法**: (1) `ValueObjectsSpec` に値の意味の試験を追加（11 型 × 4 件 = 44 件: 等しさ・ハッシュ・別の値との非等価、文字列表現、ボックス化した値の getter が包んだ値を返すこと（`Class.getMethod` による。JVM から見える窓口）、集合・写像・リストの要素にできること）。(2) `ProjectionSpec` に、個々の投影（9 つ）が自分の表の行だけを 1 行以上作ること（9 件）と、`all` が個々の投影を表の順序で並べたものであること（1 件）を追加（10 件）。(3) `domain/build.gradle.kts` に Kotlin コンパイラの `-jvm-default=no-compatibility` を追加（`DefaultImpls` を生成しない。domain は Kotlin のビルドだけから使われる。**この設定の妥当性は人の確認待ち**）。本番コード（`domain/src/main`）は変更していない。追加したテストは計 54 件。
- **ゲート**: `domain/build.gradle.kts` を 100% に変更。未到達の関数を 1 つ足すと `:domain:koverVerify` が失敗（`99.8755 ... expected minimum is 100`）することを確認し、戻した。

- **未到達の 20 行（784/804）の内訳**: すべて、手で書いた処理ではなく、コンパイラが生成するコードに対応する行。
  - `value class` のプライマリコンストラクタのプロパティの行（`val value: Int,` など）9 行（`Quantities.kt` の 10・28、`Values.kt` の 22・44・61・83・96・110・125。ボックス化したクラスの `getValue` など）。
  - `object Projections` のプロパティ宣言の行（`val gameOverview =` ほか 9 行）。プロパティ初期化の行は通るが、宣言の行に対応する getter（`getGameOverview()` など）が、どこからも呼ばれない（`Projections.all` は内部でフィールドを直接読む）。
  - `Foundation.kt` 56 行 `fun toRef(): ActorRef =` の 1 行。本体は呼ばれている（application・adapter-persistence の試験）が、宣言の行の命令の一部が未到達。**原因は未確認**（生成コードの疑い。バイトコードは未確認）。
  - 合計 19 行（9＋9＋1）を特定できた。報告の「未到達 20 行」との差の 1 行は、**内訳は未確認**（部分的に到達した行 4 行の集計の違いの可能性）。
- **除外で 100% に届くか（実測）**: 届かない。Kover の除外は、クラス単位（`classes(...)`）か、注釈（`annotatedBy`）しか確認できない。生成コードだけを除く方法は、確認できなかった。実験として `Projections*`・`Quantity`・`Units` を除外すると、domain は 611/620（行 98.5%）に変わっただけで、**実処理の行 184 行が計測から消えた**（行 100% にも届かない）。実験は元に戻した。
- 選択肢（決めるのは人）:
  1. **閾値の見直し**: domain の行のゲートを 97%（現状の実測 97.5% に基づく下限）のまま、設計書の「100%」を、実測に合わせて書き換える。
  2. **コードの変更で生成コードを減らす**: `object Projections` の `val` を `private val` にする、`value class` をやめて通常のクラスにする、など。いずれも設計・アプリのコードの変更で、本 Step の範囲外（`value class` は設計判断）。
  3. **クラス単位の除外**: 実処理を含むクラスごと除外することになるため、お勧めしない（上の実測）。
  4. **注釈による除外**: 自前の注釈（例: `@Generated` 相当）を作って `annotatedBy` で除外する。生成される getter には付けられないため、効果は未確認。
- **現状の設定**: 97%（現状より悪化させないための暫定の下限。目標 100% は未達のまま）。

**5. 未確認**

- GitHub Actions 上での Kover の実行（ローカルの JDK 25・macOS だけで実測）。
- `suspend` による分岐の揺れ（全体の分岐 75% の余裕は 3.1 ポイント）。複数回の実行での揺れは未測定。
- app の起動部の除外（設計の「起動部を除外」）は未設定。除外すると app の行は上がる。

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

- [x] 4.1 CI の工程（ktlint、detekt（JDK 21 の専用ジョブ）、PMD、fixture、`test`、`integrationTest`、受け入れ（`@api`）、カバレッジ）を整える。DB の統合が 1 件も実行されなければ失敗、Undefined・Pending で失敗（**ワークフローの作成とローカルでの各工程の実測まで。GitHub Actions 上の実行は未確認**）
- [x] 4.2 N-1 互換ジョブの雛形（直前のリリースが無い間は実行しない）

**ゲート 4**: CI の構成を、人が確認する。**（待ち。承認済みではない）**

#### Step 4 の結果（実測。2026-11-15）

**1. ジョブの構成（`.github/workflows/beer-game-kotlin.yml`。検証のみ、デプロイなし）**

| ジョブ | JDK / Node | 内容 | `timeout-minutes` |
| :--- | :--- | :--- | ---: |
| `test` | JDK 25 | `check -x pmd`（ktlint・test・モジュール依存）→ `integrationTest`（PostgreSQL 18）→ `acceptanceTest`（`@api`、PostgreSQL）→ `acceptanceTestH2` → **DB の統合が実行されたことの検査** → `koverVerify koverXmlReport`（カバレッジのゲート）→ Kover の報告を保存 | 30 |
| `detekt` | JDK 21 | `detekt detektMain detektTest` | 15 |
| `pmd` | JDK 25 | `pmdFixtureTest`（先）→ 層ごとの検査（4 タスク） | 15 |
| `web` | Node 26 | `npm ci`、`npm run verify`（format・lint・typecheck・Vitest・build）、`npm run acceptance:dry-run`（Undefined の検出） | 15 |
| `ui` | JDK 25・Node 26 | Playwright の Chromium を導入し、H2 のバックエンド（ポート 3100）を起動して `npm run acceptance`（`@ui`） | 20 |
| `n1` | — | N-1 互換の雛形（下記） | 10 |

- **PMD の重複の整理**: `check` が `pmd` に依存するため、`test` ジョブは `check -x pmd` にして、PMD は `pmd` ジョブだけで実行する。`./gradlew check -x pmd ... --dry-run` で、PMD のタスクがグラフに含まれないことを確認した（0 件）。
- **`timeout-minutes` の根拠**: ローカルの実測で、`check -x pmd integrationTest acceptanceTest acceptanceTestH2 koverVerify koverXmlReport --rerun-tasks`（再コンパイルを含む）が 3 分 25 秒。CI の依存の取得・コンテナの取得・Gradle のキャッシュ無しを見込んで 30 分。設計の実行時間の目標（全体 12 分）との比較は、GitHub Actions 上の実測が無いので**未確認**。

**2. 失敗の条件（実測）**

| 条件 | 結果 | 実測の方法 |
| :--- | :--- | :--- |
| Undefined のステップ（`@api`） | **失敗**（`UndefinedStepException`。`:app:acceptanceTestH2 FAILED`、29 tests completed, 1 failed） | 一時的に、定義の無いステップのシナリオを `features/weekly-play/` に置いて実行し、削除した（`git status` に残っていない） |
| Pending のステップ | **未実測**（Cucumber-JVM は、strict が既定のため Undefined と同じく失敗する想定。確認していない） | — |
| DB の統合が 0 件・全件スキップ | **失敗**（`::error::` を出して終了コード 1） | ワークフローの検査の手順（`test` の結果の XML の合計）を、実際の結果に実行して合格を確認（integrationTest 55 件＋1 件、acceptanceTest 28 件（スキップ 1）、acceptanceTestH2 28 件（スキップ 1））。0 件で落ちる分岐は、条件式の確認だけで、**0 件の状態での実行は未実測** |
| カバレッジの閾値割れ | **失敗**（Step 2 の結果） | 閾値を一時的に上げて実行 |
| Docker が無い | 統合・受け入れ（PostgreSQL）が失敗する想定（Testcontainers）。**未実測** | — |
| Cucumber-JS の Undefined（`@ui`） | `web` ジョブの dry-run、`ui` ジョブの実行で検出される（Cucumber-JS の strict が既定）。**Undefined を置いての実測は未実施** | — |

- 受け入れの `skipped=1` は、`@ui` のシナリオ（Cucumber-JVM は `@api` だけを実行する）と見ているが、**どのシナリオかは未確認**。

**3. Node の工程（`web`・`ui`）を追加した**

- `web`: `npm run verify`（ローカルで B1 に実行済み）と `npm run acceptance:dry-run`（今回ローカルで実行、`1 scenario (1 skipped)`）。
- `ui`: `web/support/hooks.mjs` の案内どおり、`APP_ENV=local DB_KIND=h2 PORT=3100 ALLOWED_ORIGINS=http://localhost:5273 ./gradlew :app:run` で起動し、`/api/v1/ready` を待って `npm run acceptance` を実行する。**ローカルで同じ手順を実行した**（起動 8 回目の確認で ready、`1 scenario (1 passed)`、`8 steps (8 passed)`、約 2.5 秒）。バックエンドは実行後に停止した（ポート 3100 のみ。人の開発サーバーの 3000・5173 は触っていない）。
- **未実施**: Playwright の e2e と axe（設計の CI の工程にあるが、本 Bolt の範囲外）。ブラウザ行列（Firefox・WebKit 等）は定期実行の工程。`ui` ジョブの `npx playwright install --with-deps chromium` は、GitHub Actions の runner 上で**未確認**（ローカルは導入済みのブラウザを使った）。

**4. N-1 互換ジョブの雛形（`n1`）**

- `git tag --list 'beer-game-kotlin-v*'` で直前のリリースのタグを探す。**タグの名前の規約は未決**（仮に `beer-game-kotlin-v*`）。タグが無い間は、検査の工程を実行しない（`if: steps.previous.outputs.tag != ''`）。
- タグが有るのに本実装が無い場合は、意図的に**失敗**する（`exit 1`）。黙って通すと、検査があるように見えて何も確かめない状態になるため。本実装の手順（タグの取り出し・読み取り側のビルド・golden の再生）は、コメントに記した（設計 M22）。**本実装は範囲外・未着手**。
- ローカルで、`git tag --list 'beer-game-kotlin-v*'` が空であることは確認していない（未確認）。

**5. actions の版**

- `actions/checkout`（v7.0.1）・`actions/setup-node`（v7.1.0）・`actions/upload-artifact`（v7.0.2）は、beer-game3.yml に書かれている SHA とコメントの版を、そのまま使って SHA 固定した（beer-game3.yml の記述を転記したもので、**GitHub 上での照合はしていない**）。
- `actions/setup-java`（`@v4`）と `gradle/actions/setup-gradle`（`@v4`）は、SHA を確認できる情報が（リポジトリ内に）無いため、**未固定のまま**。固定は未実施。

**6. 検証**

- YAML の構文: `ruby -ryaml -e 'YAML.load_file(ARGV[0])'` で読み込め、ジョブは `test`・`detekt`・`pmd`・`web`・`ui`・`n1` の 6 つ。
- **GitHub Actions 上の実行は、未確認**（push していない）。特に、`ui` のバックグラウンド起動と待機、`n1` のシェル、`$GITHUB_OUTPUT` の扱い、アップロードした報告の経路は、ローカルでは再現していない。
- ローカルで、`./gradlew check -x pmd integrationTest acceptanceTest acceptanceTestH2 koverVerify koverXmlReport --rerun-tasks` が BUILD SUCCESSFUL（detekt は JDK 25 で無効。detekt・PMD の今回の変更による再実行はしていない）。

### Step 5: API の契約テストの道具の候補の提示（🔵）

- [ ] 5.1 OpenAPI の妥当性の検査、応答のスキーマ適合の検査、TypeScript の型の生成の候補を、公式の情報（Maven Central、npm）で確認し、比較表にする（**比較表は未作成**。ユーザーが 2026-11-14 に選定・承認した）
- [x] 5.2 承認後に、契約テストと型の生成を CI に組み込む（2026-11-15 実施。下の「Step 5 の結果」）

**ゲート 5**: 道具の選定と、導入の承認（人）。選定・承認は 2026-11-14 に済み。**実装の確認（人）は待ち**。

#### Step 5 の結果（実測。2026-11-15）

**1. 使った道具と版（確認した値）**

| 道具 | 版 | 確認 |
| :--- | :--- | :--- |
| `@redocly/cli`（devDependency、固定） | 2.78.0 | `npm view @redocly/cli version` |
| `openapi-typescript`（devDependency、固定） | 7.13.0 | `npm view`。peer は `typescript ^5.x` |
| `com.networknt:json-schema-validator`（`app` の test のみ） | 3.0.9 | Maven Central の maven-metadata（latest・release）と POM。推移的に jackson-databind 3.1.8、itu 1.17.0、slf4j（テスト実行時に jackson-dataformat-yaml） |

これ以外の依存は足していない。

**2. 型の生成の試行（スパイク）の結果**

- `npm install -D openapi-typescript@7.13.0` は、予想どおり **ERESOLVE で失敗**（peer `typescript ^5.x` と web の TypeScript 6.0.3 の衝突）。
- `package.json` に `"overrides": { "openapi-typescript": { "typescript": "$typescript" } }` を足すと導入でき、`npm ls` は `openapi-typescript@7.13.0 -> typescript@6.0.3 deduped`。
- TS 6.0.3 で、生成（`openapi-typescript ../contracts/openapi.yaml`）が成功。生成物を `src/api/generated/schema.d.ts` に置き、`src/api/types.ts` を生成物からの写しに置き換えた。**`npm run typecheck`（tsc）、Vitest（70 件）、lint、format:check、build（`npm run verify`）がすべて通った**。`npm ci --dry-run`（スクラッチ）も成功。
- **結論: 採用**。手書きの型は、画面だけの型（`CreateGameResult`、`ProblemBody`、整数以外も受ける `CreateGameRequest`）と実行時の値（`ROLES`）に絞った。`CreateGameRequest` が仕様より狭くならないこと、`ROLES` が `Role` を網羅することは、型の検査で守る。
- スクリプト: `api:lint`（`redocly lint ... --config ../contracts/redocly.yaml`）、`api:generate`（生成と prettier での整形）、`api:check`（`scripts/check-generated.mjs`。生成し直してコミット済みと比べる。差分 0 でなければ失敗）。`contracts/redocly.yaml` は `recommended-strict`（警告も失敗）に、3 つのルールだけを off（info-license、tag-description、operation-4xx-response。理由は同ファイルに記載）。

**3. 契約テスト（`app/src/test/kotlin/beergame/app/contract/`。13 件）**

- **置き場の判断**: 指示は `adapter-http` だったが、`adapter-http` のテストには永続化の読み取り側（投影）が無く、成功の応答（状態の投影）を作れない。H2 の永続化と全経路の組み立てがあるのは `app` のため、`app` の test に置いた（PostgreSQL 不要。H2 のメモリ上）。`app/build.gradle.kts` の `test` の入力に `contracts/openapi.yaml` を加えた（仕様だけを変えたときにテストが再実行されるように）。
- 検査: 応答の適合（スキーマ・`unevaluatedProperties: false` による未宣言の項目の検出・状態・Content-Type・ヘッダー）、全体の守り（429・413・500・503 が全操作に宣言されていること）、リクエストの適合（事例 39 件の仕様の判定と実装の受理・拒否、Idempotency-Key 必須）、エラー `code` の一致（欠けても余っても失敗）、ルートの網羅、検査自体が違反を見つけること（常に緑でない確認）。
- code の突き合わせの前提: ドメインの code はソースの走査（kotlin-reflect を足さないため）、HTTP の層は `Codes` のリフレクションで集める。分類が Forbidden のドメインの誤り（`session.forbidden`、`game.forbidden`）は `app.unauthorized` に写るため仕様に載せず、参加コードの失敗（`game.invitation_invalid`）だけが例外（ProblemMapping.kt）。

**4. 契約テストが見つけた不一致と対処（Red の実測）**

最初の実行は 13 件中 8 件が失敗した（Red）。うち、テストの誤りは経路の接頭辞・Forbidden の扱い・503 の再現用の状態の 3 点で、テスト側を直した。**仕様と実装の不一致は次のとおりで、実装（アダプターの本体）は変えず、仕様を実装に合わせた**（実装が設計書・受入条件に沿っているため）。

| # | 不一致 | 対処 |
| :--- | :--- | :--- |
| 1 | 409 の problem に、実装は拡張メンバー（`requestedWeek`・`currentWeek`・`role`・`latest`・`week`・`current`）を返すが、仕様に無い | `ConflictProblem`・`ConflictProblemBody`・`DecisionEntry` を追加し、saveDecision・commitWeek の 409 に使用 |
| 2 | 429（レート制限）が、全操作（探針を除く）に掛かるが、7 操作に宣言が無い | 7 操作に 429 を追加 |
| 3 | 413（64 KB 超）が、変更系の全操作に掛かるが、4 操作に宣言が無い | assignRole・startGame・saveDecision・commitWeek に追加 |
| 4 | 500 が、問い合わせ系 3 操作に宣言が無い | getLobby・getSessionState・getGameState に追加 |
| 5 | CreateGameRequest の範囲（最終週 1〜50、需要 0〜1000、保持日数 1〜3650）が、説明文だけでスキーマに無く、実装は範囲外を 422 にする | `minimum`・`maximum` を追加 |
| 6 | 表示名が、実装は 1〜80 文字だが、仕様は「上限は未決」 | `minLength: 1`・`maxLength: 80` を追加 |
| 7 | `GameState.sessionId` が、実装は常に含める（開始前は null）が、仕様は任意（型の生成で、画面が `string \| null` と読めなくなって発覚） | `required` に追加 |

**これらの仕様の変更は、ADR-008 の「仕様が先」に照らすと、実装に合わせた後追いの修正**。人の確認が要る（特に 5・6 の範囲を仕様に重複して持つこと）。

**5. 変異の確認（わざと仕様と実装をずらし、失敗→戻して成功）**

| 変異 | 結果 |
| :--- | :--- |
| 仕様の `ErrorCode` から `session.week_advanced` を削除 | 契約テスト 2 件が失敗（code の一致、応答の適合） |
| 実装の応答の項目名 `submittedRoleCount` を変更 | 応答の適合が失敗（必須項目の欠落と未宣言の項目を指摘） |
| 実装のルート `/games/{gameId}/start` を `/begin` に変更 | 8 件が失敗。ルートの網羅は「実装にあって仕様に無い: begin、仕様にあって実装に無い: start」を指摘 |
| 実装の code `app.rate_limited` を変更 | code の一致が「仕様にあって実装に無い、実装にあって仕様に無い」を指摘 |
| 仕様の `$ref` を壊す（スクラッチの写し） | `redocly lint` が終了コード 1（no-unresolved-refs） |
| 仕様の `HealthStatus` の enum に値を追加 | `api:check` が終了コード 1（再生成を促す） |

いずれも元に戻し、アダプターの本体のコードに差分が残っていないことを `git status` で確認した。

**6. CI**: `.github/workflows/beer-game-kotlin.yml` に `contract` ジョブ（`npm ci` → `api:lint` → `api:check`）を追加し、`web`（typecheck を含む）は `contract` の後、`test`（契約テストを含む）は `contract` と `web` の後に実行する（順序: 仕様の検証 → 型の生成 → 型の検査 → テスト）。YAML の構文は Ruby で読み込めることまで確認。**GitHub Actions 上の実行は未確認**。

**7. 静的解析**: ktlint 緑、PMD（`pmd` 全タスク）違反 0（fixture 17 件は期待どおり）、detekt（JDK 21、`:app` の detekt・detektMain・detektTest）緑。`@Suppress` なし、ルールの緩和なし。

**8. 未確認・未決**
- 問い合わせ系の 503（`app.retry_exhausted`）が起きうるかは未確認（コマンド系だけ検証。問い合わせ系の仕様に 503 は無い）。
- SSE の検査は、B1 の範囲に SSE が無いため未実施。
- スキーマで表せない条件（経路の週と `requestedWeek` の一致、需要系列の長さ、空白だけの表示名）は、事例と説明文で扱うだけ。
- `required` が実装より緩い仕様（#7 のような）は、応答の適合では検出できない（任意の項目は、無くても適合）。型の生成と typecheck で補うが、網羅は保証しない。
- 設計書・ADR の更新が要る点（直していない）: test-strategy.md の「契約テストは adapter-http」に読める記述の置き場（実際は app）、CI の工程表への `contract` ジョブ、エンドポイント表（architecture-backend.md）への 409 拡張メンバーと 429・413・500 の共通宣言の反映。
- 全体の確認: `./gradlew check -x pmd koverVerify`（JDK 25。integrationTest・acceptanceTest・acceptanceTestH2 を含む）が **BUILD SUCCESSFUL（4 分 35 秒）**。Kover のゲートを含めて通った（契約テスト追加後の合算の数値は未記録）。

### Step 6: 検証と終了（✅）

- [x] 6.1 全テスト、静的解析、Kover、CI の確認（**ローカルの同じタスクまで。GitHub Actions 上の確認は未実施**）
- [x] 6.2 設計書の更新と、`validating-design` の完了時の実施。Bolt 終了報告（`bolt_2_report.md`）。人の確認待ちの項目の一覧

**ゲート 6**: Bolt の承認（人）。**状態: 人の確認待ち**（未承認）。

#### Step 6 の結果（2026-11-15）

- **全体のビルド**: `./gradlew build integrationTest acceptanceTest acceptanceTestH2 koverVerify --rerun-tasks`（JDK 25）が BUILD SUCCESSFUL（5 分 31 秒）。合計 583 件、失敗 0。`web` の `npm run verify` 成功（Vitest 70 件、`api:lint`、`api:check`）。detekt は JDK 21 で緑、PMD は 4 層とも違反 0（fixture は期待 17 件と一致）。内訳は [終了報告](./bolt_2_report.md) の「実測値」。
- **設計書・ADR の更新**: テスト戦略、バックエンド、データモデル、フロントエンド、インフラ、技術スタック、ADR-008・010・011、開発戦略（未決事項の注記のみ）を更新し、各変更表に 1 行ずつ記録した。**決められないものは直さず、各文書の未決事項に書いた。**
- **`validating-design`（完了時）**: 軸 A は NG（6 件。修正 3、人の判断待ち 3）、軸 B は NG（9 件。修正 7、人の判断待ち 2）、軸 C は NG（3 件。修正 1、持ち越し 2）。修正の内容と、人の判断待ちの項目は [終了報告](./bolt_2_report.md) に記録した。**着手前の検証の記録はこの計画に無い**（規律の逸脱）。
- **終了報告**: [bolt_2_report](./bolt_2_report.md)。完了条件の達成・未達・未実施、仮説の検証結果、人の判断が要る項目 20 件、学び、B3 への申し送り。

---

## 完了条件（Definition of Done）

- [x] 規約違反コードを置くと CI が落ちる（detekt（JDK 21）と PMD のそれぞれ）。PMD の fixture のテストが期待どおり（**ローカルの同じ Gradle タスクで確認。GitHub Actions 上は未確認**）
- [x] 違反 0 件・ベースラインなし・`@Suppress` なしで全コードが緑（**層ごとのルールセットで外したルールがある。人の承認は未。ADR-011 に追記**）
- [x] 追記専用権限の否定テストが通り、連鎖削除の可否が確定している（連鎖削除は動く。V101）
- [x] Kover の合算の可否と、ゲートの設定が記録されている（合算の可否と全体のゲートは [x]。domain の行 100% は 2026-11-15 に到達し、ゲートを 100% にした。**ゲートは人の確認待ち**）
- [ ] API の契約テストの道具の候補が提示されている（候補の提示と選定はユーザーとの対話で 2026-11-14 に行われ、導入まで実施したが、**比較表は文書に残していない**ため [ ] のまま）
- [ ] ktlint の `.editorconfig` の調整が実際の版で動く（戦略・リリース計画の受入条件。**B2 で個別に確認していない。未確認**）
- [x] `validating-design` を実施し、結果を [終了報告](./bolt_2_report.md) に記録した
- [ ] `validating-design` の不整合が 0 件、または人が判断済み（**判断待ちが残る**）
- [ ] コードを、人が全行理解して承認した（**未実施。人の確認待ち**）

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
| 2026-11-15 | **domain の行 100% に到達**（Step 2 の追補）: 未到達 19 行を特定、テスト 54 件を追加、`-jvm-default=no-compatibility` を追加、ゲートを 97% から 100% に変更（除外・引き下げなし）。ゲートと設定の妥当性は人の確認待ち | claude-code/claude-sonnet-5-5 |
| 2026-11-15 | Step 1〜5 の結果を記録（実施日の連続セッション）。Step 6（検証と終了）を実施: 完了条件のチェック（達成したものだけ [x]）、状態を「実装は完了、ゲートは人の確認待ち」に更新、範囲外・未実施（`InvalidTransition` の性質テストほか）と「設計（4 図の扱い）」を追記、ADR-011 への緩和の記録を反映、終了報告（bolt_2_report.md）を作成 | claude-code/claude-sonnet-5-5 |
| 2026-11-15 | **検証による修正**（`validating-design`、完了時）: 軸 A の A1〜A3、軸 B の B1、軸 C の C2 を計画側で修正。**ステップ計画は人が承認していないため、人の再確認を求める** | claude-code/claude-sonnet-5-5 |
| 2026-11-15 | **ステップ計画（本書）をユーザーが承認**（事後の承認。ユーザーの選択: 「B2 と B3 のステップ計画を承認」）。ゲート 1〜6 は承認の対象外で、人の確認待ちのまま | claude-code/claude-sonnet-5-5 |
