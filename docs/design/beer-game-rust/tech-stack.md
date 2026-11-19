---
type: Design
title: "技術スタック選定 - ビールゲームシミュレーション（Rust 版）"
description: "Rust 版の技術スタック。cargo search と rustc で確認した版、確認できなかった項目、beer-game-kotlin からの変更、新規の依存関係の承認表、設計判断を整理した正本。"
tags: [design]
status: draft
generated: { by: claude-code/claude-sonnet-5-5, at: 2026-11-19T07:47:11Z }
---

# 技術スタック選定 - ビールゲームシミュレーション（Rust 版）

## 概要

本書は、beer-game-rust の技術スタックを、版とあわせて一覧にします。**`docs/` を設計の正本**とします。実装コードはまだ存在せず、本書の版は**選定の記録**です。

[beer-game-kotlin の技術スタック](../beer-game-kotlin/tech-stack.md) を出発点に、[ADR-001](../../adr/beer-game-rust/001-rust-version-of-beer-game-kotlin.md) の決定に従って次の方針で改訂しました。

- バックエンドは **Rust（axum + sqlx + tokio）** に変更する（ユーザーの決定、2026-11-19）。フロントエンドは、既存の React / TypeScript を踏襲する。
- アーキテクチャは**イベントソーシング + CQRS**（beer-game-kotlin を正本とする）。コーディングは [関数型プログラミングガイド（Rust 編）](../../reference/関数型プログラミングガイド_Rust編.md) に準拠する。
- **版は、2026-11-19 にローカルで確認できた値だけ**を書く。確認できなかったものは「実装開始時に確認」とする。
- 版は、実装の開始時に、最新の安定版へ更新して固定する（`Cargo.lock` をコミットし、`rust-toolchain.toml` でツールチェーンを固定する）。
- 新しく導入する依存関係は、**導入時に承認を得る**（プロジェクトの規約）。

### 確認の方法と範囲

| 区分 | 確認の手段 | 確認日 |
| :--- | :--- | :--- |
| Rust のツールチェーン | ローカルの `rustc --version`（1.97.1、2026-07-14 のビルド） | 2026-11-19 |
| クレートの最新の版 | `cargo search <名前> --limit 1`（crates.io のレジストリの最新の版。Rust の公式ツール） | 2026-11-19 |
| PostgreSQL、Node.js、フロントエンド | 再確認していない。beer-game-kotlin（2026-11-14）と beer-game2（2026-11-09）の確認値を参照する | - |

**`cargo search` で分かるのは、最新の版の番号だけ**です。公開日、サポート期限、MSRV（必要な最小の Rust の版）、機能フラグ、安定版か否かは分かりません。これらは「未確認」とし、実装開始時（B1）に `cargo info`・ビルドで確認します。

## 選定の方針

- **ドメインは副作用のない関数と型で書く。** 失敗は `Result` と列挙型のエラーで表し、不正な状態は型で作れなくする（newtype、列挙型）。
- **DB は sqlx で直接 SQL を書く。** ORM は使わない（beer-game-kotlin の JDBC 直接と同じ方針）。
- **非同期は tokio に統一する。** ブロッキングの処理は専用のスレッドに閉じ込める。
- **層の境界は Cargo のワークスペースの crate で守る。** beer-game-kotlin の Gradle のモジュールに対応する（ADR-001 の表、007）。
- **API の契約は、beer-game-kotlin の `contracts/openapi.yaml`（手書き）を第一候補として共有する。** 共有の方法（同じファイルを参照するか、複製するか）は未決事項とする。

## 確認した重要な事項

| # | 事項 | 確認結果（2026-11-19） | 判断 |
| :--- | :--- | :--- | :--- |
| 1 | Rust | ローカルは **1.97.1**（2026-07-14）。Rust は LTS を持たず、最新の安定版だけがサポートされる | **1.97.1 を固定**（`rust-toolchain.toml`）。エディションは 2024 を第一候補とし、実装開始時に確認 |
| 2 | axum | 最新は **0.8.9** | **0.8.9**。0.x のため、マイナーの更新で破壊的変更が起きうる。SSE の機能は**未確認** |
| 3 | tokio | 最新は **1.54.1** | **1.54.1** |
| 4 | sqlx | 最新は **0.9.1** | **0.9.1**。PostgreSQL、マイグレーション、アドバイザリロックの機能は**未確認**（B1 で確認） |
| 5 | serde / serde_json | **1.0.229** / **1.0.154** | 採用 |
| 6 | thiserror | **2.0.21** | 採用（型付きのエラー） |
| 7 | tracing / tracing-subscriber | **0.1.44** / **0.3.23** | 採用（構造化ログ。JSON を標準出力へ） |
| 8 | tower / tower-http | **0.5.3** / **0.7.1** | 採用（CORS、ヘッダー、タイムアウトなどの部品）。使うプラグインの名前は**未確認** |
| 9 | proptest | **1.12.0** | プロパティベーステストに採用 |
| 10 | cucumber（cucumber-rs） | **0.23.0** | 日本語 Gherkin の対応は**未確認**。B1 で確認し、不可なら設計判断 R5 の代替へ |
| 11 | testcontainers / testcontainers-modules | **0.28.0** / **0.15.0** | 統合テストに採用。PostgreSQL 18 のイメージの指定は**未確認** |
| 12 | uuid / time | **1.29.3** / **0.3.55** | 識別子と時刻 |
| 13 | sha2 / hmac / rand / base64 | **0.11.1** / **0.13.0** / **0.10.4** / **0.23.1** | 資格のダイジェストと鍵の版、乱数、符号化。**どのクレートを使うかは、資格の設計（ADR-016 の引き継ぎ）で確定する** |
| 14 | tokio-stream / futures / http-body-util | **0.1.19** / **0.3.34** / **0.1.5** | SSE とテストで使う候補 |
| 15 | cargo-llvm-cov | **0.9.1** | カバレッジの計測（設計判断 R6） |
| 16 | cargo-deny | **0.21.0** | 依存関係のライセンス・脆弱性の検査（設計判断 R4） |
| 17 | jsonschema | **0.61.2** | OpenAPI 契約テストの候補（**未確認**。採否は設計時） |
| 18 | reqwest / insta | **0.13.5** / **1.49.0** | HTTP のテストクライアント、スナップショットテストの候補 |
| 19 | PostgreSQL | beer-game-kotlin の確認では 18（18.7、EOL 2030-11-14） | **PostgreSQL 18**。**本書では再確認していない** |
| 20 | Node.js（フロントエンドのビルド・テスト用） | beer-game2 の確認では Node 26 LTS | **Node 26 LTS** を、フロントエンドのビルドと E2E にだけ使う。**本書では再確認していない** |

## バックエンド

| カテゴリ | 技術 | 版 | beer-game-kotlin | 用途 | サポート期限 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| 言語 | Rust | **1.97.1** | Kotlin 2.4.21 | ドメイン、アプリケーション、アダプター | 最新の安定版のみ（LTS なし） |
| ビルド | Cargo（ワークスペース） | Rust に同梱 | Gradle 9.9.1 | ビルド、テスト、依存関係の固定（`Cargo.lock`） | - |
| Web フレームワーク | axum | **0.8.9** | Ktor 3.6.1 | REST API、SSE | - |
| 非同期ランタイム | tokio | **1.54.1** | kotlinx.coroutines 1.11.0 | 非同期の実行、タイマー、ブロッキングの隔離 | - |
| ミドルウェア | tower、tower-http | **0.5.3**、**0.7.1** | Ktor の各プラグイン | CORS、ヘッダー、タイムアウト、リクエスト ID | - |
| 関数型 | 標準の `Result` / `Option` / イテレータ + 自前の誤りの集約 | 標準 | Arrow 2.3.0 | `?` による早期の失敗。複数の誤りを集める関数は自前（[ドメインモデル](./domain-model.md)） | - |
| エラー | thiserror | **2.0.21** | sealed interface のエラー | 型付きのエラーの列挙型 | - |
| シリアライズ | serde、serde_json | **1.0.229**、**1.0.154** | kotlinx.serialization | API の JSON と、イベントの `payload`（`event_type` を判別子にした列挙型）。変換は `EventCodec`、アップキャストは永続化の層 | - |
| DB ドライバ | sqlx（PostgreSQL） | **0.9.1** | JDBC + HikariCP | 接続、接続プール、トランザクション、直接の SQL | - |
| マイグレーション | sqlx の migrate | sqlx に含む（**未確認**） | Flyway 13.12.2 | 番号つきの SQL マイグレーションと履歴 | - |
| ログ | tracing、tracing-subscriber | **0.1.44**、**0.3.23** | SLF4J + Logback | 構造化ログ（JSON）。ログの型に表示名・資格の項目を**持たせない** | - |
| 識別子・時刻 | uuid、time | **1.29.3**、**0.3.55** | java.util.UUID、java.time | 識別子、時刻 | - |
| 資格・乱数 | sha2、hmac、rand、base64 | 上の表のとおり | JDK の標準 | 資格のダイジェスト、乱数、符号化（候補。確定は資格の設計時） | - |
| メトリクス | CloudWatch EMF（JSON 形式） | 依存関係なし | 同左 | 応答時間、競合、再試行、確定など | - |

AWS SDK は、キューを持たない設計のため、**依存関係に含めません**（beer-game-kotlin と同じ）。

### beer-game-kotlin の Ktor プラグインとの対応

| beer-game-kotlin | Rust 版（候補。プラグイン名は未確認） |
| :--- | :--- |
| `ktor-server-cors` | tower-http の CORS の層（許可しない設定） |
| `ktor-server-rate-limit` | 専用の層、または自前（参加・復帰・招待は専用の制限）。**採用するクレートは未確認** |
| `ktor-server-default-headers`、`ktor-server-hsts` | tower-http のヘッダーの層（CSP、`nosniff`、Referrer-Policy、HSTS） |
| `ktor-server-call-logging`、`ktor-server-call-id` | tower-http のトレースの層とリクエスト ID の層 + `tracing` |
| `ktor-server-sse` | axum の SSE の応答（**未確認**） |
| `ktor-server-status-pages` | axum の `IntoResponse` を実装したエラー型 + problem+json |
| Cookie の扱い | 自前に設定する（`HttpOnly`、`Secure`、`SameSite=Strict`） |

## データストア

| カテゴリ | 技術 | 版 | beer-game-kotlin | 用途 | サポート期限 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| RDBMS | PostgreSQL | **18**（RDS、CI、統合テスト、ステージング、本番） | 18 | **イベントストア**、投影、周辺ストア、保持削除の状態 | beer-game-kotlin の確認値は 2030-11-14（再確認していない） |
| スキーマ管理 | sqlx の migrate | 未確認 | Flyway | 履歴テーブルで管理。拡張 → 互換 → 縮小 | - |
| ORM | なし | - | なし | 直接の SQL（sqlx） | - |
| イベントのペイロード | `jsonb` + serde | - | `jsonb` + kotlinx.serialization | `schema_version` とアップキャスト（データモデルは別文書） | - |
| ローカル開発用 DB | **未決**（[未決事項](#未決事項) の 1） | - | H2（PostgreSQL モード） | 開発機での起動・動作確認 | - |

イベントストアの専用製品（EventStoreDB など）は、**導入しません**（設計判断 R1）。

## フロントエンド

既存の React / TypeScript を踏襲します。版は beer-game-kotlin の [技術スタック](../beer-game-kotlin/tech-stack.md) と [フロントエンド](../beer-game-kotlin/architecture-frontend.md) に従い、**本書では再確認していません**。実装開始時に最新の安定版へ更新します。

API の型は、手書きの `openapi.yaml` から生成する方針を引き継ぎます。バックエンドの言語が Rust に変わっても、契約が変わらなければ、フロントエンドと E2E は変わりません。

## テスト・品質

| カテゴリ | 技術 | 版 | beer-game-kotlin | 用途 |
| :--- | :--- | :--- | :--- | :--- |
| 単体・振る舞い | 標準の `#[test]`（テストの構造は Given / When / Then の関数名と構成で表す） | 標準 | Kotest 6.2.7 | 純粋関数、`decide` / `evolve` |
| プロパティベース | proptest | **1.12.0** | Kotest Property | 週次計算の不変条件、イベントの再生 |
| 受入（Gherkin） | cucumber（cucumber-rs） | **0.23.0**（日本語対応は未確認） | Cucumber-JVM 8.0.4 | 受入条件のシナリオ（`@US…` `@AC…` タグ） |
| 統合 | testcontainers、testcontainers-modules | **0.28.0**、**0.15.0** | Testcontainers 2.0.5 | PostgreSQL 18 での統合テスト |
| HTTP | axum を直接呼ぶテスト（tower の `ServiceExt`）、reqwest | tower 0.5.3、reqwest 0.13.5（候補） | ktor-server-test-host | API のテスト |
| スナップショット | insta | **1.49.0**（候補） | - | 生成物（用語集、イベント一覧）の差分確認 |
| 整形 | rustfmt | Rust に同梱 | ktlint 1.8.0 | CI で `cargo fmt --check` |
| 静的解析 | clippy | Rust に同梱 | detekt 1.23.8、PMD 7.29.0 | CI で `cargo clippy -- -D warnings` |
| 依存関係の検査 | cargo-deny | **0.21.0** | - | ライセンス・脆弱性・重複の検査 |
| カバレッジ | cargo-llvm-cov | **0.9.1** | Kover 0.9.11 | 行 80% を基準（team.md の規約）。beer-game-kotlin の目標との関係はテスト戦略で定める |
| 契約テスト | jsonschema（候補） | **0.61.2** | OpenAPI の契約テスト | OpenAPI の応答の検査。**採否は未確認** |

## インフラ・運用

| カテゴリ | 技術 | 版 | beer-game-kotlin | 用途 |
| :--- | :--- | :--- | :--- | :--- |
| コンテナ | マルチステージのビルド。実行イメージは**未決**（[未決事項](#未決事項) の 2） | - | Temurin JRE 25 | Rust は JVM を要さず、単一の実行ファイルにできる |
| CI/CD | GitHub Actions、ECR、OIDC、ステージング自動・本番承認、Terraform | beer-game-kotlin のとおり | 同左 | 構成は引き継ぐ。ジョブは Cargo に置き換える（ADR-001 の 011・012）。AWS への適用は別ゲート |
| 配信 | CloudFront、独自ドメイン、TLS、ヘッダー | beer-game-kotlin のとおり | 同左 | 引き継ぐ |

## 新しく導入する依存関係（導入時に承認を得る）

プロジェクトの規約により、新しい依存関係は導入時に承認を得ます。**本書の段階ではどれも導入していません。** 承認は、B1（ウォーキングスケルトン）の計画で、実際に使うものを確定してから求めます。

| 区分 | 依存関係 | 状況 |
| :--- | :--- | :--- |
| 実行時（中核） | axum、tokio、sqlx、serde、serde_json、thiserror、tracing、tracing-subscriber、tower、tower-http、uuid、time | 選定済み。承認待ち |
| 実行時（資格・SSE） | sha2、hmac、rand、base64、tokio-stream、futures | 候補。資格の設計後に絞って承認を求める |
| 開発・テスト | proptest、cucumber、testcontainers、testcontainers-modules | 選定済み。承認待ち。cucumber は日本語対応の確認後 |
| 開発・テスト（候補） | insta、reqwest、jsonschema、http-body-util | 採否は設計時。承認待ちの前に確定する |
| CI のツール | cargo-llvm-cov、cargo-deny | 選定済み。承認待ち |

## 設計判断

**R1〜R7 は、ユーザーが 2026-11-19 にまとめて承認しました。** ただし、判断の中の未確認項目（R3 のコンパイル時検査の可否、R4 の純粋性の lint、R5 の日本語 Gherkin の対応）は、承認後も未決事項として残り、B1 で確かめます。確かめた結果が判断と食い違う場合は、判断を改訂します。新規の依存関係の導入承認は、これとは別です（承認表のとおり、B1 の計画で求める）。

### R1: イベントストアは、PostgreSQL の `events` 表で自前に実装する

beer-game-kotlin の T1 と同じです。専用製品を入れず、sqlx で `events` 表への追記と読み出しを書きます。ADR-001 の 002・005 の引き継ぎに従います。

### R2: Web フレームワークは axum（ユーザーの決定）

axum は tokio と tower の上に作られており、ミドルウェアを tower の層で組み立てられます。代替案（actix-web + diesel）は、ユーザーが axum + sqlx + tokio を選んだため採りません。0.x のため、更新のたびに変更の影響を確認する運用にします（アップグレード計画）。

### R3: DB は sqlx で直接 SQL を書き、ORM を使わない

beer-game-kotlin の「ORM なし」と同じです。sqlx には、SQL をコンパイル時に検査する機能があるといわれますが、**どの機能を使うか（接続が必要なマクロか、オフラインの検査か）は未確認**です。CI で DB を要さない形にできるかを B1 で確かめます。

### R4: 静的解析は clippy を厳格に適用し、cargo-deny で依存関係を検査する

beer-game-kotlin の T5（detekt を中心に PMD の XPath で補完）に対応します。`cargo clippy -- -D warnings`、`cargo fmt --check`、`cargo deny check` を CI で必須にします。ドメインの純粋性（副作用の呼び出しの禁止）は、clippy の設定だけで足りるかを**未確認**とし、足りなければ crate の依存の制限（ドメインの crate が I/O 系のクレートに依存しない）で守ります。違反は 0 件で、`#[allow(...)]` は理由なしに使いません。

### R5: 受入条件は Gherkin と cucumber-rs で表し、細部は標準のテストで書く

ADR-001 の 012（変更）に対応します。cucumber-rs が日本語の Gherkin（`# language: ja`）を扱えるかは**未確認**です。不可なら、英語のキーワード + 日本語の本文、または別の方式を比較して決めます。

### R6: カバレッジは cargo-llvm-cov で計測し、行 80% を基準にする

team.md の規約（行 80%）に従います。beer-game-kotlin の目標との対応は、テスト戦略の文書で定めます。

### R7: 版の固定

`rust-toolchain.toml` でツールチェーンを、`Cargo.lock` で依存関係を固定します。クレートの更新は、定期的な更新のジョブか手動で行い、`cargo deny` と全テストが通ることを条件にします。

## beer-game-kotlin からの変更

| 項目 | beer-game-kotlin | Rust 版 | 理由 |
| :--- | :--- | :--- | :--- |
| 言語 | Kotlin 2.4.21（JVM） | Rust 1.97.1 | ユーザーの決定 |
| Web | Ktor | axum | ユーザーの決定 |
| 関数型の道具 | Arrow（Either、Raise） | 標準の Result と `?`、thiserror | Rust の標準で足りる。誤りの集約は自前 |
| 非同期 | coroutines | tokio | - |
| DB | JDBC + HikariCP + Flyway | sqlx（接続プールとマイグレーションを含む） | - |
| ビルドと層の強制 | Gradle のモジュール | Cargo のワークスペースの crate | - |
| 静的解析 | detekt、PMD、ktlint | clippy、rustfmt、cargo-deny | - |
| カバレッジ | Kover | cargo-llvm-cov | - |
| ローカル開発の DB | H2（PostgreSQL モード） | 未決 | H2 は JVM の DB のため使えない |
| 実行環境 | JDK 25（Temurin）の JRE | 単一の実行ファイル | JVM が不要 |

## アップグレード計画

- 実装開始時（B1）に、本書の版を `cargo info` とビルドで確かめ、最新の安定版へ更新して固定する。
- axum・sqlx・cucumber・testcontainers は 0.x のため、更新のたびに変更履歴を確認し、破壊的変更の影響を調べる。
- Rust のツールチェーンは、新しい安定版が出るたびに更新を検討する。CI で `rust-toolchain.toml` の版を使う。

## 未決事項

1. **ローカル開発の DB**: Docker の PostgreSQL、組み込みの PostgreSQL、SQLite などを比較して決める。beer-game-kotlin の ADR-014（H2）は、ADR-001 の表で「見直す」とした。
2. **コンテナの実行イメージ**: distroless、debian-slim、scratch などを比較する。TLS の証明書や DNS の扱いも含めて確認する。
3. **sqlx の機能**: PostgreSQL のアドバイザリロック、`LISTEN/NOTIFY`、マイグレーション、コンパイル時の検査（オフラインの可否）。B1 で確認する。
4. **cucumber-rs の日本語対応**: R5 のとおり。
5. **axum の SSE と tower-http のプラグイン**: 使うプラグインの名前と機能を確認する。
6. **API の契約の共有方法**: beer-game-kotlin の `contracts/openapi.yaml` を共有するか、複製するか。
7. **MSRV とサポート**: 各クレートの MSRV が Rust 1.97.1 以下であること、各クレートの公開日と保守状況を `cargo info` で確認する。
8. **エディション**: 2024 を第一候補とするが、ツールチェーンの対応を実装開始時に確認する。

## 出典

- ローカルの `rustc --version`（2026-11-19）。
- `cargo search <名前> --limit 1`（2026-11-19。Rust の公式ツールによる crates.io のレジストリの最新の版）。
- [ADR-001（Rust 版）](../../adr/beer-game-rust/001-rust-version-of-beer-game-kotlin.md)
- [技術スタック（beer-game-kotlin）](../beer-game-kotlin/tech-stack.md)
- [関数型プログラミングガイド（Rust 編）](../../reference/関数型プログラミングガイド_Rust編.md)
