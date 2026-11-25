---
type: Design
title: "技術スタック選定 - ビールゲームシミュレーション（Scala 版）"
description: "Scala 版の技術スタック。Maven Central で確認した版、確認できなかった項目、beer-game-kotlin からの変更、新規の依存関係の承認表、設計判断 ST1〜ST9、ローカル DB・カバレッジのしきい値などの未決事項を整理した正本。"
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
| Scala・WartRemover・Scalafix の対応 | ガイド §9.4 の確認（Scala 3.7.0、WartRemover 3.4.1、Scalafix 0.14.3、Scala CLI 1.7.1）を引用。本書の組み合わせ（Scala 3.7.4 + WartRemover 3.6.3）は上の断片で `var` と `head` を拒否することまで確認した（`Scalafix` は未確認） | 2026-11-17（ガイド）、2026-11-25 |
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
| 12 | Flyway | `flyway-core` の最新は **13.13.0**。beer-game-kotlin の確認値は 13.12.2 | **13.12.2**（beer-game-kotlin と同じ。最新の 13.13.0 への更新は B1 で判断）。PostgreSQL 用のモジュールの名前は要確認 |
| 13 | munit | `munit_3` の最新は **1.3.6**（更新 2026-09-03） | **1.3.6** |
| 14 | munit-cats-effect | `munit-cats-effect_3` の最新の安定版は **2.2.1** | **2.2.1**（`IO` を返すテスト。要確認） |
| 15 | munit-scalacheck / ScalaCheck | `munit-scalacheck_3` **1.3.1**、`scalacheck_3` **1.20.0** | 採用（プロパティベーステスト。ガイドは入れていないが、週次計算の性質に要る。ST5） |
| 16 | cats-laws / discipline-munit | `cats-laws_3` **2.13.0**、`discipline-munit_3` **2.0.0** | 採用（代数構造の法則。ガイド §8.4 は全パターンの列挙で確かめた。ST5。要確認） |
| 17 | Testcontainers | `testcontainers-scala-postgresql_3` / `testcontainers-scala-munit_3` の最新は **0.44.1**（更新 2025-12-23）。Java 側の `org.testcontainers:postgresql` の 1 系の最新は 1.21.4（beer-game-kotlin は Java の 2.0.5 を使用） | **0.44.1** を第一候補。**これが依存する Java 側の Testcontainers の版と、PostgreSQL 18 のイメージの指定は要確認**。使えなければ Java 版を直接使う（ガイド ADR-051 は doobie と Testcontainers を使った） |
| 18 | cucumber-scala | `cucumber-scala_3` の最新は **9.3.0** | **9.3.0**（ST7。日本語 Gherkin の対応と、Scala 3 での動作は要確認。ガイドは「動いた（シナリオ 2 件）」と記す） |
| 19 | log4cats / Logback | `log4cats-slf4j_3` **2.8.0**、`logback-classic` **1.6.8**（beer-game-kotlin は 1.6.6） | **log4cats-slf4j 2.8.0**、**logback-classic 1.6.8**（http4s と HikariCP と Flyway のフレームワークのログの出力先。ST8。要確認） |
| 20 | Scalafmt | `scalafmt-core` の最新は **3.11.5**。`sbt-scalafmt` の最新は **2.6.2** | **3.11.5**、**2.6.2** |
| 21 | WartRemover | ガイドの確認版は 3.4.1。Maven Central の `sbt-wartremover` の最新は **3.6.3**。Scala 3.7.4 用の `wartremover_3.7.4` は **3.6.2・3.6.3** が存在 | **3.6.3**（本書の断片で `var`・`head` の拒否を確認）。ガイドの 3.4.1 と Wart の名前・メッセージが同じかは**要確認**（ガイド §9.4 の「版に依存する」） |
| 22 | Scalafix | ガイドの確認版は 0.14.3（`scalafix-cli_2.13.16` の最新が 0.14.3）。`sbt-scalafix` の最新は **0.14.10** | **sbt-scalafix 0.14.10**、CLI は **0.14.3** を第一候補。sbt プラグインの版と `scalafix-cli` の版の関係は要確認。Scala 3 のインデント構文の解析の指定（ガイド §9.4）は B1 で確認 |
| 23 | scoverage | `sbt-scoverage` の最新は **2.4.4** | **2.4.4**（ST4。Scala 3 での分岐の計測は要確認） |
| 24 | PostgreSQL | beer-game-kotlin の確認では 18（18.7、EOL 2030-11-14） | **PostgreSQL 18**。**本書では再確認していない** |
| 25 | Node.js（フロントエンドのビルド・テスト用） | beer-game2 の確認では Node 26 LTS | **Node 26 LTS** を、フロントエンドのビルドと E2E にだけ使う。**本書では再確認していない** |

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
| RDBMS | PostgreSQL | **18**（RDS、CI、統合テスト、ステージング、本番、**ローカル**） | 18 | **イベントストア**、投影、周辺ストア、保持削除の状態 | beer-game-kotlin の確認値は 2030-11-14（再確認していない） |
| スキーマ管理 | Flyway | 13.12.2 | Flyway | 履歴テーブルで管理。拡張 → 互換 → 縮小 | - |
| ORM | なし | - | なし | 直接の SQL（doobie） | - |
| イベントのペイロード | `jsonb` + circe | - | `jsonb` + kotlinx.serialization | `schema_version` とアップキャスト（データモデルは別文書） | - |
| ローカル開発用 DB | **PostgreSQL 18（Docker）**（提案。ST9） | 18 | H2（PostgreSQL モード） | 開発機での起動・動作確認 | - |

イベントストアの専用製品（EventStoreDB など）は、**導入しません**（ST3。beer-game-kotlin の T1 を引き継ぐ）。

## フロントエンド

既存の React / TypeScript を踏襲します。版は beer-game-kotlin の [技術スタック](../beer-game-kotlin/tech-stack.md) と [フロントエンド](../beer-game-kotlin/architecture-frontend.md) に従い、**本書では再確認していません**。実装開始時に最新の安定版へ更新します。API の型は、手書きの `openapi.yaml` から生成する方針を引き継ぎます。バックエンドの言語が Scala に変わっても、契約が変わらなければ、フロントエンドと E2E は変わりません。

## テスト・品質

| カテゴリ | 技術 | 版 | beer-game-kotlin | 用途 |
| :--- | :--- | :--- | :--- | :--- |
| 単体・振る舞い | munit + munit-cats-effect（テスト名と構成で Given / When / Then を表す） | **1.3.6**、**2.2.1** | Kotest 6.2.7 | 純粋関数、`handle`・`Events.apply`、`IO` を返すテスト |
| プロパティベース | munit-scalacheck（ScalaCheck） | **1.3.1**、**1.20.0** | Kotest Property | 週次計算の不変条件、イベントの再生 |
| 代数構造の法則 | cats-laws + discipline-munit | **2.13.0**、**2.0.0**（要確認） | （なし） | `Monoid`・`Functor` の法則。壊した実装を見分ける（ガイド §8.4） |
| 受入（Gherkin） | cucumber-scala | **9.3.0**（日本語対応・Scala 3 は要確認） | Cucumber-JVM 8.0.4 | 受入条件のシナリオ（`@US…` `@AC…` タグ）。`sbt test` には載せず、専用のジョブで実行（ST7） |
| 受入（経路の切り替え） | 関数値の `case class`（自前） | 依存なし | （なし） | 同じシナリオを、ドメイン直接・アプリケーション・HTTP の経路に流す（ガイド ADR-049） |
| 統合 | testcontainers-scala-postgresql、testcontainers-scala-munit | **0.44.1**（要確認） | Testcontainers 2.0.5 | PostgreSQL 18 での統合テスト |
| HTTP | http4s のルートを関数として呼ぶ（`routes.orNotFound.run(Request[IO](...))`） | http4s に含む | ktor-server-test-host | API のテスト（サーバーを起こさない。ガイド §7.1） |
| 整形 | Scalafmt | **3.11.5**（`sbt-scalafmt` **2.6.2**） | ktlint 1.8.0 | CI で `scalafmtCheckAll` |
| コンパイラの検査 | scalac のオプション | `-Werror -Wunused:all -Wvalue-discard -Wnonunit-statement`（`-deprecation -feature` を含む） | detekt 1.23.8 の一部 | 警告をビルドの失敗にする。`enum` の `match` の漏れもここで止まる |
| 静的解析 | WartRemover | **3.6.3**（`sbt-wartremover`） | detekt 1.23.8、PMD 7.29.0 | `Var`・`Null`・`Throw`・`OptionPartial`・`TryPartial`・`EitherProjectionPartial`・`IterableOps`・`AsInstanceOf`・`IsInstanceOf`・`Return`・`MutableDataStructures`・`TripleQuestionMark`・`DefaultArguments`（ガイド §9.4 の 13 個） |
| 静的解析 | Scalafix（`DisableSyntax`） | **sbt-scalafix 0.14.10**、CLI 0.14.3（要確認） | `ForbiddenMethodCall` | `println`、`System.currentTimeMillis`、`Thread.sleep`、ドメインでの時計・乱数・`IO` の `import` の禁止（文字列のパターン。限界はガイド §9.4） |
| カバレッジ | sbt-scoverage（scoverage） | **2.4.4** | Kover 0.9.11 | 文と分岐の計測としきい値（ST4）。**行の指標は無い**（要確認） |
| 契約テスト | JVM の JSON スキーマの検査ライブラリ（beer-game-kotlin は `json-schema-validator` 3.0.9）。`@redocly/cli`・`openapi-typescript` は共有 | 要確認 | json-schema-validator 3.0.9 | OpenAPI の応答の検査。**採否と版は未確認** |
| 依存関係の脆弱性検査 | **選定未決**（Kotlin 版と同じ） | 要確認 | **選定未決** | `sbt-dependency-check` などの候補は未確認。Dependabot または Renovate |
| 変異テスト | **選定未決** | 要確認 | **選定未決** | stryker4s などの候補は本書では確認していない |

## インフラ・運用

| カテゴリ | 技術 | Scala 版での扱い |
| :--- | :--- | :--- |
| クラウド | AWS（ap-northeast-1） | 同左 |
| コンテナ | Docker | ビルドは sbt のマルチステージ（`sbt-native-packager` などの採否は B1 で比較。**未確認**）。実行イメージは JDK 25 の JRE を含むもの（`eclipse-temurin:25-jre-noble` を第一候補。Kotlin 版は B3 で実在を確認した値。**本書では再確認していない**）。ローカルの DB は Docker の PostgreSQL 18 |
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
| 候補（採否は設計時） | JSON スキーマの検査ライブラリ、`sbt-native-packager`、依存関係の脆弱性検査、変異テスト | 未決。確定してから承認を求める |

## 設計判断

**ST1〜ST9 は、AI が起草した案で、ユーザーの承認を得ていません**（Rust 版の R1〜R7 とは違う）。承認の前提として、確認できなかった項目（互換性、機能）は B1 で確かめ、判断と食い違えば改訂します。beer-game-kotlin の T1〜T7 との対応は下の表のとおりです。

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
| ST9 | T7 ローカルは H2 | ローカルは PostgreSQL のみ | **見直す**（提案） |

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
- WartRemover: ガイド §9.4 の 13 個の Wart を `Compile` に適用し、**テストのソースには適用しない**（ガイド §9.4「テストには適用しない」）。**違反は 0 件、ベースラインなし、`@SuppressWarnings` を理由なしに使わない**。層ごとに許す Wart が違う場合は、sbt のプロジェクトごとに設定を分ける（ガイド §9.4 の導入の進め方 3）。
- Scalafix: `DisableSyntax.regex` で `println`、`System.currentTimeMillis`・`nanoTime`、`Thread.sleep`、`unsafeRunSync` 系を禁止し、`domain` では時計・乱数・`java.util.UUID.randomUUID`・`scala.util.Random` と `cats.effect` の `import` も禁止する。文字列のパターンの限界（別名の `import` やラッパーの中の呼び出しは見逃す）は、ガイド §9.4 のとおり。
- Scalafmt: `scalafmtCheckAll` を CI で止める。
- **カバレッジのしきい値（未決の解消案）**: beer-game-kotlin の Kover のゲートは、**全体の行 85%・分岐 75%、`domain` の行 100%（暫定の下限 97%）**である（[テスト戦略（Kotlin 版）](../beer-game-kotlin/test-strategy.md)。Kover の実測 96.8%・78.1% は B2 の値）。scoverage は**文（statement）と分岐（branch）**を計測し、**行の指標を持たない**と見込む（要確認）。そこで、**文 85%・分岐 75% を全体の暫定のしきい値、`domain` の文 97% を暫定の下限として引き継ぐ**。いずれも team.md の「行 80% を基準（floor）」を下回らない。**未実測のため暫定**で、最初の Bolt で実測して見直す。sbt-scoverage の設定名（`coverageMinimumStmtTotal`、`coverageMinimumBranchTotal`、`coverageFailOnMinimum`）は、設計時に確認していない（要確認）。

### ST5: テストは munit + ScalaCheck + cats-laws + Testcontainers

ガイドは munit と全パターンの列挙で足り、ScalaCheck を入れなかった（§8.3、§10.1）。beer-game-scala は、週次計算の不変条件（在庫・受注残が非負、出荷が利用可能量を超えない）を広い入力で守る必要があり、Kotlin 版・Rust 版もプロパティベーステストを持つため、munit-scalacheck を採る（**ガイドの方針からの変更**。導入の承認を得る）。代数構造の法則（`TeamTotals` の `Monoid`、`RoleMap` の `Functor`）は、cats-laws と discipline-munit か、ガイドの全パターンの列挙のどちらでも書ける。小さな範囲は後者で足りるため、**法則の道具は B1 で比較して決める**。

### ST6: JSON は circe（提案。未決）

ガイドは、JSON の木を自作した（ADR-052）。理由は「載せるものを型で決める方針」である。beer-game-scala は API の本文が多く、イベントの `payload` の相互変換（`EventCodec`）と、problem+json、`openapi.yaml` との一致検査が要るため、自作は割に合わないと判断し、http4s の標準的な組み合わせ（`http4s-circe`）の circe を提案する。**ドメインのイベントに codec を付けず、永続化・HTTP の DTO と相互変換する**（BD5）。派生（`derives`）を使うか手書きかは、`schema_version` とアップキャストの扱いやすさで B1 に決める。**ガイドが試していない道具のため、承認を得る**。代替の自作は、ガイド ADR-052 のとおり型で出力を限定できるが、パースの部分も要る。

### ST7: 受入は、日本語 Gherkin を契約として共有し、実行は関数値の経路とは別にする

ガイドは、cucumber-scala を「決定のあとで試して動いた（シナリオ 2 件）が `sbt test` には載せず、CLI で実行する確認用」とし、受け入れテストの本線は、関数値の `case class` で経路を差し替える方式にした（ADR-049）。Scala 版は、(a) Gherkin の `.feature` を beer-game-kotlin と共有し（`features/`）、(b) シナリオは cucumber-scala の専用のジョブで実行し、(c) 同じ受入条件を、munit の関数値の経路（ドメイン直接・アプリケーション・HTTP）でも確かめる。**`sbt test` に Cucumber を載せない**。日本語の Gherkin（`# language: ja`）を cucumber-scala 9.3.0 が扱えるかは**未確認**で、B1 で確かめ、不可なら英語のキーワード + 日本語の本文を比較する。

### ST8: 接続プールは doobie-hikari（ガイドは入れていない）

ガイドは HikariCP を入れず、トランザクションごとに接続を開く（`Transactor.fromDriverManager`。§10.1）。beer-game-scala は、用途別の DB ロール（api の書き込み・読み取り・観察者、削除、migrate。ADR-009）ごとにプールを分け、接続数の上限と待ち時間を計測する必要があるため、`doobie-hikari` の `HikariTransactor`（`Resource`）を採る。**ガイドからの変更で、導入の承認を得る**。`LISTEN` の専用の接続は、プールの外に持つ（アーキテクチャ）。

### ST9: ローカル開発の DB は PostgreSQL のみ（提案）

| 案 | 内容 | 評価 |
| :--- | :--- | :--- |
| **A（採用の提案）** | ローカルも PostgreSQL 18（Docker）。ポート `ProjectionLock`・`ChangeNotifier` は、テスト用のインメモリ実装との差し替えのために維持する | 環境が本番と同じで乖離がない。実装が 1 つで、契約テストを両実装で実行する維持費がない。`doobie-postgres` の機能（通知、PostgreSQL の型）をそのまま使える。Docker が要る |
| B | Kotlin 版と同じく H2 の PostgreSQL モード | H2 は JVM の組み込み DB で、Scala からも使える。Docker が要らない。アドバイザリロック、`LISTEN/NOTIFY`、部分一意索引、ロール、`jsonb` の差を、ポートの 2 実装と契約テストで埋める必要があり、Kotlin 版の ADR-014 が認める「ローカルで通っても CI で落ちる」乖離のリスクを負う |
| C | H2 を統合テストにも使う | 並行性・権限・部分一意索引・連鎖削除を検証できない。却下（Kotlin 版と同じ） |

**Rust 版は、H2 が JVM の DB で使えないことを理由にしたが、Scala 版は使える**。そのため、この判断は「使えない」ではなく、**使う価値が維持費を上回るか**で行った。人が決める。Kotlin 版の ADR-014 の「ユーザーの決定」（Kotlin 版では H2）を、Scala 版へ当然に引き継ぐものではない。

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
| 13 | ローカルは H2 | ローカルも PostgreSQL 18（提案） | ST9 |
| 14 | JDK 25（Temurin）の JRE | 同じ（JDK 25 を第一候補。要確認） | JVM 版 |
| 15 | 純粋性は detekt の `ForbiddenMethodCall` | WartRemover + Scalafix の `DisableSyntax` + `domain` の依存の制限（ST3） | ツールの違い |

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

1. **ローカル開発の DB**（ST9）: PostgreSQL のみを提案した。**人の承認を得る**。承認されれば、本書と ADR-001 の 014 の「提案」を外す。
2. **カバレッジのしきい値**（ST4）: 文 85%・分岐 75%、`domain` 文 97% を暫定で引き継いだ。**未実測**。scoverage の Scala 3 での指標と設定名は**要確認**。
3. **Scala と周辺の版の組み合わせ**: Scala 3.7.4 と WartRemover 3.6.3・sbt-scalafix 0.14.10・sbt-scoverage 2.4.4 の組み合わせ（Scalafix と scoverage は本書では未確認）。JDK 25 との組み合わせ。
4. **doobie の RC13**: ガイドが記す 1.0.0-RC13 は、Maven Central の一覧に無かった。RC12 でガイドの例（`Transactor`、`ConnectionIO`、`Update`）が動くかは要確認。
5. **http4s 0.23.39 の API**: ガイドの例と、SSE（`ServerSentEvent`）、ミドルウェア（CORS・Throttle・RequestId・ErrorHandling など）の名前。
6. **JSON ライブラリ**（ST6）: circe を提案。派生か手書きか。**承認を得る**。
7. **cucumber-scala の日本語対応**（ST7）と、Gherkin のファイルの共有の配置。
8. **Testcontainers**: `testcontainers-scala` 0.44.1 が依存する Java 側の版と、PostgreSQL 18 のイメージの指定。
9. **ドメインの依存の検査の方式**（ST3）: sbt のタスクか、Scalafix の `DisableSyntax.regex` か。
10. **生きたドキュメントの生成方式**（ADR-001 の 018 の置き換え）: Scala 3 の注釈、`enum` のメタ情報、scaladoc の走査の比較。
11. **コンテナ**: 実行イメージ、`sbt-native-packager` の採否、JVM のヒープ（NF-P17 に対応）。
12. **選定未決（Kotlin 版から継続）**: 変異テストの道具、依存関係の脆弱性検査、Dependabot か Renovate か、生きたドキュメントの公開の道具。
13. **sbt 2 への移行の時期**（ST1）。
14. **Nix の開発シェル**: JDK の指定、`scala_3` の版（`scalaVersion` で固定するため、REPL と scala-cli 用）。
15. **JSON スキーマの検査ライブラリ、`@redocly/cli`、`openapi-typescript`** の版（フロントエンド側は共有。バックエンド側の契約テストの検査ライブラリは JVM の共有を見込むが要確認）。

## 出典

- Maven Central の `maven-metadata.xml`（`org.typelevel:cats-core_3`、`cats-effect_3`、`co.fs2:fs2-core_3`、`org.http4s:http4s-ember-server_3`・`http4s-circe_3`、`org.tpolecat:doobie-core_3`・`doobie-postgres_3`・`doobie-hikari_3`、`io.circe:circe-core_3`、`com.zaxxer:HikariCP`、`org.postgresql:postgresql`、`org.flywaydb:flyway-core`、`org.scalameta:munit_3`・`munit-scalacheck_3`・`scalafmt-core_2.13`・`sbt-scalafmt_2.12_1.0`、`org.typelevel:munit-cats-effect_3`・`discipline-munit_3`・`cats-laws_3`・`log4cats-slf4j_3`、`org.scalacheck:scalacheck_3`、`com.dimafeng:testcontainers-scala-*_3`、`io.cucumber:cucumber-scala_3`、`ch.qos.logback:logback-classic`、`org.scala-lang:scala3-compiler_3`、`org.scala-sbt:sbt`、`org.wartremover:wartremover_3.7.*`・`sbt-wartremover_2.12_1.0`、`ch.epfl.scala:scalafix-cli_2.13.16`・`sbt-scalafix_2.12_1.0`、`org.scoverage:sbt-scoverage_2.12_1.0`）、2026-11-25
- ローカルの sbt 1.13.1（JetBrains Runtime 25.0.4.1）での断片のコンパイルとテスト、2026-11-25
- [ADR-001（Scala 版）](../../adr/beer-game-scala/001-scala-version-of-beer-game-kotlin.md)
- [技術スタック（beer-game-kotlin）](../beer-game-kotlin/tech-stack.md)、[技術スタック（Rust 版）](../beer-game-rust/tech-stack.md)
- [関数型プログラミングガイド（Scala 編）](../../reference/関数型プログラミングガイド_Scala編.md) 第 3〜9 章、§10.1
- `ops/nix/environments/scala/shell.nix`
- [ドメインモデル（Scala 版）](./domain-model.md)、[バックエンドアーキテクチャ（Scala 版）](./architecture-backend.md)、[テスト戦略](./test-strategy.md)、[非機能要件](./non-functional.md)
