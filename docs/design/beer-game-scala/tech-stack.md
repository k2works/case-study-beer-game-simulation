---
type: Design
title: "技術スタック選定 - ビールゲームシミュレーション（Scala 版）"
description: "Scala 版の技術スタック。Maven Central で確認した版、確認できなかった項目、beer-game-kotlin からの変更、新規の依存関係の承認表、設計判断 ST1〜ST9（ST9 はローカル開発の H2 というユーザーの決定）、H2 の導入承認・カバレッジのしきい値などの未決事項を整理した正本。"
tags: [design]
status: draft
generated: { by: claude-code/claude-sonnet-5-5, at: 2026-11-25T06:10:00Z }
---

# 技術スタック選定 - ビールゲームシミュレーション（Scala 版）

## 概要

本書は、beer-game-scala の技術スタックを、版とあわせて一覧にします。**`docs/` を設計の正本**とします。実装コードはまだ存在せず（アプリの置き場は `apps/beer-game-scala` を予定する）、本書の版は**選定の記録**です。

[beer-game-kotlin の技術スタック](../beer-game-kotlin/tech-stack.md) を出発点に、[ADR-001](../../adr/beer-game-scala/001-scala-version-of-beer-game-kotlin.md) の決定に従って次の方針で改訂しました。

- バックエンドは **Scala 3（インデント構文）+ sbt + Cats / Cats Effect + http4s + doobie** に変更する。フロントエンドは、既存の React / TypeScript を踏襲し、`beer-game-web` と `beer-game-contracts` を共有する（変更なし）。
- アーキテクチャは**イベントソーシング + CQRS**（beer-game-kotlin を正本とする）。コーディングは [関数型プログラミングガイド（Scala 編）](../../reference/関数型プログラミングガイド_Scala編.md)（以下「ガイド」）に準拠する。
- **版は、2026-11-25 に Maven Central で確認できた値だけ**を書く。確認できなかったものは「要確認」とする。**推測の版を事実として書かない。**
- 版は、実装の開始時に最新の安定版へ更新して固定する（`build.sbt` の版の宣言と sbt の `dependencyLock` 相当の運用は B1 で決める）。
- 新しく導入する依存関係は、**導入時に承認を得る**（プロジェクトの規約）。
- 開発環境は `nix develop .#scala`（`ops/nix/environments/scala/shell.nix`。`scala_3`・`sbt`・`metals`・`scala-cli` を含む）。

### 確認の方法と範囲

| 区分 | 確認の手段 | 確認日 |
| :--- | :--- | :--- |
| ライブラリ・sbt プラグインの版 | Maven Central の `maven-metadata.xml`（`repo1.maven.org/maven2/<group>/<artifact>/maven-metadata.xml`）の版の一覧。**公開日（更新日）と安定版か否かは、版の文字列（`-RC`・`-M`）から判断した** | 2026-11-25 |
| 実行できるか | ローカルの sbt 1.13.1（JetBrains Runtime 25.0.4.1）で、Scala 3.7.4、WartRemover 3.6.3、cats-core 2.13.0、cats-effect 3.7.1、doobie-core 1.0.0-RC12、munit 1.3.6 の組み合わせの断片をコンパイルし、2 件のテストを通した | 2026-11-25 |
| Scala・WartRemover・Scalafix の対応 | ガイド §9.4 の確認（Scala 3.7.0、WartRemover 3.4.1、Scalafix 0.14.3、Scala CLI 1.7.1）を引用。本書の組み合わせ（Scala 3.7.4 + WartRemover 3.6.3）は上の断片で `var` と `head` を拒否することまで確認した。sbt-scalafix 0.14.10 の `DisableSyntax.regex`（`println`・`System.currentTimeMillis`）が、Scala 3 のインデント構文のソースで `Compile/scalafix --check` に効くことも確認した（[テスト戦略](./test-strategy.md) の確認した事項 9。`scalafixAll` と、`.transact(` の禁止・ファイル単位の除外は未確認） | 2026-11-17（ガイド）、2026-11-25 |
| 実 DB・テスト道具での確認 | doobie の `Left` での COMMIT と `FC.rollback`、制約名、アドバイザリロック、`LISTEN/NOTIFY`（[データモデル](./data-model.md) の検証 A）、scoverage、cucumber-scala、WartRemover のテスト除外など。**事項ごとの状況は、下の「確認状況の一覧」を唯一の正本とする**（他の文書はこの一覧へリンクする） | 2026-11-25 |
| PostgreSQL、JDK、Node.js、フロントエンド・インフラ・CI | 再確認していない。beer-game-kotlin（2026-11-14）と beer-game2（2026-11-09）の確認値を参照する | - |
| context7 | 使えなかった（API キーの検証に失敗。2026-11-25）。ライブラリの機能の確認には使っていない | - |

**Maven Central で分かるのは、版の番号と更新日だけ**です。サポート期限、機能、互換性（Scala の版と各ライブラリの組み合わせ）は分かりません。これらは「要確認」とし、実装開始時（B1）にビルドで確認します。

## 選定の方針

- **ドメインは副作用のない関数と型で書く。** 失敗は `Either` と `enum` のエラー、独立な検証は `ValidatedNec` と `mapN`。不正な状態は型で作れなくする（`opaque type`、`enum`）。
- **DB は doobie で直接 SQL を書く。** ORM は使わない（beer-game-kotlin の JDBC 直接と同じ方針）。doobie は SQL の組み立てを `ConnectionIO` の値にする道具で、ORM ではない。
- **副作用は `IO` と `ConnectionIO` の値で表し、実行は `IOApp` とテストの境界だけ**にする（ガイド §4.2、§7.9）。
- **層の境界は sbt のプロジェクトで守る。** beer-game-kotlin の Gradle のモジュールに対応する（ADR-001 の表、007）。
- **API の契約は、`apps/beer-game-contracts/openapi.yaml`（手書き）を共有する。**
- 依存関係は少なく保つ。**標準・既存の依存で足りるものは足さない**（メトリクスは EMF の JSON を自前で出す。`LogRecord` と `LogSink` を自前で持つ。ガイド §7.8、§10.1）。

## 確認した重要な事項

| # | 事項 | 確認結果（2026-11-25） | 判断 |
| :--- | :--- | :--- | :--- |
| 1 | Scala 3 | Maven Central の `scala3-compiler_3` の最新の安定版は **3.10.1**。3.7 系の最新は **3.7.4**。ガイドの Zettai 版は 3.3.9（3.3 系が存在することを確認）、ガイド §9.4 の確認版は 3.7.0 | **3.7.4** を第一候補（ガイドの確認版と同じ 3.7 系のパッチ更新）。3.10.1 には上げない理由: ガイドの確認が 3.7.0 までで、WartRemover は Scala の版ごとの成果物を持つ（3.10.1 用は 3.6.3 のみ確認）。**上げるなら、ガイド §9.4 の確認用コードを再実行する**。JDK との組み合わせは要確認 |
| 2 | sbt | `sbt` の Maven Central の最新は **2.1.1**、1 系の最新は **1.13.1** | **1.13.1**。sbt 2 は、使うプラグイン（sbt-scoverage・sbt-wartremover・sbt-scalafmt・sbt-scalafix）の対応が未確認のため採らない（ST1） |
| 3 | JDK | beer-game-kotlin の確認は **JDK 25（LTS、Temurin、EOL 2031-09-30。endoflife.date、2026-11-14）**。本書の検証は JetBrains Runtime 25.0.4.1 | **JDK 25（Temurin）** を第一候補（再確認していない）。Nix の開発シェルは JDK を指定しておらず、`scala_3` の版も未確認（要確認。`scalaVersion` は sbt で固定し、Nix の `scala_3` は REPL と scala-cli 用とする） |
| 4 | cats-core | **2.13.0**（Maven Central の更新は 2025-01-20） | **2.13.0**。ドメインが依存する唯一の外部ライブラリ（ST3） |
| 5 | cats-effect | **3.7.1**（更新 2026-08-24） | **3.7.1** |
| 6 | fs2 | `fs2-core_3` の最新の安定版は **3.16.0** | **3.16.0**（SSE と通知の配信） |
| 7 | http4s | 1.0 系はマイルストーン（`1.0.0-M50`、更新 2026-11-20）のみで、**0.23 系の最新は 0.23.39**（`http4s-ember-server`、`http4s-circe`） | **0.23.39**（安定版）。1.0 のマイルストーンは採らない。ガイドの例（`HttpRoutes.of[IO]`、`Request`・`Response`）は 0.23 系の形と見込むが、**要確認** |
| 8 | doobie | `doobie-core_3` の最新は **1.0.0-RC12**（更新 2026-02-21）。`doobie-postgres`・`doobie-hikari` も **1.0.0-RC12** がある。ガイドの ADR-051 は **RC13** と記すが、**Maven Central の一覧に RC13 は無かった** | **1.0.0-RC12**。RC のため、更新のたびに変更の影響を確認する（アップグレード計画）。ガイドの RC13 の出所は未確認 |
| 9 | circe | `circe-core_3` の最新の安定版は **0.14.17**（0.15.0 はマイルストーン `M1`） | **0.14.17**（提案。ST6。ガイドは circe を試していない） |
| 10 | HikariCP | **7.1.0**（beer-game-kotlin と同じ。JDK 25 との組み合わせは Kotlin 版でビルドとテストが動作したことを引用） | **7.1.0**（`doobie-hikari` が使う版は要確認） |
| 11 | PostgreSQL JDBC | `org.postgresql:postgresql` の最新は **42.7.15** | **42.7.15**（beer-game-kotlin の確認値 42.7.14 から更新） |
| 11a | H2（ローカル開発用 DB。`com.h2database:h2`）、doobie-h2 | `h2` の `maven-metadata.xml` の `<release>` は **2.5.252**（`lastUpdated` 2026-09-26）。pom の `<licenses>` は **MPL 2.0 と EPL 1.0**。Kotlin 版の確認値（2.5.252、2026-11-14）と一致した。`org.tpolecat:doobie-h2_3` は **1.0.0-RC12**（更新 2026-02-21）があり、doobie-core と版が揃う。**公式のサポート期限（EOL）は確認できていない**。PostgreSQL モードで動く機能の範囲は、Scala 版では**未実測**（Kotlin 版の実測を引用するだけ） | **2.5.252**（第一候補。確認日 2026-11-25）。H2 の採用はユーザーの決定（2026-11-25）だが、**依存の導入は承認待ち**。doobie-h2 が要るかは設計で書く（ST9。`Transactor` は JDBC の `DataSource` や URL から作れるため、H2 の JDBC ドライバだけで足りる見込み。doobie-h2 の型の対応が要るかは B1 で確認する。**未確認**）。動作範囲は B1 の最初に実測して確定する |
| 12 | Flyway | `flyway-core` の最新は **13.13.0**。beer-game-kotlin の確認値は 13.12.2 | **13.12.2**（beer-game-kotlin と同じ。最新の 13.13.0 への更新は B1 で判断）。PostgreSQL 用のモジュールの名前は要確認 |
| 13 | munit | `munit_3` の最新は **1.3.6**（更新 2026-09-03） | **1.3.6** |
| 14 | munit-cats-effect | `munit-cats-effect_3` の最新の安定版は **2.2.1** | **2.2.1**（`IO` を返すテスト。要確認） |
| 15 | munit-scalacheck / ScalaCheck | `munit-scalacheck_3` **1.3.1**、`scalacheck_3` **1.20.0** | 採用（プロパティベーステスト。ガイドは入れていないが、週次計算の性質に要る。ST5） |
| 16 | cats-laws / discipline-munit | `cats-laws_3` **2.13.0**、`discipline-munit_3` **2.0.0** | 採用（代数構造の法則。ガイド §8.4 は全パターンの列挙で確かめた。ST5。要確認） |
| 17 | Testcontainers | `testcontainers-scala-postgresql_3` / `testcontainers-scala-munit_3` の最新は **0.44.1**（更新 2025-12-23）。Java 側の `org.testcontainers:postgresql` の 1 系の最新は 1.21.4（beer-game-kotlin は Java の 2.0.5 を使用） | **0.44.1**。`postgres:18.6` を `TestContainerForAll` で起動でき、`select version()` が `PostgreSQL 18` を含むことを確認した（2026-11-25。[一覧](#確認状況の一覧) の K12）。**依存する Java 側の Testcontainers の版は未確認**。使えなければ Java 版を直接使う（ガイド ADR-051 は doobie と Testcontainers を使った） |
| 18 | cucumber-scala | `cucumber-scala_3` の最新は **9.3.0** | **9.3.0**（ST7。`# language: ja` の `.feature` が `io.cucumber.core.cli.Main` で実行できることを確認した（2026-11-25。[一覧](#確認状況の一覧) の K14）。別の sbt プロジェクトからの実行は未確認） |
| 19 | log4cats / Logback | `log4cats-slf4j_3` **2.8.0**、`logback-classic` **1.6.8**（beer-game-kotlin は 1.6.6） | **log4cats-slf4j 2.8.0**、**logback-classic 1.6.8**（http4s と HikariCP と Flyway のフレームワークのログの出力先。ST8。要確認） |
| 20 | Scalafmt | `scalafmt-core` の最新は **3.11.5**。`sbt-scalafmt` の最新は **2.6.2** | **3.11.5**、**2.6.2** |
| 21 | WartRemover | ガイドの確認版は 3.4.1。Maven Central の `sbt-wartremover` の最新は **3.6.3**。Scala 3.7.4 用の `wartremover_3.7.4` は **3.6.2・3.6.3** が存在 | **3.6.3**（本書の断片で `var`・`head` の拒否を確認）。ガイドの 3.4.1 と Wart の名前・メッセージが同じかは**要確認**（ガイド §9.4 の「版に依存する」） |
| 22 | Scalafix | ガイドの確認版は 0.14.3（`scalafix-cli_2.13.16` の最新が 0.14.3）。`sbt-scalafix` の最新は **0.14.10** | **sbt-scalafix 0.14.10**。`DisableSyntax.regex` が Scala 3 のインデント構文のソースに効くことを確認した（2026-11-25。[一覧](#確認状況の一覧) の K15）。`scalafix-cli` の版との関係と、`.transact(` の禁止・ファイル単位の除外は B1 で確認 |
| 23 | scoverage | `sbt-scoverage` の最新は **2.4.4** | **2.4.4**（ST4。Scala 3.7.4 で文と分岐の率が出ることを確認した。**行の率は出ない**。[一覧](#確認状況の一覧) の K16） |
| 24 | PostgreSQL | beer-game-kotlin の確認では 18（18.7、EOL 2030-11-14） | **PostgreSQL 18**。**本書では再確認していない** |
| 25 | Node.js（フロントエンドのビルド・テスト用） | beer-game2 の確認では Node 26 LTS | **Node 26 LTS** を、フロントエンドのビルドと E2E にだけ使う。**本書では再確認していない** |

## 確認状況の一覧

**この表が、Scala 版の設計書で「確認済み」「未確認」を書く唯一の正本です**（2026-11-25 のレビュー指摘 H1 への対応。承認済みの判断ではなく、AI の案）。他の文書は、この一覧にリンクします（`./tech-stack.md#確認状況の一覧`）。事項ごとに、確認した場合は「何で・いつ」を書き、確認していない場合は「未確認」の欄に書きます。**確認していないことを確認済みに直さず、確認結果を作りません。** 一覧と本文が食い違ったときは、一覧を正とし、本文を直します。

「確認済み」の根拠は、特記がなければ、リポジトリの外の使い捨てのプロジェクト（sbt 1.13.1、JetBrains Runtime 25.0.4.1、Scala 3.7.4、doobie 1.0.0-RC12、ローカルの Docker の `postgres:18.6`。**リポジトリには残していない**）での実行です。再現の手順と結果は、各行の参照先にあります。

| ID | 事項 | 確認済み（何で・いつ） | 未確認 | 参照 |
| :--- | :--- | :--- | :--- | :--- |
| K1 | ライブラリ・sbt プラグインの版 | Maven Central の `maven-metadata.xml` の版の一覧（2026-11-25）。分かるのは版の番号と更新日だけ | サポート期限、機能、Scala の版との互換性（B1 のビルドで確認） | 上の「確認の方法と範囲」 |
| K2 | 型の断片のコンパイル | Scala 3.7.4、cats-core 2.13.0、cats-effect 3.7.1、doobie-core 1.0.0-RC12、munit 1.3.6 の組み合わせで、`-Werror -Wunused:all -Wvalue-discard -Wnonunit-statement` と WartRemover 3.6.3（ガイド §9.4 の 13 個）を有効にしてコンパイル（2026-11-25） | 下の K4・K7 | [ドメインモデル](./domain-model.md)、[バックエンドアーキテクチャ](./architecture-backend.md) |
| K3 | ドメインの断片（`Quantity`、`RoleMap`、`ValidatedNec` による設定の検証、`GameError.code`、`Game.handle`、`Events.apply` と `Evolution`、`replay`） | 上のコンパイルと、2 件のテスト（設定の誤りが 3 件集まる、付け替えが 2 イベントになる）が通ること。状態を 1 つ足すと `match` の網羅の警告が出ること。`var` と `head` が WartRemover に拒否されること（2026-11-25） | 2026-11-25 のレビュー対応で書き直した `Game.handle`（権限が先の判定順）と `Started` の自己遷移は、**再コンパイルしていない** | [ドメインモデル](./domain-model.md) |
| K4 | Session 集約、`startGame`、`simulateWeek`、投影、`RetentionSaga`、`Functor[RoleMap]`・`Monoid[TeamTotals]` の法則 | - | すべて型検査していない設計のスケッチ。法則のテストは書いていない | [ドメインモデル](./domain-model.md) |
| K5 | `ConnectionIO` が `Left` を返して完了したときの COMMIT と、`FC.rollback` | doobie の `transact` は、値が `Left` でも **COMMIT する**。`FC.rollback` を挟むと、その書き込みは**残らない**（実 PostgreSQL 18.6、縮小した DDL、2026-11-25） | `FC.rollback` の**後**に同じ `ConnectionIO` で書き込みが続いたときの扱い（JDBC の仕様から、新しいトランザクションとして COMMIT されると**推論**した。実行していない。B1 で確かめる） | [データモデル](./data-model.md) の検証 A の 2 |
| K6 | `Tx` のトランザクション境界を DB なしで検証する方法 | `Transactor.fromConnection[IO](stub, None)` に、呼び出しを記録する `java.sql.Connection` のスタブを渡すと、**成功は `commit` だけ（`rollback` なし）**、**`Left` は `rollback` が呼ばれる**（記録は `setAutoCommit, rollback, commit`）。**旧案の `Tx.rollbackOnLeft` を単体で確かめたもの**（2026-11-25） | 新しい案の `Tx.run`（コマンド全体を 1 回で包む）での確認。`.transact(` を `Tx` の外に置くと CI が落ちること | [テスト戦略](./test-strategy.md) の確認した事項 8 |
| K7 | `execute` の再試行、キャンセル | `execute` の型のコンパイル（旧案の形） | 競合が 2 回続いても成功する、上限で `RetryExhausted`、業務の失敗は再試行しない、の実行。**キャンセル時の ROLLBACK と接続の返却**、`Supervisor` で切り離した `Fiber` の完了と追跡、**ember の切断時のハンドラの取消**とシャットダウンの待ち方、同じ `Idempotency-Key` の実行中の再送の待ち方 | [バックエンドアーキテクチャ](./architecture-backend.md) |
| K8 | 一意制約違反の判別 | `attemptSql` で `PSQLException` を取り出せ、SQLSTATE `23505` と制約名 `uq_events_stream_version`（`getServerErrorMessage.getConstraint`）が得られた（2026-11-25） | `doobie.postgres.sqlstate` の定数、40001・40P01・55P03 の写像、**23505 の後に同じ `ConnectionIO` で次の文を発行したときの PostgreSQL の中断（25P02）**（PostgreSQL の仕様の知識で、実行していない）、本番コードでの `PSQLException` の型の判定と WartRemover（`IsInstanceOf`・`AsInstanceOf`）の相性 | [データモデル](./data-model.md) の検証 A の 4 |
| K9 | 型の対応 | `uuid` ← `java.util.UUID`、`timestamptz` → `OffsetDateTime` と `Instant`（どちらも読めた）、`jsonb` は文字列 + `::jsonb` で書き `payload::text` で読める（2026-11-25） | `opaque type` の `Meta`・`Get`・`Put`、`Array[Byte]`（`bytea`）、circe による `jsonb` の読み書き（`doobie-postgres-circe` は技術スタックに無い）、`EventCodec` の派生 | [データモデル](./data-model.md) の検証 A の 3 |
| K10 | アドバイザリロック | `sql"select pg_advisory_xact_lock(42)".query[Unit].unique` と `pg_advisory_xact_lock_shared` が `ConnectionIO` として実行できた（2026-11-25） | **トランザクションの外の `Resource` として取る PostgreSQL 版**（専用の接続で `pg_advisory_lock(_shared)` を取り、解放で `pg_advisory_unlock` する形。セッションのロックの取得・解放・接続断での解放は実行していない）、`lock_timeout` の効き方 | [データモデル](./data-model.md) の検証 A の 5 |
| K11 | `LISTEN/NOTIFY` | `PHC.pgListen`・`PHC.pgNotify`・`PHC.pgGetNotifications`（`doobie.postgres.hi.connection`）で、**同じ接続**の通知を受け取れた（2026-11-25） | 別の接続・プールの外の専用の接続・切断後の再購読、fs2 の `Topic` が遅い購読者で発行側を止めるか | [データモデル](./data-model.md) の検証 A の 6 |
| K12 | テスト用の PostgreSQL | testcontainers-scala-postgresql・testcontainers-scala-munit 0.44.1 が `postgres:18.6` を `TestContainerForAll` で起動し、`select version()` が `PostgreSQL 18` を含んだ（2026-11-25） | 依存する Java 側の Testcontainers の版、用途別のロールと接続のテスト用の分離 | [テスト戦略](./test-strategy.md) の確認した事項 6 |
| K13 | テストの道具 | munit 1.3.6 の日本語・記号のテスト名と名前の絞り込み、JUnit XML。munit-scalacheck 1.3.1 の `property` と munit-cats-effect 2.2.1 の `IO` のテスト。cats-laws 2.13.0 + discipline-munit 2.0.0 の `MonoidTests`（`empty` を壊した実装が 4 件で落ちる）（2026-11-25） | ScalaCheck で状態に応じて操作を選ぶ操作列の生成、`HttpRoutes` を関数として呼ぶ HTTP のテスト、契約テストのスキーマ検証の道具 | [テスト戦略](./test-strategy.md) の確認した事項 1〜3 |
| K14 | cucumber-scala | 9.3.0 が `# language: ja`（`機能`・`シナリオ`・`前提`・`もし`・`ならば`）の `.feature` を `io.cucumber.core.cli.Main` で実行できる。タグも出る。定義のないステップは `Undefined` で終了コード 1（2026-11-25） | 別の sbt プロジェクト（`acceptance`）からの実行、シナリオの数が増えたときの動作 | [テスト戦略](./test-strategy.md) の確認した事項 5 |
| K15 | Scalafix | sbt-scalafix 0.14.10 + Scala 3.7.4 で、`DisableSyntax.regex`（`println`・`System.currentTimeMillis`）が `Compile/scalafix --check` で、インデント構文のソースの該当行を報告し、該当しない関数は報告しない（2026-11-25） | `scalafixAll`、`.transact(` を禁止して `Tx` のファイルだけ除外する方法、`domain` の `import` の禁止、`scalafix-cli` の版との関係 | [テスト戦略](./test-strategy.md) の確認した事項 9 |
| K16 | scoverage | sbt-scoverage 2.4.4（Scala 3.7.4）で `coverage test coverageReport` が**文**と**分岐**の率を出す（例: 87.50% と 75.00%）。Cobertura の `line-rate` は文の率と同じ値（0.88）で、**行の独立した指標ではない**。`coverageMinimumStmtTotal`・`coverageMinimumBranchTotal`・`coverageFailOnMinimum := true` が効き、分岐 75% < 80% で `Coverage minimum was not reached` になる（2026-11-25） | **scoverage の XML の文の行番号から行率を算出できるか**（ST4。B1 で確かめる）、プロジェクトごとのしきい値、`coverageAggregate`、統合テストの計測の合算、生成コード・`enum` の扱い | [テスト戦略](./test-strategy.md) の確認した事項 4、ST4 |
| K17 | WartRemover とテスト | 3.6.3 は既定で `Test` にも適用される。`Test / wartremoverErrors := Seq.empty` では外れず、**`Test / scalacOptions ~= (_.filterNot(_.startsWith("-P:wartremover")))` で外せる**。scalac のオプション（`-Werror` など）は、munit・ScalaCheck・discipline・`IO` の小さなテストにそのまま通った（2026-11-25） | 大きなコードでの `opaque type` との相性 | [テスト戦略](./test-strategy.md) の確認した事項 10・11 |
| K18 | DDL、ロールと GRANT（Rust 版・Kotlin 版の引用） | **引用**: Rust 版が PostgreSQL 18.6 で実測した追記専用の拒否、部分一意索引、権限のないロールでの連鎖削除、制約名（2026-11-19）。Kotlin 版 ADR-010 の連鎖削除の確認。**Scala 版で確認したのは `game_roots`・`events` の縮小した DDL の適用と、権限のあるユーザーでの連鎖削除だけ**（2026-11-25） | Scala 版の接続での全文の DDL、ロールと GRANT、権限のないロールでの確認（B1 の受入条件）、`NOLOGIN` ロールの設定の継承 | [データモデル](./data-model.md) |
| K19 | 永続化の周辺 | - | V003〜V006 の DDL の適用、Flyway の実行と PostgreSQL 用のモジュール名、`HikariTransactor` と用途別のロール（`SET ROLE`）、読み取り専用の `REPEATABLE READ` | [データモデル](./data-model.md) |
| K20 | http4s 0.23.39 | - | ルートの書き方、ミドルウェアの名前（CORS・Throttle・RequestId・ErrorHandling・HSTS）、`ServerSentEvent` の API。ガイドの例が 0.23 系で動くか | 上の「Ktor プラグインとの対応」 |
| K21 | H2（ローカル開発のみ） | 版 2.5.252 とライセンス（MPL 2.0・EPL 1.0）、`doobie-h2_3` 1.0.0-RC12 の存在を Maven Central で確認（2026-11-25） | **PostgreSQL モードの動作範囲**（アドバイザリロックの代替、`jsonb`、部分一意索引）、Flyway の H2 への適用、doobie 経由の SQLSTATE と制約名、`Left` の明示 ROLLBACK の H2 での動作、公式のサポート期限、JDK 25・Flyway 13.12.2 との組み合わせ。Kotlin 版の実測（H2 2.5.252、2026-11-14）を**引用するだけ** | ST9、[データモデル](./data-model.md) |
| K22 | 引用だけのもの | ガイド §9.4 の確認（Scala 3.7.0、WartRemover 3.4.1、Scalafix 0.14.3、Scala CLI 1.7.1。2026-11-17）。Kotlin 版の確認（PostgreSQL 18、JDK 25、2026-11-14）、beer-game2 の確認（Node 26、2026-11-09） | 本書の組み合わせでの再確認（PostgreSQL・JDK・Node.js・フロントエンド・インフラ・CI）。SIGTERM の終了コードと `IOApp` の既定の動作 | 上の「確認の方法と範囲」、[運用要件](./operation.md) |
| K23 | context7 | 使えなかった（API キーの検証に失敗。2026-11-25）。ライブラリの機能の確認には使っていない | - | 上の「確認の方法と範囲」 |

この一覧に載せていない検証は、**行っていない**ものとして扱います。B1 の最初のスライドで、K5・K7・K10・K11・K16・K20・K21 の未確認の部分を、システムレベルのテスト（切断・再送・SIGTERM を含む）で確かめます。前提が成り立たなければ、設計の見直しの条件（[バックエンドアーキテクチャ](./architecture-backend.md)）に従います。

## バックエンド

| カテゴリ | 技術 | 版 | beer-game-kotlin | 用途 | サポート期限 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| 言語 | Scala 3（インデント構文） | **3.7.4** | Kotlin 2.4.21 | ドメイン、アプリケーション、アダプター | 公式の期限は確認していない |
| 実行環境 | JDK（Eclipse Temurin） | **25（LTS）**（第一候補） | JDK 25 | API、保持の定期起動、マイグレーション | 2031-09-30（beer-game-kotlin の確認値。再確認していない） |
| ビルド | sbt | **1.13.1** | Gradle 9.9.1 | ビルド、テスト、静的解析、依存関係の固定 | - |
| 型クラス | cats-core | **2.13.0** | Arrow 2.3.0 | `Monoid`、`Functor`、`ValidatedNec`、`mapN`、`Kleisli` | - |
| 副作用・並行 | cats-effect | **3.7.1** | kotlinx.coroutines 1.11.0 | `IO`、`Ref`、`Resource`、`IOApp`、`Supervisor`、`Fiber` | - |
| ストリーム | fs2-core | **3.16.0** | `Flow`（coroutines） | SSE の配信、通知の受信、`Stream[IO, A]` | - |
| Web フレームワーク | http4s（`http4s-ember-server`、`http4s-dsl`、`http4s-circe`） | **0.23.39** | Ktor 3.6.1 | REST API、SSE。ルートは `HttpRoutes[IO]` | - |
| DB アクセス | doobie（`doobie-core`、`doobie-postgres`、`doobie-hikari`） | **1.0.0-RC12** | JDBC + HikariCP | `ConnectionIO`、直接の SQL（`sql"..."`）、`Transactor`、PostgreSQL の通知・型 | - |
| 接続プール | HikariCP（`doobie-hikari` 経由） | **7.1.0**（要確認） | HikariCP 7.1.0 | 用途別のプール（書き込み・読み取り・観察者）。**ガイドは入れていない**（ST8） | - |
| DB ドライバ | PostgreSQL JDBC | **42.7.15** | 42.7.14 | PostgreSQL への接続 | - |
| DB ドライバ（ローカル開発のみ） | H2（`com.h2database:h2`）。**開発用。導入は承認待ち** | **2.5.252**（第一候補。確認日 2026-11-25） | 2.5.252 | 開発機で Docker なしに起動するための DB（PostgreSQL モード）。本番・ステージング・CI・統合テストでは使わない（ST9）。sbt の依存は**開発用の構成だけ**に置き、本番のイメージに入れない（インフラ）。doobie-h2 の要否は B1 で確認（**未確認**） | - |
| マイグレーション | Flyway（`flyway-core` と PostgreSQL 用） | **13.12.2** | Flyway 13.12.2 | 番号つきの SQL マイグレーションと履歴 | - |
| シリアライズ | circe（`circe-core`、`circe-parser`。`http4s-circe`） | **0.14.17**（提案） | kotlinx.serialization | API の JSON と、イベントの `payload`（`event_type` を判別子にした DTO）。変換は `EventCodec` | - |
| 入力検証 | 自前のスマートコンストラクタ + `ValidatedNec` と `mapN` | cats-core に含む | `zipOrAccumulate` | 境界の検証、誤りを集める（[ドメインモデル](./domain-model.md)） | - |
| ログ | `LogRecord` の JSON を標準出力へ（自前）。フレームワークのログは log4cats-slf4j + Logback | log4cats **2.8.0**、Logback **1.6.8** | `LogRecord` + Logback 1.6.6 | 構造化ログ。`LogRecord` に表示名・資格の項目を**持たせない**（型で漏れを防ぐ。ガイド §7.8） | - |
| メトリクス | CloudWatch EMF（JSON 形式） | 依存関係なし | 同左 | 応答時間、競合、再試行、確定など | - |

AWS SDK は、キューを持たない設計のため、**依存関係に含めません**（beer-game-kotlin と同じ）。

### beer-game-kotlin の Ktor プラグインとの対応

候補の名前は、http4s 0.23 系の中から思い出した名前を含み、**採用する版での存在と API は要確認**です。

| beer-game-kotlin | Scala 版（候補。いずれも要確認） |
| :--- | :--- |
| `ktor-server-cors` | `org.http4s.server.middleware.CORS`（許可しない設定） |
| `ktor-server-rate-limit` | `Throttle` 相当のミドルウェア、または自前。参加・復帰・招待の専用の制限は DB の窓（ADR-017） |
| `ktor-server-default-headers`、`ktor-server-hsts` | 自前のミドルウェア（CSP、`nosniff`、Referrer-Policy、HSTS）。`HSTS` ミドルウェアの有無は要確認 |
| `ktor-server-call-logging`、`ktor-server-call-id` | `RequestId` と自前の `LogRecord` を出すミドルウェア |
| `ktor-server-sse` | http4s の `ServerSentEvent` と `Stream[IO, ServerSentEvent]` の応答（0.23.39 での API は要確認） |
| `ktor-server-status-pages` | `ErrorHandling` と、`AppFailure` を problem+json に写す関数（`match` の網羅） |
| Cookie の扱い | 自前に設定する（`HttpOnly`、`Secure`、`SameSite=Strict`） |

## データストア

| カテゴリ | 技術 | 版 | beer-game-kotlin | 用途 | サポート期限 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| RDBMS | PostgreSQL | **18**（RDS、CI、統合テスト、ステージング、本番。ローカル開発だけ下の H2 を選べる） | 18 | **イベントストア**、投影、周辺ストア、保持削除の状態 | beer-game-kotlin の確認値は 2030-11-14（再確認していない） |
| スキーマ管理 | Flyway | 13.12.2 | Flyway | 履歴テーブルで管理。拡張 → 互換 → 縮小 | - |
| ORM | なし | - | なし | 直接の SQL（doobie） | - |
| イベントのペイロード | `jsonb` + circe | - | `jsonb` + kotlinx.serialization | `schema_version` とアップキャスト（データモデルは別文書） | - |
| ローカル開発用 DB | **H2（PostgreSQL モード）**（ユーザーの決定、2026-11-25。ST9。導入は承認待ち） | **2.5.252**（第一候補） | H2（PostgreSQL モード） | **開発機での起動・動作確認だけ**。PostgreSQL 固有の機能は、ポート（`ProjectionLock`、`ChangeNotifier`）の H2 版で代える。省略した制約はローカルで守られない（[データモデル](./data-model.md)、[バックエンドアーキテクチャ](./architecture-backend.md)） | 公式のサポート期限は確認できていない |

イベントストアの専用製品（EventStoreDB など）は、**導入しません**（ST3。beer-game-kotlin の T1 を引き継ぐ）。**H2 は、統合テスト・CI・受け入れ・ステージング・本番に使いません**（ST9）。

## フロントエンド

既存の React / TypeScript を踏襲します。版は beer-game-kotlin の [技術スタック](../beer-game-kotlin/tech-stack.md) と [フロントエンド](../beer-game-kotlin/architecture-frontend.md) に従い、**本書では再確認していません**。実装開始時に最新の安定版へ更新します。API の型は、手書きの `openapi.yaml` から生成する方針を引き継ぎます。バックエンドの言語が Scala に変わっても、契約が変わらなければ、フロントエンドと E2E は変わりません。

## テスト・品質

| カテゴリ | 技術 | 版 | beer-game-kotlin | 用途 |
| :--- | :--- | :--- | :--- | :--- |
| 単体・振る舞い | munit + munit-cats-effect（テスト名と構成で Given / When / Then を表す） | **1.3.6**、**2.2.1** | Kotest 6.2.7 | 純粋関数、`handle`・`Events.apply`、`IO` を返すテスト |
| プロパティベース | munit-scalacheck（ScalaCheck） | **1.3.1**、**1.20.0** | Kotest Property | 週次計算の不変条件、イベントの再生 |
| 代数構造の法則 | cats-laws + discipline-munit | **2.13.0**、**2.0.0**（`MonoidTests` の動作は確認済み。K13） | （なし） | `Monoid`・`Functor` の法則。壊した実装を見分ける（ガイド §8.4） |
| 受入（Gherkin） | cucumber-scala | **9.3.0**（日本語 Gherkin の CLI での実行は確認済み。K14） | Cucumber-JVM 8.0.4 | 受入条件のシナリオ（`@US…` `@AC…` タグ）。`sbt test` には載せず、専用のジョブで実行（ST7） |
| 受入（経路の切り替え） | 関数値の `case class`（自前） | 依存なし | （なし） | 同じシナリオを、ドメイン直接・アプリケーション・HTTP の経路に流す（ガイド ADR-049） |
| 統合 | testcontainers-scala-postgresql、testcontainers-scala-munit | **0.44.1**（`postgres:18.6` の起動は確認済み。K12） | Testcontainers 2.0.5 | PostgreSQL 18 での統合テスト |
| HTTP | http4s のルートを関数として呼ぶ（`routes.orNotFound.run(Request[IO](...))`） | http4s に含む | ktor-server-test-host | API のテスト（サーバーを起こさない。ガイド §7.1） |
| 整形 | Scalafmt | **3.11.5**（`sbt-scalafmt` **2.6.2**） | ktlint 1.8.0 | CI で `scalafmtCheckAll` |
| コンパイラの検査 | scalac のオプション | `-Werror -Wunused:all -Wvalue-discard -Wnonunit-statement`（`-deprecation -feature` を含む） | detekt 1.23.8 の一部 | 警告をビルドの失敗にする。`enum` の `match` の漏れもここで止まる |
| 静的解析 | WartRemover | **3.6.3**（`sbt-wartremover`） | detekt 1.23.8、PMD 7.29.0 | `Var`・`Null`・`Throw`・`OptionPartial`・`TryPartial`・`EitherProjectionPartial`・`IterableOps`・`AsInstanceOf`・`IsInstanceOf`・`Return`・`MutableDataStructures`・`TripleQuestionMark`・`DefaultArguments`（ガイド §9.4 の 13 個）。テストのソースには `Test / scalacOptions` から `-P:wartremover` を除いて適用しない（確認済み。[一覧](#確認状況の一覧) の K17） |
| 静的解析 | Scalafix（`DisableSyntax`） | **sbt-scalafix 0.14.10**（`DisableSyntax.regex` は確認済み。K15）、CLI 0.14.3 | `ForbiddenMethodCall` | `println`、`System.currentTimeMillis`、`Thread.sleep`、**`.transact(` の直接の呼び出し（`Tx` のファイルだけ除外。ST4）**、ドメインでの時計・乱数・`IO` の `import` の禁止（文字列のパターン。限界はガイド §9.4） |
| カバレッジ | sbt-scoverage（scoverage） | **2.4.4** | Kover 0.9.11 | **行 80%（scoverage の XML の文の行番号から算出。ST4 の案 C）をゲート**にし、文 85%・分岐 75%（`coverageMinimum*`）を暫定の追加のゲートにする。scoverage 自体に行の指標は無い（確認済み。K16） |
| 契約テスト | JVM の JSON スキーマの検査ライブラリ（beer-game-kotlin は `json-schema-validator` 3.0.9）。`@redocly/cli`・`openapi-typescript` は共有 | 要確認 | json-schema-validator 3.0.9 | OpenAPI の応答の検査。**採否と版は未確認** |
| 依存関係の脆弱性検査 | **選定未決**（Kotlin 版と同じ） | 要確認 | **選定未決** | `sbt-dependency-check` などの候補は未確認。Dependabot または Renovate |
| 変異テスト | **選定未決** | 要確認 | **選定未決** | stryker4s などの候補は本書では確認していない |

## インフラ・運用

| カテゴリ | 技術 | Scala 版での扱い |
| :--- | :--- | :--- |
| クラウド | AWS（ap-northeast-1） | 同左 |
| コンテナ | Docker | ビルドは sbt のマルチステージ（`sbt-native-packager` などの採否は B1 で比較。**未確認**）。実行イメージは JDK 25 の JRE を含むもの（`eclipse-temurin:25-jre-noble` を第一候補。Kotlin 版は B3 で実在を確認した値。**本書では再確認していない**）。ローカルの DB は **H2 の PostgreSQL モード（Docker 不要。ST9）**。統合テストは Testcontainers の PostgreSQL 18 のため、テストの実行には Docker が要る |
| 実行基盤 | ECS Fargate | JVM のヒープと、タスクのメモリの割り当ては [非機能要件](./non-functional.md) で実測して決める |
| データベース | RDS for PostgreSQL 18（Multi-AZ、PITR） | 同左 |
| 配信・観測・IaC・CI | CloudFront、S3、ALB、CloudWatch、Terraform、GitHub Actions | 同左。CI のビルドは sbt。詳細は [インフラ](./architecture-infrastructure.md)、[運用要件](./operation.md) |
| CI の検査 | gitleaks、Trivy、Checkov（または同等のもの） | 同左 |
| ドキュメント | MkDocs、PlantUML、Mermaid | 同左 |

## 新しく導入する依存関係（導入時に承認を得る）

プロジェクトの規約により、新しい依存関係は導入時に承認を得ます。**本書の段階ではどれも導入していません。** 承認は、B1（ウォーキングスケルトン）の計画で、実際に使うものを確定してから求めます（Rust 版と同じ運用）。

| 区分 | 依存関係 | 状況 |
| :--- | :--- | :--- |
| 実行時（中核） | cats-core、cats-effect、fs2-core、http4s（ember-server・dsl・circe）、doobie（core・postgres・hikari）、circe、PostgreSQL JDBC、Flyway、log4cats-slf4j、logback-classic | 選定済み。承認待ち。circe（ST6）と doobie-hikari（ST8）は特に、ガイドが採らなかった・入れなかったものなので、承認の際に理由を確認する |
| 開発・テスト | munit、munit-cats-effect、munit-scalacheck、cats-laws、discipline-munit、testcontainers-scala、cucumber-scala | 選定済み。承認待ち。cucumber-scala は日本語対応の確認後 |
| sbt プラグイン・CI のツール | sbt-scalafmt、sbt-wartremover、sbt-scalafix、sbt-scoverage | 選定済み。承認待ち |
| ローカル開発用（開発用の構成だけ） | H2（`com.h2database:h2` 2.5.252。必要なら doobie-h2） | ユーザーの決定（2026-11-25。ST9）。**導入は承認待ち**。本番のイメージに入れない。ローカルも Docker の PostgreSQL 18 を使う案（Rust 版と同じ）が代替 |
| 候補（採否は設計時） | JSON スキーマの検査ライブラリ、`sbt-native-packager`、依存関係の脆弱性検査、変異テスト | 未決。確定してから承認を求める |

## 設計判断

**ST1〜ST8 は、AI が起草した案で、ユーザーの承認を得ていません**（Rust 版の R1〜R7 とは違う）。**ST9（ローカル開発の DB）だけは、ユーザーの決定（2026-11-25）**です。ただし H2 の依存の導入の承認、動作範囲の実測は残っています。2026-11-25 のレビュー対応で、ユーザーが決めたのは次の 4 点です。**H3**（不正な遷移 `Ignored` は止める設計を維持）、**H6**（カバレッジは行率を算出する案 C を第一）、**H7**（範囲は U1〜U3 を約束し、U4〜U6 は指標を見て決める）、**H9**（NF-P2 は p95 4 秒）。**H1・H2・H4・H5・H8・H10 の直し方（本書の確認状況の一覧、`Tx.run`、`.transact(` の禁止など）は AI の案で、承認を得ていません。** 承認の前提として、確認できなかった項目（互換性、機能）は B1 で確かめ、判断と食い違えば改訂します。beer-game-kotlin の T1〜T7 との対応は下の表のとおりです。

| ID | Kotlin 版（T*） | Scala 版 | 扱い |
| :--- | :--- | :--- | :--- |
| ST1 | T4 マイグレーション（Flyway）、ビルド（Gradle） | ビルドは sbt 1.13.1。マイグレーションは Flyway | **変更**（ビルドのみ）。T4 は引き継ぐ |
| ST2 | T2 Web フレームワーク（Ktor） | http4s 0.23.39（ember） | **変更** |
| ST3 | T1 イベントストアは PostgreSQL の `events` 表で自前 | 同じ。doobie で `events` への追記と読み出しを書く | **引き継ぐ** |
| ST4 | T5 静的解析、T6 カバレッジ | scalac のオプション + Scalafmt + WartRemover + Scalafix、scoverage | **置き換える** |
| ST5 | T3 テスト（Kotest + Testcontainers） | munit + ScalaCheck + cats-laws + Testcontainers | **置き換える** |
| ST6 | （kotlinx.serialization） | JSON は circe（提案） | **新規** |
| ST7 | ADR-012 の Gherkin | 日本語 Gherkin は契約として共有。cucumber-scala は別ジョブ。経路の切り替えは関数値 | **変更** |
| ST8 | HikariCP、Logback | doobie-hikari、log4cats-slf4j + Logback | **新規** |
| ST9 | T7 ローカルは H2 | ローカル開発だけ H2 の PostgreSQL モード（T7 を読み替えて**引き継ぐ**） | **引き継ぐ**（ユーザーの決定、2026-11-25） |

### ST1: ビルドは sbt 1.13.1（sbt 2 を採らない）

| 案 | 内容 | 評価 |
| :--- | :--- | :--- |
| **A（採用）** | sbt 1.13.1 | ガイドの Zettai 版の前提（`build.sbt`）。sbt-scoverage・sbt-wartremover・sbt-scalafmt・sbt-scalafix の最新の版が 1 系の成果物（`_2.12_1.0`）として存在することを確認した。本書の断片のビルドで、これらのうち sbt-wartremover と sbt-scalafmt と sbt-scoverage を読み込めることを確認した |
| B | sbt 2.1.1 | 新しい。使うプラグインが sbt 2 に対応しているかを確認していない（要確認） |
| C | Mill、Gradle（Scala プラグイン） | Nix のシェルに `sbt` がある。プロジェクトの方針（`ops/nix/environments/scala`）から外れる |

トレードオフ: A は sbt の旧系列。sbt 2 への移行は、プラグインの対応を確認してから別に判断する。

### ST2: Cats Effect + http4s + doobie（ガイドの道具）。ZIO・タグレスファイナルは採らない

ガイド §4〜§7 と、ガイド ADR-050・051 の道具の組である。ZIO + zio-http と Pekko HTTP は、ガイドの前提と合わないため採らない。fs2 は、ストリーム（SSE、通知）に使う（§4.5）。**http4s は 0.23.39 の安定版**（1.0 はマイルストーン）を採り、ガイドの例が 0.23 系で動くかを B1 で確認する。

### ST3: ドメインは cats-core だけに依存する

`domain` の `libraryDependencies` は `cats-core` だけとし、`cats-effect`・`doobie`・`http4s`・`circe` を持たない。Kotlin 版は「標準ライブラリと Arrow Core だけ」で、それに対応する。`ValidatedNec`・`mapN`・`Monoid`・`Functor` は cats-core にある。**依存を制限する検査の方式（sbt のタスクでクラスパスを検査するか、Scalafix の `DisableSyntax.regex` で `import cats.effect`・`import doobie` を禁止するか）は未確認**で、B1 で確かめる。

### ST4: 静的解析と整形は、scalac のオプションと WartRemover と Scalafix を厳格に適用する。カバレッジは scoverage

beer-game-kotlin の T5・T6 に対応し、ガイド第 9 章の設定を CI で必須にする。

- scalac: `-deprecation -feature -Werror -Wunused:all -Wvalue-discard -Wnonunit-statement`。`enum` の `match` の漏れ（本書の断片で、状態を 1 つ足すとパターンの網羅の警告が出ることを確認した）が、`-Werror` でビルドの失敗になる。
- WartRemover: ガイド §9.4 の 13 個の Wart を `Compile` に適用し、**テストのソースには適用しない**（ガイド §9.4「テストには適用しない」）。WartRemover 3.6.3 は既定で `Test` にも適用されるため、**`Test / scalacOptions ~= (_.filterNot(_.startsWith("-P:wartremover")))` で外す**（`Test / wartremoverErrors := Seq.empty` では外れない。確認済み、2026-11-25。[一覧](#確認状況の一覧) の K17）。**違反は 0 件、ベースラインなし、抑制なし**（Kotlin 版 ADR-011 の「抑制なし」を引き継ぐ。`@SuppressWarnings` は使わない。緩和が要るときは ADR に記録する。[ADR-001](../../adr/beer-game-scala/001-scala-version-of-beer-game-kotlin.md) の 011 の行）。層ごとに許す Wart が違う場合は、sbt のプロジェクトごとに設定を分ける（ガイド §9.4 の導入の進め方 3）。
- Scalafix: `DisableSyntax.regex` で `println`、`System.currentTimeMillis`・`nanoTime`、`Thread.sleep`、`unsafeRunSync` 系を禁止し、`domain` では時計・乱数・`java.util.UUID.randomUUID`・`scala.util.Random` と `cats.effect` の `import` も禁止する。`DisableSyntax.regex` が Scala 3 のインデント構文のソースに効くことは確認済み（K15）。文字列のパターンの限界（別名の `import` やラッパーの中の呼び出しは見逃す）は、ガイド §9.4 のとおり。
- **`.transact(` の禁止（H4。AI の案で、承認を得ていない）**: トランザクションの実行は `Tx.run`（[バックエンドアーキテクチャ](./architecture-backend.md) の SBD2）だけに限るため、`DisableSyntax.regex` で **`.transact(` の直接の呼び出しを禁止し、`Tx` を定義するファイルだけ除外する**。同じ regex に、別名（`xa.trans`・`rawTrans` など）も足す。**除外の方法（ファイル単位の設定か、`scalafix:off` の範囲指定か）は未確認**（K15）。最初のビルドの受入条件に、**「`Tx` を通さない `.transact(` を置くと CI が落ちる」**を入れる。
- Scalafmt: `scalafmtCheckAll` を CI で止める。
- **カバレッジのしきい値（ユーザーの決定、2026-11-25: 行率を算出する案 C を第一とする）**: beer-game-kotlin の Kover のゲートは、**全体の行 85%・分岐 75%、`domain` の行 100%（暫定の下限 97%）**である（[テスト戦略（Kotlin 版）](../beer-game-kotlin/test-strategy.md)。Kover の実測 96.8%・78.1% は B2 の値）。team.md の規約は**行 80% の floor**で、弱めて通してはならない。scoverage は**文（statement）と分岐（branch）**を計測し、**行の指標を持たない**（確認済み。K16）。
  - **第一案（C）**: scoverage の XML（`scoverage.xml`）の各文が持つ**行番号**から、行ごとの実行の有無を集計して**行率を算出**し、**行 80% をそのままゲート**にする（Rust 版が行 80% を承認済みのゲートにした先例 RT3 と同じ）。行の数え方（文を持つ行のうち、その行のいずれかの文が実行された行の割合、とする案）は B1 で決める。**算出できるかは未確認**で、B1 で確かめる。**出せなければ、文の率で代替してよいかを、再度人が決める**（AI は代替を採らない）。
  - **追加のゲート（暫定）**: 文 85%・分岐 75%（全体）と `domain` の文 97% を、scoverage の標準の設定（`coverageMinimumStmtTotal`・`coverageMinimumBranchTotal`・`coverageFailOnMinimum`。確認済み。K16）で、**暫定の追加のゲート**として残す。行 80% の代わりではなく、**行 80% と両方**を満たす。
  - **案 A（前の提案。第一にしない）の反例**: 「文 85% なら行 80% を満たすとみなす」は成り立たない。1 行に 9 文があって**その行だけ**が実行され、1 文だけの別の行が未実行なら、**文 90%・行 50%** になる。文の率が高くても、行の率は floor を下回りうる。
  - **行 80% の充足は、実測するまで主張しない。** いずれの値も**未実測の暫定値**で、最初の Bolt で実測して見直す。**プロジェクトごとのしきい値、複数プロジェクトと統合テストの合算**は未確認（K16）。

### ST5: テストは munit + ScalaCheck + cats-laws + Testcontainers

ガイドは munit と全パターンの列挙で足り、ScalaCheck を入れなかった（§8.3、§10.1）。beer-game-scala は、週次計算の不変条件（在庫・受注残が非負、出荷が利用可能量を超えない）を広い入力で守る必要があり、Kotlin 版・Rust 版もプロパティベーステストを持つため、munit-scalacheck を採る（**ガイドの方針からの変更**。導入の承認を得る）。代数構造の法則（`TeamTotals` の `Monoid`、`RoleMap` の `Functor`）は、cats-laws と discipline-munit か、ガイドの全パターンの列挙のどちらでも書ける。小さな範囲は後者で足りるため、**法則の道具は B1 で比較して決める**。

### ST6: JSON は circe（提案。未決）

ガイドは、JSON の木を自作した（ADR-052）。理由は「載せるものを型で決める方針」である。beer-game-scala は API の本文が多く、イベントの `payload` の相互変換（`EventCodec`）と、problem+json、`openapi.yaml` との一致検査が要るため、自作は割に合わないと判断し、http4s の標準的な組み合わせ（`http4s-circe`）の circe を提案する。**ドメインのイベントに codec を付けず、永続化・HTTP の DTO と相互変換する**（BD5）。派生（`derives`）を使うか手書きかは、`schema_version` とアップキャストの扱いやすさで B1 に決める。**ガイドが試していない道具のため、承認を得る**。代替の自作は、ガイド ADR-052 のとおり型で出力を限定できるが、パースの部分も要る。

### ST7: 受入は、日本語 Gherkin を契約として共有し、実行は関数値の経路とは別にする

ガイドは、cucumber-scala を「決定のあとで試して動いた（シナリオ 2 件）が `sbt test` には載せず、CLI で実行する確認用」とし、受け入れテストの本線は、関数値の `case class` で経路を差し替える方式にした（ADR-049）。Scala 版は、(a) Gherkin の `.feature` を beer-game-kotlin と共有し（`features/`）、(b) シナリオは cucumber-scala の専用のジョブで実行し、(c) 同じ受入条件を、munit の関数値の経路（ドメイン直接・アプリケーション・HTTP）でも確かめる。**`sbt test` に Cucumber を載せない**。日本語の Gherkin（`# language: ja`）は、cucumber-scala 9.3.0 が CLI で実行できることを**確認した**（2026-11-25。K14）。別の sbt プロジェクトからの実行は未確認で、B1 で確かめる。

### ST8: 接続プールは doobie-hikari（ガイドは入れていない）

ガイドは HikariCP を入れず、トランザクションごとに接続を開く（`Transactor.fromDriverManager`。§10.1）。beer-game-scala は、用途別の DB ロール（api の書き込み・読み取り・観察者、削除、migrate。ADR-009）ごとにプールを分け、接続数の上限と待ち時間を計測する必要があるため、`doobie-hikari` の `HikariTransactor`（`Resource`）を採る。**ガイドからの変更で、導入の承認を得る**。`LISTEN` の専用の接続は、プールの外に持つ（アーキテクチャ）。

### ST9: ローカル開発は H2 の PostgreSQL モード（ユーザーの決定、2026-11-25）

beer-game-kotlin の T7 を Scala 版に読み替えたものです。当初は「ローカルも PostgreSQL 18（Docker）のみ」を提案していましたが、ユーザーが「ローカル DB は Kotlin と同じく H2 で」と決定したため、提案を取り下げました。

| 案 | 内容 | 評価 |
| :--- | :--- | :--- |
| **A（採用）** | **ローカル開発（開発機での起動・動作確認）だけ**、H2 の PostgreSQL モード。統合テスト、CI、受け入れ、ステージング、本番は PostgreSQL 18（Testcontainers、RDS）のまま。PostgreSQL 固有の機能（アドバイザリロック、`LISTEN/NOTIFY`）はポート（`ProjectionLock`、`ChangeNotifier`）の裏に置き、PostgreSQL 版と H2 版を持つ（テスト用のインメモリ実装は、これとは別に維持する）。部分一意索引、DB ロールと GRANT、接続プールの分離、`jsonb` は PostgreSQL の統合テストでだけ検証する。H2 版のマイグレーションは Flyway のベンダー別の場所で、共通部分を最大化し差分だけを分ける（配置は B1 で確定） | Docker なしで起動でき、開発の初動が軽い。ただし、**H2 版では、省略した制約がローカルで守られず、単一プロセスの制約（プロセス内のロックとイベント）がある**。ローカルで通っても CI で落ちる乖離が起きうる |
| B | ローカルも PostgreSQL 18（Docker）のみ（Rust 版と同じ。当初の提案） | 環境が本番と同じで乖離がない。実装が 1 つで、契約テストを両実装で実行する維持費がない。Docker が要る。**ユーザーの決定により採らない** |
| C | H2 を統合テストにも使う | テストが速い。並行性・権限・部分一意索引・連鎖削除という設計の中核を検証できない。**却下**（設計の検証に H2 を使わない。Kotlin 版と同じ） |

トレードオフ: A は、開発の手軽さと引き換えに、ローカルと CI の乖離のリスクを持つ。対策は、(a) H2 でしか通らない記述を禁止し、PostgreSQL の統合テストを正とする、(b) ポートの契約テストを両実装で実行する（PostgreSQL 版は testcontainers-scala の統合テスト、H2 版は munit のユニットテスト）、(c) 受け入れ（`@api`）は PostgreSQL で実行する。

**選択と安全策**: 実行する DB は、設定（例: `DB_KIND=postgres|h2`）で選ぶ。**本番・ステージングで H2 が選ばれないよう、起動時の検査で、本番・ステージングの環境では H2 を拒否し、起動に失敗する**（[インフラ](./architecture-infrastructure.md)）。**H2 は本番イメージに含めない**（sbt の依存は開発用の構成だけに置く）。

**Rust 版との対比**: Rust 版は、「H2 は JVM の DB のため使えない」ことを理由に、ローカルも PostgreSQL 18（Docker）のみとした（[技術スタック（Rust 版）](../beer-game-rust/tech-stack.md)）。**Scala 版は JVM 上で動くため、H2 をプロセス内に組み込める**。この違いが、Kotlin 版と同じ判断を採れる根拠である。

**Scala 固有の論点**:

- **doobie**: `Transactor` は JDBC の接続元（URL・`DataSource`）から作れ、H2 でも使える。doobie-h2（1.0.0-RC12 が Maven Central にある）は H2 固有の型の対応を足すもので、**要るかは B1 で確認する（未確認）**。
- **明示 ROLLBACK（SBD2）**: `Left` でも COMMIT する doobie の挙動は PostgreSQL で確認した（K5）。H2 でも同じと見込むが**未確認**（K21）。**`Left` を返す経路は、H2 でも `Tx.run` で明示 ROLLBACK を行う**。
- **SQLSTATE**: 一意制約違反（23505）の取得は、doobie の `sqlstate` の抽出（`SqlState`）で行う。Kotlin 版は JDBC で H2 の 23505・23513・40001 を実測したが、**doobie 経由で H2 の SQLSTATE と制約名が取れるかは未確認**（B1 で実測）。制約名は、PostgreSQL では専用のフィールドから、H2 ではメッセージ中の名前から取る（Kotlin 版の実測の引用）。
- **確認状況**: [確認状況の一覧](#確認状況の一覧) の K21 を正とする。H2 の版（2.5.252）、ライセンス（MPL 2.0・EPL 1.0）は 2026-11-25 に Maven Central で確認した。**公式のサポート期限、PostgreSQL モードの動作範囲、JDK 25・Flyway 13.12.2 との組み合わせは、Scala 版では未確認**（Kotlin 版の実測を引用するのみ）。**H2 の導入（依存の追加）は承認待ち、動作範囲は B1 の最初に実測して確定する**。**`ProjectionLock` と `ChangeNotifier` は、H2 版と PostgreSQL 版が同じ型**（[バックエンドアーキテクチャ](./architecture-backend.md)。H5 の案）。

## beer-game-kotlin からの変更

| # | beer-game-kotlin | Scala 版 | 理由 |
| :--- | :--- | :--- | :--- |
| 1 | Kotlin 2.4.21（JVM） | Scala 3.7.4（JVM） | ユーザーの決定（作成計画） |
| 2 | Ktor | http4s | 同上 |
| 3 | 関数型の道具 Arrow（`Either`、`Raise`、`zipOrAccumulate`） | 標準の `Either`、cats-core の `ValidatedNec`・`mapN` | ガイド第 3・6 章。Scala の標準と Cats で足りる |
| 4 | 非同期 coroutines（`suspend`） | cats-effect の `IO`（値）。実行は `IOApp` とテストの境界 | ガイド第 4・5 章 |
| 5 | JDBC + HikariCP + Flyway | doobie（`ConnectionIO`）+ HikariCP（doobie-hikari）+ Flyway | ガイド §7.6 |
| 6 | Gradle のモジュール | sbt のプロジェクト | 言語・ビルドの違い |
| 7 | detekt、ktlint、PMD | scalac のオプション、Scalafmt、WartRemover、Scalafix | ガイド第 9 章 |
| 8 | Kover（行・分岐） | scoverage（文・分岐） | 計測の指標が違う（ST4） |
| 9 | Kotest | munit、ScalaCheck、cats-laws | ガイド第 8 章 |
| 10 | Cucumber-JVM（Gradle の `acceptanceTest`） | cucumber-scala（`sbt test` に載せない）+ 関数値の経路 | ガイド §10.1、ADR-049（ST7） |
| 11 | kotlinx.serialization | circe（提案。ST6） | JSON の道具 |
| 12 | 状態の版は `State.version`、`evolve` は版を進める | 版は永続化の層。`Evolution.Applied/Ignored`（[ドメインモデル](./domain-model.md) SD2） | 検知を直接にする（Rust 版 RD2 と同じ） |
| 13 | ローカルは H2（Kotlin 版の T7） | ローカルも H2 の PostgreSQL モード（ユーザーの決定、2026-11-25。導入は承認待ち） | ST9 |
| 14 | JDK 25（Temurin）の JRE | 同じ（JDK 25 を第一候補。要確認） | JVM 版 |
| 15 | 純粋性は detekt の `ForbiddenMethodCall` | WartRemover + Scalafix の `DisableSyntax` + `domain` の依存の制限（ST3） | ツールの違い |
| 16 | カバレッジのゲートは Kover の行 85%・分岐 75% | **行 80%（scoverage の XML の文の行番号から算出。案 C）をゲート**にし、文 85%・分岐 75% を暫定の追加のゲートにする（ST4）。行 80% の充足は実測まで主張しない | scoverage に行の指標が無い（K16）。ユーザーの決定（2026-11-25）。team.md の行 80% の floor を弱めない |
| 17 | `EventStore.transaction` が、ブロックが `Left` を返したら ROLLBACK する | `.transact(` の直接の呼び出しを Scalafix の `DisableSyntax.regex` で禁止し、`Tx.run` だけに限る（ST4）。AI の案 | doobie は `Left` でも COMMIT する（K5）ため、`Tx` を通さない実行を CI で止める |

## アップグレード計画

| 時期 | 対象 | 内容 |
| :--- | :--- | :--- |
| 実装の開始時（B1） | 全体 | 上の版を、ビルドで確認して固定する。**Scala 3.7.4 + sbt 1.13.1 + cats-effect 3.7.1 + http4s 0.23.39 + doobie 1.0.0-RC12 + circe 0.14.17 + munit 1.3.6 + WartRemover 3.6.3 + sbt-scalafix 0.14.10 + sbt-scoverage 2.4.4 の組み合わせを、最初のビルドで確認**する。本書で確認した範囲（Scala 3.7.4、sbt 1.13.1、cats-core、cats-effect、doobie-core、munit、WartRemover）を超える部分が対象 |
| 実装の期間中 | JDK | 25 のパッチ版のみ更新（LTS を維持） |
| doobie が 1.0 の安定版になった時 | doobie | RC から安定版へ。変更点を確認する |
| http4s が 1.0 の安定版になった時 | http4s | 0.23 系から 1.0 へ。破壊的変更を確認する（現在はマイルストーンのみ） |
| Scala を上げる時 | Scala 3 | ガイド §9.4 の確認用コードを、新しい版で再実行し、WartRemover の対応する版を確認する |
| sbt 2 の対応が揃った時 | sbt | プラグインの対応を確認してから別に判断する |
| 継続 | 依存パッケージ | メジャーの更新は、変更点を確認して小さく行う |

## 未決事項

1. **ローカル開発の DB**（ST9）: H2 の採用は決定済み（2026-11-25）。残る未決は、**H2 の依存の導入の承認**、**B1 の最初に行う動作範囲の実測**（アドバイザリロック、`LISTEN/NOTIFY`、部分一意索引、ロール、`jsonb`、SQLSTATE、doobie 経由の挙動）、doobie-h2 の要否、公式のサポート期限（未確認）。
2. **カバレッジのゲート**（ST4）: 行 80% を、scoverage の XML の文の行番号から算出してゲートにする案 C が第一（ユーザーの決定、2026-11-25）。**B1 で算出できるかを確かめる。出せなければ、文の率で代替してよいかを再度人が決める。** 文 85%・分岐 75%、`domain` 文 97% は暫定の追加のゲートで、**未実測**。設定名（`coverageMinimum*`）は確認済み（K16）。
3. **Scala と周辺の版の組み合わせ**: Scala 3.7.4 と WartRemover 3.6.3・sbt-scalafix 0.14.10・sbt-scoverage 2.4.4 の組み合わせは、小さな断片で動くことを確認した（K15〜K17）。大きなコードでの確認と、JDK 25 との組み合わせは未確認。
4. **doobie の RC13**: ガイドが記す 1.0.0-RC13 は、Maven Central の一覧に無かった。RC12 でガイドの例（`Transactor`、`ConnectionIO`、`Update`）が動くかは要確認。
5. **http4s 0.23.39 の API**: ガイドの例と、SSE（`ServerSentEvent`）、ミドルウェア（CORS・Throttle・RequestId・ErrorHandling など）の名前。
6. **JSON ライブラリ**（ST6）: circe を提案。派生か手書きか。**承認を得る**。
7. **cucumber-scala**（ST7）: 日本語 Gherkin の実行は確認済み（K14）。残る未決は、別の sbt プロジェクトからの実行と、Gherkin のファイルの共有の配置。
8. **Testcontainers**: `postgres:18.6` の起動は確認済み（K12）。残る未決は、`testcontainers-scala` 0.44.1 が依存する Java 側の版。
9. **依存の検査の方式**（ST3・ST4）: sbt のタスクか、Scalafix の `DisableSyntax.regex` か。`.transact(` の禁止と `Tx` のファイルの除外の方法も同じ検査の仕組みで行えるか（K15）。
10. **生きたドキュメントの生成方式**（ADR-001 の 018 の置き換え）: Scala 3 の注釈、`enum` のメタ情報、scaladoc の走査の比較。
11. **コンテナ**: 実行イメージ、`sbt-native-packager` の採否、JVM のヒープ（NF-P17 に対応）。
12. **選定未決（Kotlin 版から継続）**: 変異テストの道具、依存関係の脆弱性検査、Dependabot か Renovate か、生きたドキュメントの公開の道具。
13. **sbt 2 への移行の時期**（ST1）。
14. **Nix の開発シェル**: JDK の指定、`scala_3` の版（`scalaVersion` で固定するため、REPL と scala-cli 用）。
15. **JSON スキーマの検査ライブラリ、`@redocly/cli`、`openapi-typescript`** の版（フロントエンド側は共有。バックエンド側の契約テストの検査ライブラリは JVM の共有を見込むが要確認）。

## レビュー対応の記録（2026-11-25）

[設計書レビュー](../../review/beer-game-scala/design_review_20261125.md) への対応のうち、本書に関するもの（行番号は編集で動くため、節名で記録します）。**H6 の第一案（行率の算出）だけがユーザーの決定で、他の直し方は AI の案で、承認を得ていません。**

| 指摘 | 直した箇所 | 状況 |
| :--- | :--- | :--- |
| H1 | 新設の「確認状況の一覧」、「確認の方法と範囲」、確認した重要な事項の 17・18・22・23、ST7、未決事項の 2・3・7〜9 | AI の案 |
| H4 | ST4 の `.transact(` の禁止、テスト・品質の表の Scalafix の行、変更表の 17 | AI の案 |
| H6 | ST4 のカバレッジ（案 C を第一、反例、行 80% の充足は実測まで主張しない）、変更表の 16、未決事項の 2 | 第一案はユーザーの決定。算出できるかは未確認 |
| L5 | ST4 の WartRemover のテスト除外の設定、Scalafix の確認済みの範囲 | 直した |

## 出典

- Maven Central の `maven-metadata.xml`（`org.typelevel:cats-core_3`、`cats-effect_3`、`co.fs2:fs2-core_3`、`org.http4s:http4s-ember-server_3`・`http4s-circe_3`、`org.tpolecat:doobie-core_3`・`doobie-postgres_3`・`doobie-hikari_3`、`io.circe:circe-core_3`、`com.zaxxer:HikariCP`、`org.postgresql:postgresql`、`org.flywaydb:flyway-core`、`org.scalameta:munit_3`・`munit-scalacheck_3`・`scalafmt-core_2.13`・`sbt-scalafmt_2.12_1.0`、`org.typelevel:munit-cats-effect_3`・`discipline-munit_3`・`cats-laws_3`・`log4cats-slf4j_3`、`org.scalacheck:scalacheck_3`、`com.dimafeng:testcontainers-scala-*_3`、`io.cucumber:cucumber-scala_3`、`ch.qos.logback:logback-classic`、`org.scala-lang:scala3-compiler_3`、`org.scala-sbt:sbt`、`org.wartremover:wartremover_3.7.*`・`sbt-wartremover_2.12_1.0`、`ch.epfl.scala:scalafix-cli_2.13.16`・`sbt-scalafix_2.12_1.0`、`org.scoverage:sbt-scoverage_2.12_1.0`）、2026-11-25
- ローカルの sbt 1.13.1（JetBrains Runtime 25.0.4.1）での断片のコンパイルとテスト、2026-11-25
- [ADR-001（Scala 版）](../../adr/beer-game-scala/001-scala-version-of-beer-game-kotlin.md)
- [技術スタック（beer-game-kotlin）](../beer-game-kotlin/tech-stack.md)、[技術スタック（Rust 版）](../beer-game-rust/tech-stack.md)
- [関数型プログラミングガイド（Scala 編）](../../reference/関数型プログラミングガイド_Scala編.md) 第 3〜9 章、§10.1
- `ops/nix/environments/scala/shell.nix`
- [ドメインモデル（Scala 版）](./domain-model.md)、[バックエンドアーキテクチャ（Scala 版）](./architecture-backend.md)、[テスト戦略](./test-strategy.md)、[非機能要件](./non-functional.md)
