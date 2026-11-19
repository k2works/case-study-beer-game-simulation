---
type: ADR
title: "ADR-001: beer-game-kotlin を Rust 版として作り、設計と ADR を流用する"
description: "beer-game2 の要件・ストーリー・Unit 定義と beer-game-kotlin の設計を正本として流用し、Rust（axum + sqlx + tokio）と既存の React で作り直す。beer-game-kotlin の ADR の引き継ぎ表を含む。"
tags: [adr]
status: draft
generated: { by: claude-code/claude-sonnet-5-5, at: 2026-11-19T07:31:09Z }
---

# ADR-001: beer-game-kotlin を Rust 版として作り、設計と ADR を流用する

beer-game-kotlin と同じ機能と振る舞いを、Rust（axum + sqlx + tokio）のバックエンドと既存の React のフロントエンドで作り直す（beer-game-rust）。要件・ユースケース・ストーリー・Unit 定義は beer-game2 のものを、設計は beer-game-kotlin のものを正本として参照して流用し、ADR は本書の引き継ぎ表に従って引き継ぐ・変更する・置き換える。

日付: 2026-11-19

## ステータス

提案中（2026-11-19）。承認はまだ記録しない。

ユーザーが決めた事項は、Rust 版の作成、バックエンドの技術スタック（axum + sqlx + tokio、フロントエンドは既存の React を踏襲）、今回の範囲（土台、ADR-001、技術スタック、ドメインモデル）である。本書の引き継ぎ表の各判断は AI の提案であり、人の承認を待つ。

## コンテキスト

beer-game2 は要件（BR・FR・NFR）、ユースケース、ストーリー、Unit 定義（U1〜U6）を持つ。beer-game-kotlin は、それを正本として、ES + CQRS と関数型コア（Arrow）で設計した（[設計書の入口](../../design/beer-game-kotlin/index.md)、ADR 001〜020）。

Rust 版は、同じ学習の価値を、型システムによる不正な状態の排除（enum、newtype、所有権）と、実行時の安全性・小さな実行ファイルで提供することを狙う。参考として [関数型プログラミングガイド（Rust 編）](../../reference/関数型プログラミングガイド_Rust編.md) がある。

この選択で、次の問題が生じる。

- 要件や設計を作り直すと、beer-game2・beer-game-kotlin との二重管理になり、機能の差が生まれる。
- beer-game-kotlin の ADR の一部は、言語（Arrow、Gradle、detekt、JVM）に依存しており、そのままでは当てはまらない。どれが有効かを明示しないと、系列の ADR が混在する（beer-game-kotlin の ADR-001 と同じ問題）。

## 決定

- **機能と振る舞いは、beer-game2 を正本として引き継ぐ。** 要件・ユースケース・ストーリー・Unit 定義は新しく作らず、`docs/requirements/beer-game2/` を参照する。範囲は beer-game2・beer-game-kotlin と同じ（Unit U1〜U6）。
- **設計の構造は、beer-game-kotlin を正本として引き継ぐ。** ES + CQRS、`game` と `session` の 2 ストリーム、`decide` / `evolve` の純粋関数、投影、保持削除などの構造は変えず、Rust の表現に置き換える。設計書は `docs/design/beer-game-rust/` に、beer-game-kotlin と同じ文書構成で作り、各文書に「beer-game-kotlin からの変更」を設ける。
- **技術スタックは、バックエンドを Rust（axum + sqlx + tokio）、フロントエンドを既存の React / TypeScript とする。** API の契約は、beer-game-kotlin の `contracts/openapi.yaml`（手書き）を正本として共有する方針を第一候補とし、扱いは技術スタックの設計で定める。版は設計時に実際に確認して固定し、別の ADR で記録する。
- **コーディングは、関数型プログラミングガイド（Rust 編）に準拠する。** 失敗は `Result` と型付きのエラー（列挙型）で表し、ドメインを副作用のない関数で書く。
- **beer-game-kotlin の ADR は、次の表のとおり扱う。** beer-game-kotlin の ADR のファイルは履歴として変更しない。

### beer-game-kotlin の ADR の引き継ぎ表

扱いは、各 ADR の見出し（決定内容）から判断した暫定の案である。本文は読んでいないため、各 ADR を Rust 版で起こす時点で本文を確認し、この表を更新する。

| beer-game-kotlin の ADR | Rust 版での扱い | 内容 |
| :--- | :--- | :--- |
| 001 Kotlin 版として作り、要件と ADR を流用 | **引き継ぐ**（本書へ） | 正本を流用する方針を Rust 版でも取る |
| 002 ES と CQRS、2 ストリーム | **引き継ぐ** | 構造は同じ |
| 003 投影の同期更新、スナップショットなし | **引き継ぐ** | 構造は同じ |
| 004 冪等記録は認可の後に置く | **引き継ぐ** | 言語に依存しない |
| 005 楽観的並行制御と、投影再構築の直列化にアドバイザリロック | **引き継ぐ** | sqlx のトランザクションで実現する |
| 006 イベントのスキーマ進化（アップキャスト、2 段階リリース） | **引き継ぐ**（実現を変更） | EventCodec を serde で実現する |
| 007 Arrow による関数型コア、Gradle で層を強制 | **置き換える** | `Result` と純粋関数に、Gradle のモジュールを Cargo のワークスペースの crate に |
| 008 OpenAPI 手書きと problem+json のエラーコード | **引き継ぐ** | 契約を共有する |
| 009 観察者を DB ロールで分ける | **引き継ぐ** | 接続プールの分け方を sqlx で実現する |
| 010 events 追記専用、game_roots の連鎖削除 | **引き継ぐ** | 言語に依存しない |
| 011 厳格な静的解析（detekt、PMD） | **置き換える** | clippy、rustfmt、`cargo deny` などに置き換える |
| 012 日本語 Gherkin と Cucumber | **変更** | Cucumber の Rust 実装などを設計時に比較する |
| 013 技術スタックの版 | **置き換える** | Rust・axum・sqlx・tokio の版を、確認したうえで別の ADR で固定する |
| 014 ローカル開発だけ H2 | **見直す** | JVM 固有の判断。ローカルの DB の選択を、設計時の未決事項として比較する |
| 015 復帰資格の受け渡しと失効 | **引き継ぐ** | 言語に依存しない |
| 016 資格の鍵の版 | **引き継ぐ** | 言語に依存しない |
| 017 参加・復帰の失敗の窓を DB に持つ | **引き継ぐ** | 言語に依存しない |
| 018 型の注釈から用語集・イベント一覧を生成 | **置き換える** | 注釈（Kotlin）の代わりの方式（属性マクロ、doc コメントなど）を設計時に定める |
| 019 再試行の上限と間隔 | **見直す** | 値は Kotlin 版の計測にもとづく。Rust 版で再計測して決める |
| 020 資格の Cookie の名前をタブごとにする | **引き継ぐ** | フロントエンドと HTTP の仕様で、言語に依存しない |

### 代替案

- beer-game-kotlin のみを維持する: 手間は小さいが、ユーザーは Rust 版を求めている。
- 要件・設計を Rust 版にコピーして改訂する: 正本が複数になり、差が生まれる。
- Rust の別の Web フレームワーク（actix-web + diesel など）を採る: 技術スタックの設計で比較に載せる。今回のユーザーの決定は axum + sqlx + tokio である。
- beer-game-kotlin の ADR をすべて有効とする: 層の強制、静的解析、技術スタックの版が Rust 版と矛盾する。

## 影響

### ポジティブ

- 機能の正本が beer-game2、設計の正本が beer-game-kotlin で、Rust 版は言語による表現の差に集中できる。
- どの判断が引き継がれ、どれが変わったかが、本書の 1 か所で分かる。

### ネガティブ

- 三つの系列（beer-game2、beer-game-kotlin、Rust 版）の文書を、読み手が参照する必要がある。
- beer-game-kotlin の設計が変わると、Rust 版にも影響する。変更は正本側で行い、Rust 版へ追従する。
- 引き継ぎ表の暫定の判断が、本文の確認で変わる可能性がある。

## コンプライアンス

- **契約の流用**: ストーリーの受入条件を Gherkin のシナリオにタグで対応付け、CI で対応表を検査する方針を引き継ぐ。Rust 版での実現はテスト戦略で定める。
- **API の契約が変わらないこと**: beer-game-kotlin の E2E のシナリオが Rust 版でそのまま使えるかを、最初の Bolt までに確かめる。変わる場合は設計の矛盾として扱う。
- **引き継ぎ表の整合**: 各行を、Rust 版の ADR・設計書を起こす時点で本文を読んで確認すること。レビューで確認する。
- **beer-game-kotlin の ADR を変更しないこと**（履歴）。

## 備考

- 著者: claude-code
- 未確認: 引き継ぎ表は、beer-game-kotlin の ADR の見出しだけで判断した暫定である。Rust 各ライブラリの版と機能（axum・sqlx・tokio、Cucumber の Rust 実装）は未確認で、技術スタックの設計で確認する。
- 関連 ADR: beer-game-kotlin の [ADR-001](../beer-game-kotlin/001-kotlin-version-of-beer-game2.md)、[ADR-002](../beer-game-kotlin/002-event-sourcing-and-cqrs.md)、[ADR-007](../beer-game-kotlin/007-functional-core-with-arrow.md)。beer-game2 の [ADR-001](../beer-game2/001-rebuild-as-beer-game2.md)
- 参照: [beer-game-kotlin の設計書](../../design/beer-game-kotlin/index.md)、[関数型プログラミングガイド（Rust 編）](../../reference/関数型プログラミングガイド_Rust編.md)、[ユーザーストーリー](../../requirements/beer-game2/user_story.md)、[Unit 定義](../../requirements/beer-game2/unit_definition.md)
