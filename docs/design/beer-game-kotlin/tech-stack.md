---
type: Design
title: "技術スタック選定 - ビールゲームシミュレーション（Kotlin 版）"
description: "Kotlin 版の技術スタック。公式の情報で確認した版とサポート期限、確認できなかった項目、beer-game2 からの変更、新規の依存関係の承認表、設計判断を整理した正本。"
tags: [design]
status: draft
generated: { by: claude-code/claude-sonnet-5-5, at: 2026-11-14T08:30:39Z }
---

# 技術スタック選定 - ビールゲームシミュレーション（Kotlin 版）

## 概要

本書は、beer-game-kotlin の技術スタックを、バージョンとサポート期限とあわせて一覧にします。**`docs/` を設計の正本**とします。実装コードはまだ存在せず、本書の版は**選定の記録**です。

[beer-game2 の技術スタック](../beer-game2/tech-stack.md) を出発点に、次の方針で改訂しました。

- バックエンドは **Kotlin（Ktor + Arrow + kotlinx.coroutines）** に変更する。フロントエンドは、既存の React / TypeScript を踏襲する。
- アーキテクチャは**イベントソーシング + CQRS**（[ドメインモデル](./domain-model.md)、[データモデル](./data-model.md)）。コーディングは [関数型プログラミングガイド（Kotlin 編）](../../reference/関数型プログラミングガイド_Kotlin編.md) に準拠する。
- **バージョンとサポート期限は、2026-11-14 に公式の情報源で確認できた値だけ**を書く。確認できなかったものは「実装開始時に確認」とする。
- 版は、実装の開始時に、最新の安定版へ更新して固定する（Gradle の依存関係ロックまたはバージョンカタログ）。
- 新しく導入する依存関係は、**導入時に承認を得る**（プロジェクトの規約）。
- **ローカル開発（開発機での起動・動作確認）だけ H2 の PostgreSQL モードを使う**（ユーザーの決定、2026-11-14。設計判断 T7）。統合テスト、CI、ステージング、本番は PostgreSQL 18 のままにする。

### 確認の方法と範囲

| 区分 | 確認の手段 | 確認日 |
| :--- | :--- | :--- |
| 言語・JDK・Gradle・PostgreSQL のサポート期限 | endoflife.date の API（`kotlin`、`eclipse-temurin`、`gradle`、`postgresql`） | 2026-11-14 |
| ライブラリの最新の安定版 | Maven Central の `maven-metadata.xml`（`<release>` と `lastUpdated`） | 2026-11-14 |
| Cucumber-JVM、PMD の最新の安定版 | Maven Central の `maven-metadata.xml`（`io.cucumber:cucumber-java`、`cucumber-junit-platform-engine`、`net.sourceforge.pmd:pmd-core`、`pmd-kotlin`） | 2026-11-14 |
| Cucumber-JS（`@cucumber/cucumber`）の最新の安定版と要求する Node | npm レジストリ（`registry.npmjs.org/@cucumber/cucumber`） | 2026-11-14 |
| PMD の公開日 | GitHub の PMD のリリース（`pmd/pmd`。`pmd_releases/7.29.0`） | 2026-11-14 |
| H2 の最新の版と公開日、ライセンス | Maven Central の `com/h2database/h2/maven-metadata.xml`（`<release>`、`lastUpdated`）、ディレクトリ一覧の更新日、`h2-2.5.252.pom` の `<licenses>` | 2026-11-14 |
| H2 の PostgreSQL モードの記述 | H2 公式ドキュメントの features の PostgreSQL 互換モード（`h2database.com/html/features.html`） | 2026-11-14 |
| Ktor の SSE とレート制限のプラグイン名 | Ktor 公式ドキュメント（`ktor.io/docs`。Ktor 3.6.1 の版を表示） | 2026-11-14 |
| フロントエンド・インフラ・CI | beer-game2 の技術スタックが 2026-11-09 に確認した値を**そのまま引き継ぐ**。本書では再確認していない | 2026-11-09（beer-game2） |

**ライブラリのサポート期限（EOL）は、公式に公表された表を確認できなかったため、書きません。** 「保守が続いているか」は、`lastUpdated` が新しいことだけを根拠に示します。互換性（Kotlin の版と各ライブラリの組み合わせ）は、**実装開始時に、最初のウォーキングスケルトンのビルドで確認します**。

## 選定の方針

- 言語は、バックエンドを Kotlin、フロントエンドを TypeScript とする。**言語をまたぐ型の共有はしない**。API の契約は、**`contracts/openapi.yaml` を手書きの正本**とし、フロントエンドは仕様から型を生成する（決定済み。[バックエンドアーキテクチャ](./architecture-backend.md)、[フロントエンドアーキテクチャ](./architecture-frontend.md)）。バックエンドのコードから仕様を生成する方式は採らない。
- ドメインは純粋にし、副作用は境界へ寄せる。`suspend` を副作用の表現とし、自前の `IO` 型は作らない（[ガイド §4.2](../../reference/関数型プログラミングガイド_Kotlin編.md)、[§10.1](../../reference/関数型プログラミングガイド_Kotlin編.md)）。
- 失敗は例外でなく `Either` と `Raise` で返す。Arrow の `Either`、`either { }`、`zipOrAccumulate` を使う（[ガイド §3](../../reference/関数型プログラミングガイド_Kotlin編.md)）。
- ORM は使わず、SQL と JDBC を直接扱う。イベントの追記と投影の更新を、1 つのトランザクションの中で明示するため（[ガイド §7.6](../../reference/関数型プログラミングガイド_Kotlin編.md)、beer-game2 の ADR-002 と同じ考え方）。
- 依存関係は少なく保つ。**標準で足りるものは、依存関係を足さない**（ログは SLF4J と標準出力の JSON、メトリクスは EMF 形式の JSON、層の依存の検査は Gradle のモジュール分割）。
- インフラは AWS のマネージドサービスを使い、Terraform で定義する（[インフラ](./architecture-infrastructure.md)）。

## 確認した重要な事項

| # | 事項 | 確認結果（2026-11-14） | 判断 |
| :--- | :--- | :--- | :--- |
| 1 | Kotlin | 2.4 系が最新（2.4.0 は 2026-06-03、最新パッチ 2.4.21 は 2026-10-08）で、サポート中。2.3 は 2026-06-03 にサポート終了 | **2.4.21** を第一候補。K2 コンパイラ、`@JvmInline value class`、コンテキストパラメータの扱いは、実装開始時に確認 |
| 2 | JDK | **25 が LTS**（Temurin。2025-09-22 リリース、EOL 2031-09-30）。26 は LTS でなく EOL 2026-09-22、27 は LTS でなく EOL 2027-03-23 | **JDK 25（LTS）** を採用。**配布は Eclipse Temurin**（コンテナのイメージ `eclipse-temurin`。EOL 2031-09-30 は endoflife.date の `eclipse-temurin` の値で、[インフラ](./architecture-infrastructure.md) も同じ。Oracle JDK の 2030-09-30 は使わない配布の値）。LTS の次の版は、実装の期間中に採用しない |
| 3 | Gradle | 9.9.1（2026-11-10）。実行できる Java は 17〜26、テスト済みの Kotlin は 2.0.0〜2.4.20-Beta1 まで | **9.9.1**。Kotlin 2.4.21 との組み合わせは、**テスト済みの範囲の上限が 2.4.20-Beta1 のため、実装開始時にビルドで確認する** |
| 4 | PostgreSQL | 18 の最新は 18.7、EOL 2030-11-14。17 は EOL 2029-11-08 | **PostgreSQL 18**（beer-game2 と同じ。RDS の標準サポートは beer-game2 が確認した 2031-02-28 まで） |
| 5 | Ktor | 3.6.1（Maven Central の更新は 2026-10-29）。3.x の系列 | **3.6.1** |
| 6 | Arrow | `arrow-core` の最新は **2.3.0**（2026-10-27） | **2.3.0**。`arrow-fx-coroutines`、`arrow-resilience` の同じ版の有無は、実装開始時に確認 |
| 7 | kotlinx.coroutines | 1.11.0（2026-05-08） | **1.11.0** |
| 8 | kotlinx.serialization | `kotlinx-serialization-json` の最新は 1.13.0（2026-11-11） | **1.13.0** |
| 9 | PostgreSQL JDBC | 42.7.14（2026-10-07） | **42.7.14** |
| 10 | 接続プール | HikariCP 7.1.0（2026-06-14） | **7.1.0**。JDK 25 との組み合わせは、実装開始時に確認 |
| 11 | マイグレーション | Flyway 13.12.2（2026-11-12） | **13.12.2**（**選定済み**。設計判断 T4。導入は承認待ち） |
| 12 | テスト | Kotest 6.2.7（2026-11-11）。Testcontainers は **2 系**（`testcontainers-postgresql` 2.0.5、2026-04-20）で、1 系（`postgresql` 1.21.4）は 2025-12-16 が最後 | **Kotest 6.2.7**、**Testcontainers 2.0.5**（設計判断 T3） |
| 13 | detekt | **安定版は 1.23.8**（2025-02-21、`io.gitlab.arturbosch`）。`dev.detekt` の **2.0.0-alpha.6**（2026-08-04）は alpha のみ | **1.23.8 を第一候補**。ただし、Kotlin 2.4 のコードを解析できるかは**未確認**。**B2 の受入条件**（規約違反のコードを 1 つ置き、CI が落ちること。違反 0 件・ベースラインなし・`@Suppress` なし）で確認し、不可なら設計判断 T5 の代替へ（期限: B2 の中。B2 で確定できなければ B3 以降を止める） |
| 14 | ktlint | 1.8.0（2025-12-15） | **1.8.0**。整形の適用範囲は、ガイド §9.4 に従い `.editorconfig` で絞る（設計判断 T5）。違反は 0 件で、整形の中核のルールは外さない |
| 15 | カバレッジ | Kover Gradle プラグイン 0.9.11（2026-09-29） | **0.9.11**（設計判断 T6） |
| 16 | Node.js（フロントエンドのビルド・テスト用） | beer-game2 が確認した Node 26（Active LTS。EOL 2029-04-30） | **Node 26 LTS** を、フロントエンドのビルドと E2E にだけ使う。バックエンドの実行環境には含めない |
| 17 | PMD（XPath のカスタムルール。CI のツール） | `net.sourceforge.pmd:pmd-core` と `pmd-kotlin` の最新は **7.29.0**（Maven Central の更新は 2026-10-30。GitHub のリリース `pmd_releases/7.29.0` の公開は 2026-10-30）。サポート期限は、公式に公表された表を確認できていない | **7.29.0**（ガイド §9.6 が確認した版と同じ。fixture で 17 件になる）。Kotlin 2.4 の構文の解析の可否は**未確認**で、B2 の受入条件。**導入は承認待ち**（設計判断 T5。補完として採用） |
| 18 | Cucumber-JVM | `io.cucumber:cucumber-java` と `cucumber-junit-platform-engine` の最新は **8.0.4**（Maven Central の更新は 2026-10-02）。サポート期限は、公式に公表された表を確認できていない | **8.0.4**。導入は決定済み。**版の確認と依存関係の承認が要る**。Kotlin のステップ定義を `cucumber-java` で書けるか、JUnit Platform（Kotest 6.2.7 が要求する版。`junit-platform-suite` の最新は 6.1.3）との組み合わせは、**実装開始時（B1）にビルドで確認** |
| 19 | Cucumber-JS（`@cucumber/cucumber`） | 最新は **13.3.0**（npm の公開は 2026-10-05）。要求する Node は `22 \|\| 24 \|\| >=26` で、**Node 26 LTS（事項 16）を満たす**。サポート期限は、公式に公表された表を確認できていない | **13.3.0**。導入は決定済み。**版の確認と依存関係の承認が要る**。パッケージは `@cucumber/cucumber`（旧 `cucumber` ではない）。Playwright（1.65.0。beer-game2 の確認値）との組み合わせは、B1 で確認 |
| 20 | H2（ローカル開発用の DB。`com.h2database:h2`） | 最新の安定版は **2.5.252**（Maven Central の `<release>`。ファイルの公開は 2026-09-26）。ライセンスは pom に **MPL 2.0 と EPL 1.0** の記載。**サポート期限（EOL）は、公式に公表された表を確認できていない**。H2 公式ドキュメント（features）の PostgreSQL 互換モードの節は、接続 URL（`MODE=PostgreSQL;DATABASE_TO_LOWER=TRUE;DEFAULT_NULL_ORDERING=HIGH`）と、挙動の差（別名の列名、浮動小数点から整数への丸め、`ctid`・`oid` など）を記す。**アドバイザリロック、LISTEN/NOTIFY、部分インデックス、ロール/GRANT、JSONB、SQLSTATE、分離レベルの差異は、この節で確認できなかった**（「非対応」とは断定しない）。実際の動作は **B1 の最初に実測して確定する**（未確認） | **2.5.252** を第一候補（**ローカル開発だけ**。設計判断 T7）。JDK 25 での動作と Flyway 13.12.2 との組み合わせは、実装開始時（B1 の最初）に確認。**導入は承認待ち** |

## バックエンド

| カテゴリ | 技術 | 版 | beer-game2 | 用途 | サポート期限 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| 言語 | Kotlin（JVM） | **2.4.21** | TypeScript 6.0.3 | ドメイン、アプリケーション、アダプター | Kotlin 2.4 はサポート中（終了日は公表なし） |
| 実行環境 | JDK（Eclipse Temurin） | **25（LTS）** | Node 26 | API、保持の定期タスク、マイグレーション | 2031-09-30（Temurin。endoflife.date） |
| ビルド | Gradle（Kotlin DSL） | **9.9.1** | npm | ビルド、テスト、静的解析、依存関係の固定 | 9 系はサポート中（終了日は公表なし） |
| Web フレームワーク | Ktor Server | **3.6.1** | Fastify 5.12.8 | REST API、SSE | - |
| Ktor の部品 | `ktor-server-netty`（エンジン）、`ktor-server-content-negotiation`、`ktor-serialization-kotlinx-json`、`ktor-server-status-pages`、`ktor-server-call-id`、`ktor-server-call-logging`、`ktor-server-cors`、`ktor-server-default-headers`、`ktor-server-hsts`、`ktor-server-rate-limit`、**`ktor-server-sse`**、`ktor-server-auth` | 3.6.1（テスト用に `ktor-server-test-host` を加える。開発依存のみ。プラグイン名の確認は SSE とレート制限のみで、他は実装開始時に確認） | @fastify/* 一式 | 下記の対応表 | - |
| 関数型 | Arrow（`arrow-core`、`arrow-fx-coroutines`、`arrow-resilience`） | **2.3.0**（`arrow-core`）。他は実装開始時に確認 | （なし） | `Either`、`Raise`、`zipOrAccumulate`、`parMap`、`Schedule`（再試行） | - |
| 非同期 | kotlinx.coroutines | **1.11.0** | Promise / async | `suspend` を副作用とする。`Dispatchers.IO` にブロッキング I/O を閉じ込める | - |
| シリアライズ | kotlinx.serialization（`kotlinx-serialization-json`） | **1.13.0** | zod（検証） | API の JSON と、イベントの `payload`（`event_type` を判別子にした sealed の多相）。**変換は `EventCodec`、アップキャストは `adapter-persistence`**（決定済み） | - |
| 入力検証 | 自前のスマートコンストラクタ + Arrow の `zipOrAccumulate` | Arrow に含む | zod 4.6.7 | 境界の検証、誤りを集める（[ドメインモデル](./domain-model.md)） | - |
| DB ドライバ | PostgreSQL JDBC（`org.postgresql:postgresql`） | **42.7.14** | pg 8.23.1 | PostgreSQL への接続 | - |
| DB ドライバ（ローカル開発のみ） | H2（`com.h2database:h2`）。**開発用。導入は承認待ち** | **2.5.252**（第一候補。確認日 2026-11-14） | なし | 開発機で Docker なしに起動するための DB（PostgreSQL モード）。本番・ステージング・CI・統合テストでは使わない（設計判断 T7）。実行時の依存関係は開発用の構成に限り、本番のイメージに含めない | 公式の期限は確認できていない |
| 接続プール | HikariCP | **7.1.0** | pg の Pool | 接続の再利用、上限、待ち時間の計測 | - |
| マイグレーション | Flyway（`flyway-core`、PostgreSQL 用モジュール）。**選定済み、導入は承認待ち** | **13.12.2** | node-pg-migrate 9.0.0 | 番号つきの SQL マイグレーションと履歴 | - |
| ログ | SLF4J + Logback Classic（**選定済み、導入は承認待ち**）、アプリのログは `LogRecord` の JSON を標準出力へ | Logback **1.6.6** | Pino | 構造化ログ。`LogRecord` に表示名・資格の項目を**持たせない**（型で漏れを防ぐ。[ガイド §7.7](../../reference/関数型プログラミングガイド_Kotlin編.md)） | - |
| メトリクス | CloudWatch EMF（JSON 形式） | 依存関係なし | 同左 | 応答時間、競合、再試行、確定など | - |

AWS SDK は、キューを持たない設計のため、**依存関係に含めません**。

### beer-game2 の Fastify プラグインとの対応

| beer-game2 | Kotlin 版 |
| :--- | :--- |
| `@fastify/cookie` | Ktor の `Cookie` の扱い（`ktor-server-core`）。資格の Cookie は `HttpOnly`、`Secure`、`SameSite=Strict` で自前に設定する |
| `@fastify/cors` | `ktor-server-cors`（許可しない設定） |
| `@fastify/rate-limit` | `ktor-server-rate-limit`（参加・復帰・招待は専用の制限） |
| `@fastify/helmet` | `ktor-server-default-headers`（CSP、`nosniff`、Referrer-Policy）と `ktor-server-hsts` |
| Fastify の Pino ログ | `ktor-server-call-logging`、`ktor-server-call-id`（相関 ID）と `LogRecord` |
| SSE（自前） | `ktor-server-sse` |

## データストア

| カテゴリ | 技術 | 版 | beer-game2 | 用途 | サポート期限 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| RDBMS | PostgreSQL | **18**（RDS、CI、統合テスト、ステージング、本番。ローカル開発だけ下の H2 を選べる） | 18 | **イベントストア**、投影、周辺ストア、保持削除の状態 | 2030-11-14（RDS の標準サポートは 2031-02-28。beer-game2 の確認値） |
| スキーマ管理 | Flyway | 13.12.2 | node-pg-migrate | 履歴テーブルで管理。拡張 → 互換 → 縮小 | - |
| ORM | なし | - | なし | 直接の SQL（JDBC） | - |
| イベントのペイロード | `jsonb` + kotlinx.serialization | - | `jsonb` | `schema_version` とアップキャスト（[データモデル](./data-model.md)） | - |
| ローカル開発用 DB | H2（PostgreSQL モード） | **2.5.252**（第一候補） | なし | **開発機での起動・動作確認だけ**。PostgreSQL 固有の機能は、ポート（`ProjectionLock`、`ChangeNotifier`）の H2 版で代える。省略した制約はローカルで守られない（[データモデル](./data-model.md)、[バックエンド](./architecture-backend.md)） | 公式の期限は確認できていない |

イベントストアの専用製品（EventStoreDB など）は、**導入しません**（設計判断 T1）。**H2 は、統合テスト・CI・ステージング・本番に使いません**（設計判断 T7）。

## フロントエンド

既存の React / TypeScript を踏襲します。**下表の版は、beer-game2 が 2026-11-09 に確認した値で、本書では再確認していません**。実装開始時に最新の安定版へ更新します。

| カテゴリ | 技術 | 版（beer-game2 の確認値） | 用途 |
| :--- | :--- | :--- | :--- |
| UI ライブラリ | React / React DOM | 19.3.1 | SPA の画面 |
| 言語 | TypeScript | 6.0.3（typescript-eslint の対応待ちの制約も継続） | 画面 |
| ビルド・開発サーバー | Vite | 8.3.6 | バンドル、HMR、`/api` のプロキシ（バックエンドは Ktor） |
| ルーティング | react-router | 8.5.1 | URL とゲームの対応 |
| リアルタイム | EventSource（ブラウザ標準） | - | SSE の受信と、ポーリングへの切り替え |
| 実行環境（ビルド・テスト用） | Node.js | 26（LTS） | フロントエンドのビルド、Vitest、Playwright |

フロントエンドの設計は、[フロントエンドアーキテクチャ](./architecture-frontend.md) を参照します。**API の契約は、beer-game2 から次の点で変わります**（それ以外の応答の形は引き継ぎます）。

- **ゲームの開始**は `POST /games/:id/start`（2 ストリームへの原子的な追記。[バックエンド](./architecture-backend.md)）。
- **`If-Match` は `SaveDecision`（意思決定の版）にだけ**付く。`CommitWeek` は本文の `requestedWeek` と `basis` を使う（H6）。
- コマンドの応答は `{ versions: { game, session }, ... }` で、画面はスナップショットを取り直して `versions` に追いつく（H8）。
- **SSE の通知に、ストリームの種別**（`game`、`session`）が加わる（版が別のため）。
- エラーは problem+json で、`type` は `/problems/{code}`、拡張メンバー `code` が同じ値（`<領域>.<名前>`）。アプリケーション層の失敗にも `code` を持つ（`app.retry_exhausted`、`app.idempotency_key_reused`、`app.unauthorized`。H9、M7）。

契約の正本は `contracts/openapi.yaml`（手書き）で、フロントエンドが型を生成します。

## テスト・品質

| カテゴリ | 技術 | 版 | 用途 |
| :--- | :--- | :--- | :--- |
| テストフレームワーク | Kotest（`kotest-runner-junit5`、`kotest-assertions-core`） | **6.2.7** | ユニット・統合テスト。`shouldBe`、日本語のテスト名（ガイド §8.2、§9.4） |
| プロパティベーステスト | Kotest Property（`kotest-property`。`checkAll`、`forAll`、`Arb`） | **6.2.7** | `simulateWeek` の性質、`decide` / `evolve` の性質、永続化往復の同値性・計算と事実の一致・投影の整合（[ガイド §8.3](../../reference/関数型プログラミングガイド_Kotlin編.md)） |
| 実行基盤 | JUnit Platform（Gradle の `useJUnitPlatform()`） | `junit-jupiter` の最新は 6.1.3（2026-08-07）。**Kotest 6.2.7 が要求する JUnit の版は、実装開始時に確認** | テストの実行 |
| 統合テスト | Testcontainers（`testcontainers-postgresql`） | **2.0.5** | 実 PostgreSQL 18 のコンテナ。イベントストア、投影、並行性 |
| 仮想時間 | `kotlinx-coroutines-test`（`runTest`、`currentTime`） | coroutines と同じ **1.11.0** | 再試行、タイムアウト、定期タスク |
| カバレッジ | Kover（Gradle プラグイン） | **0.9.11** | 行、命令、分岐の計測と閾値（設計判断 T6）。計測できる指標の種類は、実装開始時に確認 |
| 受け入れ（バックエンド） | Cucumber-JVM（`cucumber-java`、`cucumber-junit-platform-engine`） | **8.0.4**（確認日 2026-11-14、Maven Central）。導入は決定済み。承認待ち | 日本語 Gherkin の受入条件・デモ項目（`@api`）。Ktor のテスト用アプリケーションと実 PostgreSQL（Testcontainers）を通す。Gradle のソースセット（`acceptanceTest` を想定） |
| 受け入れ（画面） | Cucumber-JS（`@cucumber/cucumber`）+ Playwright | **13.3.0**（確認日 2026-11-14、npm。要求する Node は `22 \|\| 24 \|\| >=26`）。導入は決定済み。承認待ち | 日本語 Gherkin の `@ui` のシナリオ。実 Ktor サーバーを通す。タグ（`@US2.4`、`@AC2.4.1`、`@api`/`@ui`、重要度）でストーリーとの対応を取る。生きたドキュメントの公開は CI で自動化（公開の道具は B1〜B2 で選ぶ。**版は未確認**） |
| 静的解析（中心） | detekt | **1.23.8**（Kotlin 2.4 の解析の可否は未確認。**B2 の受入条件**） | 複雑度、関数型の規約（[ガイド §9.3](../../reference/関数型プログラミングガイド_Kotlin編.md)）。**違反 0 件（`maxIssues: 0`）、ベースラインなし、`@Suppress` なし**で、最初のコードから全ルールを有効にする。**`ForbiddenMethodCall` で、ドメインのモジュールでの `Instant.now`・`Clock.system*`・`UUID.randomUUID`・`Random` を禁止**し、純粋性を静的検査で守る（[テスト戦略](./test-strategy.md)）。除外が要る層は、ルールセットのファイルを層ごとに分けて外す |
| 静的解析（補完。CI のツール） | PMD（XPath のカスタムルール。`pmd-core`、`pmd-kotlin`） | **7.29.0**（確認日 2026-11-14、Maven Central。Kotlin 2.4 の構文の解析の可否は未確認）。**導入は承認待ち** | detekt に無い関数型の規約を補う、**14 個の XPath ルール**（`var` の禁止、可変コレクション、`!!`、`throw`、`runBlocking`、`GlobalScope` など。[ガイド §9.6](../../reference/関数型プログラミングガイド_Kotlin編.md)）。**ルールは、fixture で期待件数（ガイドの例は PMD 7.29.0 で 17 件）と一致することを、テストファーストで確かめ、CI に組み込む**。ルールの `message` に `{` と `}` を書かない。層ごとにルールセットを分ける（B2 の受入条件） |
| 整形 | ktlint | **1.8.0** | 書式。違反は 0 件。副作用の大きいルールだけを `.editorconfig` で調整する（日本語のバッククォートのテスト名のため、関数名の camelCase はテストで外す。[ガイド §9.4](../../reference/関数型プログラミングガイド_Kotlin編.md)）。整形の中核のルールは外さない |
| 画面テスト | Vitest、@testing-library/react、jsdom | beer-game2 の確認値（5.1.0、16.3.3、31.0.0） | コンポーネントのテスト |
| E2E | @playwright/test、@axe-core/playwright | beer-game2 の確認値（1.65.0、4.14.0） | 実ブラウザ（実際の Ktor サーバー）での受入テストとアクセシビリティ |
| 変異テスト | **選定未決** | **実装開始時に確認** | domain の品質指標は行の数値より変異テストを優先。導入の要否は、ウォーキングスケルトンで判断（[テスト戦略](./test-strategy.md)）。Pitest の Kotlin 対応と版は、本書では確認していない |
| 依存関係の脆弱性検査 | **選定未決** | **実装開始時に確認** | Gradle の依存関係の検査と更新の自動化（Dependabot または Renovate） |

## インフラ・運用

beer-game2 の構成を引き継ぎます。**版は、beer-game2 が 2026-11-09 に確認した値で、本書では再確認していません**（実装開始時に確認）。

| カテゴリ | 技術 | Kotlin 版での扱い |
| :--- | :--- | :--- |
| クラウド | AWS（ap-northeast-1） | 同左 |
| コンテナ | Docker | ビルドは Gradle の**マルチステージ**。実行イメージは JDK 25 の JRE を含むもの（イメージの名前とタグは**実装開始時に確認**）。ローカルの DB は **H2 の PostgreSQL モード（Docker 不要。設計判断 T7）**。PostgreSQL を使うローカルの確認（統合テスト、受け入れ）は `postgres:18-alpine`（beer-game2 の確認値）か Testcontainers |
| 実行基盤 | ECS Fargate | JVM のヒープと、タスクのメモリの割り当ては [非機能要件](./non-functional.md) の NF-P17 で実測して決める |
| データベース | RDS for PostgreSQL 18（Multi-AZ、PITR） | 同左 |
| 配信・観測・IaC・CI | CloudFront、S3、ALB、CloudWatch、Terraform、GitHub Actions | 同左。CI のビルドは Gradle（`./gradlew check`）。詳細は [インフラ](./architecture-infrastructure.md)、[運用要件](./operation.md) |
| CI の検査 | gitleaks、Trivy、Checkov（または同等のもの） | 同左。Gradle の依存関係の検査は上表 |
| ドキュメント | MkDocs、PlantUML、Mermaid | 同左 |

## 新しく導入する依存関係（導入時に承認を得る）

beer-game2 に無く、Kotlin 版で新しく導入するものです。**書き分け**: 「**承認待ち**」は、選定は済んでいて、導入の承認が未了のもの。「**選定未決**」は、道具そのものが決まっていないもの（変異テストの道具、依存関係の検査）で、選定した後に、あらためて承認を得ます。下表の上 11 行（Ktor から detekt、ktlint まで）に、**Cucumber（導入は決定済み。版の確認と承認が要る）と PMD（承認待ち）**に、**H2（ローカル開発用。次表の最終行近く）**を加えた行は、承認待ちです。

| 依存関係 | 用途 | 代替（導入しない場合） | 導入の判断 |
| :--- | :--- | :--- | :--- |
| Ktor Server と上記の部品 | HTTP、SSE | http4k、Spring Boot など（設計判断 T2） | ユーザーの決定（バックエンドは Ktor）。導入が前提 |
| Arrow（core、fx-coroutines、resilience） | `Either`、`Raise`、`parMap`、再試行 | 標準の `Result` と自前の `Either` | ガイドの前提。導入を推奨 |
| kotlinx.coroutines、kotlinx.serialization | 非同期、JSON | Jackson（JSON） | Kotlin の標準的な組み合わせ。導入を推奨 |
| PostgreSQL JDBC、HikariCP | DB 接続 | R2DBC など | 行のロックを使わない追記と、トランザクションの明示に合う。導入を推奨 |
| Flyway | マイグレーション | Liquibase、番号つきの SQL と履歴テーブルの自前の実装（設計判断 T4） | 履歴と適用を標準化できる。導入を推奨 |
| Logback Classic | SLF4J の出力 | 標準出力へ直接。Ktor と Hikari と Flyway のログの出力先がなくなる | 導入を推奨（アプリのログは自前の `LogRecord`） |
| Kotest（framework、assertions、property） | テスト | JUnit 5 + AssertJ + jqwik（設計判断 T3） | ガイドの例が Kotest。導入を推奨。開発依存のみ |
| Testcontainers（postgresql） | 実 DB の統合テスト | CI のサービスコンテナだけ（手元で再現しにくい） | ガイドの表にある。導入を推奨。開発依存のみ |
| kotlinx-coroutines-test | 仮想時間 | 実時間の待ち | 導入を推奨。開発依存のみ |
| Kover | カバレッジ | JaCoCo を直接 | Kotlin 向け。導入を推奨。開発依存のみ |
| detekt、ktlint | 静的解析と整形 | 自作の検査（ガイド §9.5） | ガイド §9.3、§9.4。導入を推奨（detekt の互換は B2 で確認）。違反 0・ベースラインなし・`@Suppress` なしで厳格に適用 |
| PMD（`pmd-core`、`pmd-kotlin` 7.29.0。XPath のカスタムルール） | detekt に無い関数型の規約の補完（14 個の関数型ルール）。CI のツールで、実行時の依存関係ではない | 自作の検査、detekt のカスタムルール（別途ビルドが要る） | **承認待ち**（開発戦略が採用を提案）。承認までは detekt と ktlint で進め、B2 で fixture のテストと合わせて導入する |
| Cucumber-JVM（`cucumber-java`、`cucumber-junit-platform-engine` 8.0.4） | `@api` の受入条件の自動実行（日本語 Gherkin） | Kotest だけで受入条件を表す（導入しないという案は、ユーザーが 2026-11-14 に却下） | **導入は決定済み。版の確認は済み（8.0.4）。依存関係の導入の承認が要る**（B1）。開発依存のみ |
| Cucumber-JS（`@cucumber/cucumber` 13.3.0） | `@ui` の受入条件の自動実行（Playwright と組み合わせる） | 同上 | **導入は決定済み。版の確認は済み（13.3.0）。依存関係の導入の承認が要る**（B1）。開発依存のみ。プロジェクトの依存として入れる（グローバルにインストールしない） |
| H2（`com.h2database:h2` 2.5.252。ローカル開発用） | 開発機で Docker なしに起動する DB（PostgreSQL モード）。**開発用の構成だけ**に含め、本番のイメージに入れない | ローカルも Docker の PostgreSQL 18 を使う（beer-game2 と同じ。Docker が要る） | **承認待ち**（ユーザーの決定。導入の承認が要る。ライセンスは pom に MPL 2.0 と EPL 1.0 の記載。実装開始時にプロジェクトの方針と照合する）。**統合テスト・CI・受け入れ・ステージング・本番には使わない**（設計判断 T7）。B1 の最初に、PostgreSQL モードで動く範囲を実測する |
| 変異テストの道具、Gradle の依存関係の検査 | テストの強さ、脆弱性 | なし（**選定未決**） | **実装開始時に選定し、あらためて承認を得る** |

## 設計判断

### T1: イベントストアは、PostgreSQL の `events` 表で自前に実装する

| 案 | 内容 | 評価 |
| :--- | :--- | :--- |
| **A（採用）** | PostgreSQL の追記専用の表。追記は、ストリームの版の一意制約で楽観的並行制御（[データモデル](./data-model.md)） | 投影・周辺ストア・冪等記録・保持削除を **1 つのトランザクション**と**1 回の連鎖削除**で扱える。運用する製品が増えない。規模（15 ゲーム、1 ストリーム千件前後）に十分 |
| B | EventStoreDB などの専用製品 | ストリームの購読が組み込み。投影との同一トランザクションができず、保持削除の網羅（NFR-07）と RPO 0 の設計が複雑になる。運用する製品が増える |
| C | Axon Framework などのフレームワーク | 部品が揃う。ガイドの「関数の束」の設計（[§7.2](../../reference/関数型プログラミングガイド_Kotlin編.md)、[§7.6](../../reference/関数型プログラミングガイド_Kotlin編.md)）と合わず、純粋な `decide` / `evolve` をフレームワークの型に合わせる必要が出る |

トレードオフ: A は、購読と再生の仕組みを自前に持つ。規模が小さいため許容する。

### T2: Web フレームワークは Ktor（ユーザーの決定）。エンジンは Netty を第一候補にする

| 案 | 内容 | 評価 |
| :--- | :--- | :--- |
| **A（採用）** | Ktor + Netty エンジン | コルーチンが前提で、`suspend` の境界と合う。SSE（`ktor-server-sse`）、レート制限（`ktor-server-rate-limit`）が公式のプラグインにある。**エンジンの最終確認は、ウォーキングスケルトンの負荷試験（75 の SSE 接続）で行う** |
| B | Ktor + CIO エンジン | 純 Kotlin で、依存が少ない。成熟度と性能は、本書では確認していない |
| C | http4k、Spring Boot | 関数型の設計と相性がよい（http4k）、機能が多い（Spring）。ユーザーの決定（Ktor）から外れる |

### T3: テストは Kotest + Testcontainers

| 案 | 内容 | 評価 |
| :--- | :--- | :--- |
| **A（採用）** | Kotest（フレームワーク、アサーション、プロパティ）+ Testcontainers | ガイド §8.2、§8.3 の例と同じ。日本語のテスト名が書ける。プロパティベーステストが同じ道具で書ける |
| B | JUnit 5 + AssertJ + jqwik | 広く使われている。プロパティベーステストに別のライブラリ（jqwik）が要る。ガイドの例と異なる |

トレードオフ: Kotest 6 の系列が JUnit Platform に要求する版は、本書では確認していない（実装開始時）。

### T4: マイグレーションは Flyway

| 案 | 内容 | 評価 |
| :--- | :--- | :--- |
| **A（採用）** | Flyway（SQL の番号つきのファイル） | 履歴テーブルと適用が標準。`events` の追記専用のロール権限などを SQL で書ける。JVM から起動時、または CI のジョブで適用できる |
| B | Liquibase | 差分の記述が柔軟。XML / YAML の定義が増え、SQL を直接読み書きする本設計の方針と合わない |
| C | 自前の実装（番号つきの SQL と履歴表） | 依存関係が増えない。適用の排他、チェックサムの検査、失敗時の扱いを自前に持つことになる |

Flyway の版 13.12.2 は、Maven Central の `flyway-core` の最新を確認した値。コミュニティ版で足りる機能の範囲は、実装開始時に確認する。

### T5: 静的解析は detekt を中心にし、PMD の XPath を補完として採用し、ktlint は整形を絞って併用する（厳格に適用）

| 案 | 内容 | 評価 |
| :--- | :--- | :--- |
| **A（採用。中心）** | detekt（1.23.8 を第一候補）で複雑度と関数型の規約、ktlint（1.8.0）で書式。ktlint の整形ルールは `.editorconfig` で調整する | ガイド §9.3、§9.5 の「複数人の開発、長く保守するプロダクト」の推奨に従う。**違反 0 件、ベースラインなし、`@Suppress` なし**を CI で強制する |
| B | detekt 2.0 の alpha（`dev.detekt`） | Kotlin 2.4 に対応している見込みはあるが、alpha であり、安定性を確認していない。A が解析できない場合の代替 |
| **C（採用。補完）** | PMD のカスタムルール（ガイド §9.6。7.29.0） | `var` の禁止などの専用ルールを XPath で書ける（14 個の関数型ルール）。標準の Kotlin ルールが少ないため、**単独では使わず、detekt の標準ルールで足りない規約の補完として使う**。fixture で期待件数を確かめてから CI に組み込む。**導入は承認待ち** |

トレードオフ: A は、**detekt 1.23.8 が Kotlin 2.4 のコードを解析できるか**に依存する。解析できない場合は、Kotlin の版を下げず、B（alpha）、C の拡充（PMD の XPath）、または ktlint のカスタムルールを選び直す。C は、**PMD が Kotlin 2.4 の構文を解析できるか**にも依存する（未確認）。C は、ルールの読み間違いで、違反の見逃しや誤検出が起きうるため、**ルール自体を fixture でテストファーストに確かめる**（ガイド §9.6）。

**厳格な適用（開発戦略 [静的解析とルール設定](../../development/beer-game-kotlin/development_strategy.md)）**:

- 本プロジェクトは新規の実装で、既存の違反がないため、**14 個の関数型ルールと detekt の標準ルールを、最初から全て有効にする**。違反は 0 件で、ベースライン（既存の違反の許容リスト）を使わず、`@Suppress` とルールの無効化コメントを使わない。
- 除外が要る層は、**ルールセットのファイルを層ごとに分けて外す**（ドメインは全ルールを有効、アダプター、`main`、テストは外すルールと範囲を明示する）。ルールの緩和・除外は、理由を ADR に記録し、人が承認する。
- detekt の設定値（ルール名と既定値）は、導入する版の公式ドキュメントで確認して確定する（ガイドの設定は、実行して確認していない例）。

**受入条件と期限（M17、B2）**: B2 で、次を確認する（満たせなければ B3 以降を止め、代替を選ぶ。選択は ADR に記録する）。

- 「規約違反のコードを 1 つ置き、CI が落ちること」（detekt と PMD のそれぞれ）。落ちれば A（と C）を確定する。落ちなければ（解析できない、または規則が効かない）、B の代替を選ぶ。
- PMD が Kotlin 2.4 の構文を解析でき、fixture の期待件数と一致すること。
- 純粋性の規則（`ForbiddenMethodCall` による `Instant.now` などの禁止）も、同じ受入条件で確認する。
- `maxIssues: 0`、ベースラインなし、`@Suppress` なしで、全コードが緑であること。

### T6: カバレッジの計測は Kover

| 案 | 内容 | 評価 |
| :--- | :--- | :--- |
| **A（採用）** | Kover | Kotlin 向けで、Gradle のプラグイン。inline 関数や `value class` の扱いが Kotlin に合う |
| B | JaCoCo を直接 | 実績が長い。Kotlin のコードの計測で、コンパイラの生成コードが誤差になる場合がある |

トレードオフ: 計測できる指標が beer-game2 の 4 種（行・関数・文・分岐）と異なるため、ゲートの指標を見直した（[テスト戦略](./test-strategy.md)）。

### T7: ローカル開発は H2 の PostgreSQL モード（ユーザーの決定、2026-11-14）

| 案 | 内容 | 評価 |
| :--- | :--- | :--- |
| **A（採用）** | **ローカル開発（開発機での起動・動作確認）だけ**、H2 の PostgreSQL モード。統合テスト、CI、ステージング、本番は PostgreSQL 18（Testcontainers、RDS）のまま。PostgreSQL 固有の機能（アドバイザリロック、LISTEN/NOTIFY）はポート（`ProjectionLock`、`ChangeNotifier`）の裏に置き、PostgreSQL 版と H2 版を持つ。部分一意索引、DB ロールと GRANT、接続プールの分離、`jsonb` は PostgreSQL の統合テストでだけ検証する。H2 版のマイグレーションは Flyway のベンダー別の場所で、共通部分を最大化し差分だけを分ける（配置は B1 で確定） | Docker なしで起動でき、開発の初動が軽い。ただし、**H2 版では、省略した制約がローカルで守られず、単一プロセスの制約（プロセス内のロックとイベント）がある**。ローカルで通っても CI で落ちる乖離が起きうる |
| B | ローカルも Docker の PostgreSQL 18（beer-game2 と同じ） | 環境が本番と同じで乖離がない。Docker が要る |
| C | H2 を統合テストにも使う | テストが速い。並行性・権限・部分一意索引・連鎖削除という設計の中核を検証できない。**却下**（設計の検証に H2 を使わない） |

トレードオフ: A は、開発の手軽さと引き換えに、ローカルと CI の乖離のリスクを持つ。対策は、(a) H2 でしか通らない記述を禁止し、PostgreSQL の統合テストを正とする、(b) ポートの契約テストを両実装で実行する（PostgreSQL 版は統合テスト、H2 版はユニット）、(c) 受け入れ（Cucumber の `@api`）は PostgreSQL で実行する。

**選択と安全策**: 実行する DB は、設定（プロファイル。例: `DB_KIND=postgres|h2`）で選ぶ。**本番・ステージングで H2 が選ばれないよう、起動時の検査で、本番・ステージングの環境では H2 を拒否し、起動に失敗する**（[インフラ](./architecture-infrastructure.md)）。H2 の版（2.5.252）は 2026-11-14 に Maven Central で確認した値で、公式のサポート期限は確認できていない。PostgreSQL モードで動く機能の範囲は、公式ドキュメントでは確認できなかったため、**B1 の最初に実測して確定する**。

## beer-game2 からの変更

| # | beer-game2 | beer-game-kotlin | 理由 |
| :--- | :--- | :--- | :--- |
| 1 | TypeScript（全層） | バックエンドは Kotlin、フロントエンドは TypeScript | ユーザーの決定。ガイドに準拠 |
| 2 | Node.js 26 LTS（実行環境） | JDK 25 LTS。Node は、フロントエンドのビルドとテストだけ | JVM 版 |
| 3 | Fastify と `@fastify/*` | Ktor と公式プラグイン | 同上 |
| 4 | zod による検証 | スマートコンストラクタ + `zipOrAccumulate` | ドメインの型で不正な値を排除（ガイド §3.4） |
| 5 | `pg` の直接利用 | JDBC + HikariCP の直接利用 | ORM を使わない方針を維持 |
| 6 | node-pg-migrate | Flyway | JVM で標準的 |
| 7 | Pino、EMF の JSON | `LogRecord` の JSON と EMF の JSON（Logback は枠組みのログ用） | 型で資格・表示名の漏れを防ぐ（ガイド §7.7） |
| 8 | Vitest、fast-check | Kotest（プロパティを含む）、Kover | ガイド §8 |
| 9 | ESLint、typescript-eslint、Prettier | detekt、ktlint（フロントエンドは変更なし） | ガイド §9 |
| 10 | tsx、`npm audit` | Gradle の依存関係の検査（選定未決） | 実装開始時に選定 |
| 11 | 状態は行の更新 | イベントの追記（専用の製品を使わず PostgreSQL） | 設計判断 T1 |
| 12 | `package-lock.json` で固定 | Gradle のバージョンカタログと依存関係ロック | JVM 版 |
| 13 | 型を共有（TypeScript） | API の契約は `contracts/openapi.yaml`（手書きの正本）。開始 API、`If-Match` の範囲、SSE のストリーム種別、problem+json の `type` / `code` が変わる | 言語が分かれた。実態に合わせた（M16） |
| 14 | 純粋性・規約はレビューと ESLint | detekt の `ForbiddenMethodCall` で時計・乱数の呼び出しを禁止。detekt と Kotlin 2.4 の互換を最初のビルドの受入条件にする | M17、M18 |
| 15 | （該当なし。Node の期限を使っていた） | JDK 25 の EOL は Temurin の値（2031-09-30）に統一 | 使う配布の値（M17） |
| 16 | 受入は、Vitest と Playwright のテスト | 受入条件・デモ項目は日本語 Gherkin。バックエンドは Cucumber-JVM（`@api`）、画面は Cucumber-JS + Playwright（`@ui`）。純粋関数・性質・DB/HTTP の細部は Kotest の Given/When/Then | 2026-11-14 の決定。チームの規約（Given/When/Then を先に定義）を、業務の言葉の契約として実行できる形にする。生きたドキュメントは CI で自動公開 |
| 17 | ESLint の警告は許容する運用もありうる | 静的解析は厳格に適用（違反 0 件、ベースラインなし、`@Suppress` なし）。PMD の XPath を補完として採用（導入は承認待ち）。層ごとにルールセットを分ける | 2026-11-14 の決定。AI が大量にコードを生成するため、規約違反を機械で守らせる（開発戦略） |
| 18 | ローカルの DB は Docker の PostgreSQL 18 | ローカル開発（起動・動作確認）だけ H2 の PostgreSQL モード（2.5.252 を第一候補。導入は承認待ち）。統合テスト・CI・ステージング・本番は PostgreSQL 18 のまま。PostgreSQL 固有の機能はポートの裏に置き、H2 版を持つ。本番・ステージングでは H2 を拒否 | ユーザーの決定（2026-11-14）。設計判断 T7 |

## アップグレード計画

| 時期 | 対象 | 内容 |
| :--- | :--- | :--- |
| 実装の開始時 | 全体 | 上の版へ更新し、Gradle のロックで固定。**Kotlin 2.4.21 と Gradle 9.9.1、detekt、Arrow、Kover、Kotest、Ktor の組み合わせを、最初のビルドで確認**する。確認できなかった項目（本書で「実装開始時に確認」としたもの）を、ここで埋める |
| 実装の期間中 | JDK | 25 のパッチ版のみ更新（LTS を維持） |
| 2029 年末まで | JDK 25 | EOL 2031-09-30 まで。次の LTS への更新は、2030 年ごろに計画する（次の LTS の版は未確認） |
| detekt 2 が安定版になった時 | detekt | 1.23.8（または代替）から 2 系へ。ルールを緩めずに移行し、fixture のテストで回帰を確かめる |
| PMD の新しい版が出た時 | PMD | 7.29.0 から更新する場合は、fixture の期待件数が変わらないことを確かめてから上げる（ガイドは 7.29.0 で確認。他の版では保証されない） |
| Kotlin 2.4 のサポートが終わる前 | Kotlin | 次のマイナーへ。サポート終了日は公表されていないため、Kotlin のリリースの通知を確認する |
| 継続 | 依存パッケージ | メジャーの更新は、変更点を確認して小さく行う |

## 未決事項

- **確認できていない項目**（受入条件: 最初のビルド。detekt と PMD は「規約違反のコードを置き、CI が落ちること」）: Kotlin 2.4.21 と Gradle 9.9.1、detekt 1.23.8、PMD 7.29.0 の Kotlin 2.4 の構文の解析、Arrow 2.3.0（`arrow-fx-coroutines`、`arrow-resilience` の版）、Kover、Kotest 6.2.7 と JUnit の組み合わせ、HikariCP 7.1.0 と JDK 25、Cucumber-JVM 8.0.4 と JUnit Platform・Kotlin の組み合わせ、Cucumber-JS 13.3.0 と Playwright の組み合わせ。実装開始時にビルドで確認する。
- **承認待ち**: PMD の導入（新規の CI ツール）、Cucumber-JVM と Cucumber-JS の依存関係の導入（導入は決定済み。版は確認済み）。承認の後、開発戦略の未決事項（技術スタックへの Cucumber の追加）は解消する。
- **公式のサポート期限を確認できていない**: Cucumber-JVM、Cucumber-JS、PMD（Maven Central と npm の最新の版と更新日だけを確認した）。
- **選定未決**: 生きたドキュメントの公開の道具（Pickles、Cucumber Reports など。B1〜B2 で選び、版を確認）、変異テストの道具（Pitest の Kotlin 対応は未確認）、Gradle の依存関係の検査の道具、Dependabot と Renovate のどちらを使うか。
- PMD の Gradle での実行方法（プラグインか、CLI の実行か）。detekt の設定値（ルール名と既定値）は、導入する版の公式ドキュメントで確認する。
- フィーチャーファイルの配置（共有の `features/` か、処理系ごとか）と、Cucumber のステップ定義の置き場（B1）。
- Docker の実行イメージ（Temurin の JRE を含むもの。`25-jre-noble` を想定）の名前とタグの確定。
- **解決済み（M16）**: API の契約（`contracts/openapi.yaml` の手書きを正本）、マイグレーション（Flyway。導入は承認待ち）、ログ（Logback）、JSON とアップキャスト（kotlinx.serialization と `EventCodec`。アップキャストは `adapter-persistence`）、SSE（`ktor-server-sse`）。
- **H2（設計判断 T7）**: 導入の承認待ち。H2 の PostgreSQL モードで動く範囲（アドバイザリロック、LISTEN/NOTIFY、部分インデックス、ロール/GRANT、JSONB、SQLSTATE、分離レベル）は公式ドキュメントで確認できなかったため、**B1 の最初に実測して確定**する。H2 2.5.252 と JDK 25、Flyway 13.12.2 との組み合わせ、公式のサポート期限、Flyway の H2 用の扱い（`flyway-core` に含まれるかを含む）は、実装開始時に確認する。
- Ktor のエンジン（Netty か CIO）の最終確認（設計判断 T2）。
- `ktor-server-rate-limit` の状態を共有する方法（参加・復帰の専用の制限。beer-game2 から継続）。
- フレームワークのログ（Ktor、Hikari、Flyway）を JSON にするか（追加の依存関係が要る）。

## 出典

- endoflife.date の API（`kotlin`、`eclipse-temurin`、`gradle`、`postgresql`）、2026-11-14
- Maven Central の `maven-metadata.xml`（`io.ktor:ktor-server-core`、`io.arrow-kt:arrow-core`、`org.jetbrains.kotlinx:kotlinx-coroutines-core`、`kotlinx-serialization-json`、`org.postgresql:postgresql`、`com.zaxxer:HikariCP`、`org.flywaydb:flyway-core`、`io.kotest:kotest-runner-junit5`、`kotest-property`、`org.junit.jupiter:junit-jupiter`、`org.testcontainers:testcontainers-postgresql`、`io.gitlab.arturbosch.detekt:detekt-cli`、`dev.detekt:detekt-cli`、`com.pinterest.ktlint:ktlint-cli`、`ch.qos.logback:logback-classic`、`io.cucumber:cucumber-java`、`io.cucumber:cucumber-junit-platform-engine`、`org.junit.platform:junit-platform-suite`、`net.sourceforge.pmd:pmd-core`、`net.sourceforge.pmd:pmd-kotlin`）、npm レジストリ（`@cucumber/cucumber`）、GitHub の PMD のリリース（`pmd/pmd`）、Gradle プラグインポータル（`org.jetbrains.kotlinx:kover-gradle-plugin`）、2026-11-14
- Maven Central の `com/h2database/h2/maven-metadata.xml` と `2.5.252/` の一覧・pom、H2 公式ドキュメント `https://h2database.com/html/features.html`（PostgreSQL 互換モード）、2026-11-14
- Ktor 公式ドキュメント（`https://ktor.io/docs/server-server-sent-events.html`、`https://ktor.io/docs/server-rate-limit.html`）、2026-11-14
- [開発戦略（Kotlin 版）](../../development/beer-game-kotlin/development_strategy.md)（静的解析の厳格な適用、BDD と Cucumber の導入）
- [beer-game2 の技術スタック](../beer-game2/tech-stack.md)（フロントエンド・インフラの版。2026-11-09 の確認値）
- [関数型プログラミングガイド（Kotlin 編）](../../reference/関数型プログラミングガイド_Kotlin編.md) 第 3 章、第 4 章、第 7 章、第 8 章、第 9 章、第 10 章
- [ドメインモデル（Kotlin 版）](./domain-model.md)、[データモデル（Kotlin 版）](./data-model.md)、[テスト戦略](./test-strategy.md)、[非機能要件](./non-functional.md)
- [ADR-001](../../adr/beer-game2/001-rebuild-as-beer-game2.md)、[ADR-013](../../adr/beer-game2/013-tech-stack-versions.md)
