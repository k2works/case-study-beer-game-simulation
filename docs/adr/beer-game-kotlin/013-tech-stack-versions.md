---
type: ADR
title: "ADR-013: 技術スタックの版を、確認済みの値で固定する（JDK 25 LTS、Kotlin 2.4、PostgreSQL 18）"
description: "Kotlin 版の実行環境と主要な依存関係の版を、2026-11-14 に公式の情報で確認した値で定める。確認できていない組み合わせは未確認と明記し、実装開始時に確認する。beer-game2 の ADR-013 を置換する。"
tags: [adr]
status: draft
generated: { by: claude-code/claude-sonnet-5-5, at: 2026-11-14T08:15:50Z }
---

# ADR-013: 技術スタックの版を、確認済みの値で固定する（JDK 25 LTS、Kotlin 2.4、PostgreSQL 18）

バックエンドの実行環境と主要な依存関係の版を、2026-11-14 に公式の情報源で確認した値で定める。確認できなかった組み合わせは「未確認」と明記し、実装開始時（B1・B2）のビルドで確認する。

日付: 2026-11-14

## ステータス

提案中（レビュー待ち）。beer-game2 の [ADR-013](../beer-game2/013-tech-stack-versions.md) を、Kotlin 版では本 ADR で**置換**する（Node 中心の決定は、フロントエンドのビルドとテストにだけ残る）。

## コンテキスト

beer-game2 の ADR-013 は Node 26 LTS、PostgreSQL 18、TypeScript 6.0 を定めた。Kotlin 版では、バックエンドが JVM になる（[ADR-001](./001-kotlin-version-of-beer-game2.md)）。JDK のサポート期限は配布ごとに値が異なり、設計書の間にも食い違いがあった（技術スタックは 2031-09-30、インフラは 2030-09-30。設計レビュー M17）。ライブラリの公式のサポート期限の表は確認できなかった。Gradle がテスト済みの Kotlin の範囲は 2.4.20-Beta1 までで、Kotlin 2.4.21 との組み合わせはビルドで確認する必要がある。

## 決定

2026-11-14 の確認値で固定する（出典は技術スタックの「確認の方法と範囲」）。

| 区分 | 版 | 備考 |
| :--- | :--- | :--- |
| JDK | **25（LTS）**、Eclipse Temurin | EOL 2031-09-30。26 と 27 は LTS でない |
| Kotlin | **2.4.21** | 第一候補 |
| Gradle | **9.9.1** | |
| PostgreSQL | **18**（最新 18.7、EOL 2030-11-14） | RDS の標準サポート 2031-02-28 は beer-game2 の確認値 |
| Ktor | 3.6.1 | |
| Arrow | `arrow-core` 2.3.0 | |
| kotlinx.coroutines | 1.11.0 | |
| kotlinx.serialization | `kotlinx-serialization-json` 1.13.0 | |
| PostgreSQL JDBC | 42.7.14 | |
| HikariCP | 7.1.0 | |
| Flyway | 13.12.2 | 導入は承認待ち |
| Logback Classic | 1.6.6 | 導入は承認待ち |
| Kotest | 6.2.7 | |
| Testcontainers | 2.0.5（`testcontainers-postgresql`） | 1 系は使わない |
| Kover | 0.9.11 | |
| Cucumber-JVM | 8.0.4 | 導入は決定済み。承認は別（ADR-012） |
| Cucumber-JS | `@cucumber/cucumber` 13.3.0 | 同上 |
| detekt | 1.23.8 | ADR-011 |
| PMD | 7.29.0 | 承認待ち（ADR-011） |
| ktlint | 1.8.0 | |
| Node.js | 26 LTS | フロントエンドのビルドと E2E にだけ使う |

- **JDK のサポート期限は、使う配布（Eclipse Temurin）の値（2031-09-30）に統一する**。Oracle JDK の 2030-09-30 は使わない配布の値であり、インフラの設計書の記述はこれに合わせる（設計書の修正は別の作業）。
- LTS の次の版は、実装の期間中に採用しない。
- 実装の開始時に最新の安定版へ更新し、Gradle の依存関係ロックまたはバージョンカタログで固定する。ローカル、CI、Docker の JDK と PostgreSQL のメジャーの版を統一する。
- 新しい依存関係は導入時に承認を得る（プロジェクトの規約）。
- **ライブラリのサポート期限は書かない**（公式の表を確認できていないため）。保守の根拠は更新日だけに示す。
- フロントエンド、インフラ、CI の版は、beer-game2 が 2026-11-09 に確認した値を引き継ぎ、本 ADR では再確認していない。

### 未確認の事項（実装開始時に確認）

- Kotlin 2.4.21 と Gradle 9.9.1 の組み合わせ（テスト済みの範囲の上限は 2.4.20-Beta1）。
- JDK 25 での Kotlin、HikariCP、Kover、Kotest、Arrow の動作。`arrow-fx-coroutines` と `arrow-resilience` の同じ版の有無。
- Kover が `test` と `integrationTest` と受入の 2 つ以上のソースセットを合算できること。
- Kotest 6.2.7 が要求する JUnit Platform の版と、Cucumber の組み合わせ。
- detekt 1.23.8 と PMD 7.29.0 による Kotlin 2.4 の解析（ADR-011）。
- 実行イメージ（JDK 25 の JRE を含むもの）の名前とタグ。変異テストの道具、依存関係の脆弱性検査（選定未決）。

### 代替案

- JDK 21 LTS など一段下の版: 新しい版の未知の不具合を避けられる可能性がある。ただし、JDK 21 の EOL は設計書で確認していない（未確認）。JDK 25 が LTS で確認済みの期限が長く、採らない理由が設計書の範囲では無い。
- JDK 26 または 27: LTS でなく、EOL が 2026-09-22、2027-03-23 と短い。
- Spring Boot: ユーザーが却下した（バックエンドは Ktor。技術スタックの設計判断 T2）。

## 影響

### ポジティブ

- 版とサポート期限の根拠が確認日つきで残り、環境間の不一致が減る。
- 確認できていない組み合わせが明示され、B1・B2 の受入条件になる。

### ネガティブ

- 最新の版の組み合わせで、未知の不具合が出うる（Kotlin 2.4.21 は Gradle のテスト済みの範囲の上限を超える）。
- ライブラリの EOL を示せないため、サポートの切れ目を事前に把握できない。
- 最新の安定版へ更新する運用で、版の確認を実装開始時にやり直す手間が要る。

## コンプライアンス

- **B1**: Kotlin 2.4・JDK 25・Gradle・Ktor・Arrow の組み合わせでウォーキングスケルトンのビルドが通る。依存関係の導入の承認と版の確認の記録がある。Cucumber と JUnit の版の組み合わせを確かめる。
- **B2**: detekt と PMD が Kotlin 2.4 を解析できる。Kover が複数のソースセットを合算できる。CI で JDK と PostgreSQL の版が統一されている。
- **B3**: コンテナのベースが JDK 25 の JRE（Temurin）で、JVM の起動時間が目標（p95 30 秒）に収まる。
- **各 Bolt**: ビルドの設定の依存関係ロック（またはバージョンカタログ）と、本 ADR の版が一致する。版を変えるときは、本 ADR か後続の ADR を更新する。

## 備考

- 著者: claude-code
- 関連 ADR: [ADR-001](./001-kotlin-version-of-beer-game2.md)、[ADR-011](./011-strict-static-analysis.md)、[ADR-012](./012-gherkin-and-cucumber.md)。置換: beer-game2 の [ADR-013](../beer-game2/013-tech-stack-versions.md)
- 参照: [技術スタック（確認した重要な事項、設計判断）](../../design/beer-game-kotlin/tech-stack.md)、[インフラストラクチャ](../../design/beer-game-kotlin/architecture-infrastructure.md)、[設計レビュー（M17）](../../review/beer-game-kotlin/design_review_20261114.md)、[リリース計画（B1〜B3）](../../development/beer-game-kotlin/release_plan.md)
