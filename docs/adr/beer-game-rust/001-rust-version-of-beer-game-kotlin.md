---
type: ADR
title: "ADR-001: beer-game-kotlin を Rust 版として作り、設計と ADR を流用する"
description: "beer-game2 の要件・ストーリー・Unit 定義と beer-game-kotlin の設計を正本として流用し、Rust（axum + sqlx + tokio）と既存の React で作り直す。beer-game-kotlin の ADR の引き継ぎ表を含む。"
tags: [adr]
status: draft
generated: { by: claude-code/claude-sonnet-5-5, at: 2026-11-21T01:07:57Z }
---

# ADR-001: beer-game-kotlin を Rust 版として作り、設計と ADR を流用する

beer-game-kotlin と同じ機能と振る舞いを、Rust（axum + sqlx + tokio）のバックエンドと既存の React のフロントエンドで作り直す（beer-game-rust）。要件・ユースケース・ストーリー・Unit 定義は beer-game2 のものを、設計は beer-game-kotlin のものを正本として参照して流用し、ADR は本書の引き継ぎ表に従って引き継ぐ・変更する・置き換える。

日付: 2026-11-19

## ステータス

承認済み（2026-11-19、ユーザーの決定）

ユーザーが決めた事項は、Rust 版の作成、バックエンドの技術スタック（axum + sqlx + tokio、フロントエンドは既存の React を踏襲）、今回の範囲（土台、ADR-001、技術スタック、ドメインモデル）である。引き継ぎ表は、AI が beer-game-kotlin の ADR の本文を読んで検証した案を、ユーザーが 2026-11-19 に承認した。

## コンテキスト

beer-game2 は要件（BR・FR・NFR）、ユースケース、ストーリー、Unit 定義（U1〜U6）を持つ。beer-game-kotlin は、それを正本として、ES + CQRS と関数型コア（Arrow）で設計した（[設計書の入口](../../design/beer-game-kotlin/index.md)、ADR 001〜020）。

Rust 版は、同じ学習の価値を、型システムによる不正な状態の排除（enum、newtype、所有権）と、実行時の安全性・小さな実行ファイルで提供することを狙う。参考として [関数型プログラミングガイド（Rust 編）](../../reference/関数型プログラミングガイド_Rust編.md) がある。

この選択で、次の問題が生じる。

- 要件や設計を作り直すと、beer-game2・beer-game-kotlin との二重管理になり、機能の差が生まれる。
- beer-game-kotlin の ADR の一部は、言語（Arrow、Gradle、detekt、JVM）に依存しており、そのままでは当てはまらない。どれが有効かを明示しないと、系列の ADR が混在する（beer-game-kotlin の ADR-001 と同じ問題）。

## 決定

- **機能と振る舞いは、beer-game2 を正本として引き継ぐ。** 要件・ユースケース・ストーリー・Unit 定義は新しく作らず、`docs/requirements/beer-game-ts/` を参照する。範囲は beer-game2・beer-game-kotlin と同じ（Unit U1〜U6）。
- **設計の構造は、beer-game-kotlin を正本として引き継ぐ。** ES + CQRS、`game` と `session` の 2 ストリーム、`decide` / `evolve` の純粋関数、投影、保持削除などの構造は変えず、Rust の表現に置き換える。設計書は `docs/design/beer-game-rust/` に、beer-game-kotlin と同じ文書構成で作り、各文書に「beer-game-kotlin からの変更」を設ける。
- **技術スタックは、バックエンドを Rust（axum + sqlx + tokio）、フロントエンドを既存の React / TypeScript とする。** API の契約は、beer-game-kotlin の `contracts/openapi.yaml`（手書き）を正本として共有する方針を第一候補とし、扱いは技術スタックの設計で定める。版は設計時に実際に確認して固定し、**技術スタック（[tech-stack.md](../../design/beer-game-rust/tech-stack.md)）の設計判断 R7 と確認した版の表に記録する**（版を固定する時点で ADR が必要になれば、別の ADR を起票する。2026-11-21 のレビューで、存在しない「別の ADR」への参照を直した）。
- **コーディングは、関数型プログラミングガイド（Rust 編）に準拠する。** 失敗は `Result` と型付きのエラー（列挙型）で表し、ドメインを副作用のない関数で書く。
- **beer-game-kotlin の ADR は、次の表のとおり扱う。** beer-game-kotlin の ADR のファイルは履歴として変更しない。

### beer-game-kotlin の ADR の引き継ぎ表

扱いは、beer-game-kotlin の ADR 002〜020 の**本文を読んで検証した**案である（2026-11-19。調査はサブエージェントが行い、判定の根拠は各 ADR の決定の節）。見出しだけで付けた初稿から、007・011・013・014 の判定または理由を修正し、005・008・018・020 に補足を足した。なお、引き継ぎ元の ADR の多くは Kotlin 版でも「提案中」で、承認済みではない（**002〜020 のうち承認済みは 002・012・015〜019**。020 は提案。001 は本書の元の ADR で承認済み。2026-11-21 のレビューで、002 を落としていた誤りを訂正）。

| beer-game-kotlin の ADR | Rust 版での扱い | 内容 |
| :--- | :--- | :--- |
| 001 Kotlin 版として作り、要件と ADR を流用 | **引き継ぐ**（本書へ） | 正本を流用する方針を Rust 版でも取る |
| 002 ES と CQRS、2 ストリーム | **引き継ぐ** | 構造は同じ |
| 003 投影の同期更新、スナップショットなし | **引き継ぐ** | 構造は同じ |
| 004 冪等記録は認可の後に置く | **引き継ぐ** | 言語に依存しない |
| 005 楽観的並行制御と、投影再構築の直列化にアドバイザリロック | **引き継ぐ**（実現を変更） | sqlx のトランザクションで実現する。コルーチンの取消（`NonCancellable`、`CancellationException`）の節は使えず、tokio の非同期キャンセル時のトランザクションの閉じ方に書き換える |
| 006 イベントのスキーマ進化（アップキャスト、2 段階リリース） | **引き継ぐ**（実現を変更） | EventCodec を serde で実現する |
| 007 Arrow による関数型コア、Gradle で層を強制 | **変更**（趣旨は引き継ぎ、実現を置き換える） | 純粋な `decide` / `evolve`、副作用は境界へ、`evolve` の全域化、依存の向きの機械的な強制は言語に依存せず引き継ぐ。置き換えるのは Arrow（`Either`・`Raise`・`zipOrAccumulate`）と Gradle・detekt・PMD の部分で、`Result`・enum・newtype と Cargo ワークスペースの crate 境界にする |
| 008 OpenAPI 手書きと problem+json のエラーコード | **引き継ぐ** | 契約（`openapi.yaml`、`code` の一覧）と、フロントエンドの型生成・`@redocly/cli` は共有する。バックエンドの契約テスト（Ktor `testApplication`、json-schema-validator）は Rust（axum）で再実装する |
| 009 観察者を DB ロールで分ける | **引き継ぐ** | 接続プールの分け方を sqlx で実現する |
| 010 events 追記専用、game_roots の連鎖削除 | **引き継ぐ** | 言語に依存しない |
| 011 厳格な静的解析（detekt、PMD） | **置き換える** | 厳格さの原則（違反 0 件、ベースラインなし、抑制なし、緩和は ADR に記録して人が承認、純粋性の静的検査）は引き継ぐ。ツールを clippy（`disallowed_methods` など）、rustfmt、`-D warnings` に置き換える。`cargo deny` は ADR-011 に根拠が無く、Kotlin 版の ADR-013 の「依存関係の脆弱性検査（選定未決）」に対応する別の選定である |
| 012 日本語 Gherkin と Cucumber | **変更** | Cucumber の Rust 実装などを設計時に比較する |
| 013 技術スタックの版 | **置き換える**（バックエンド部分）。PostgreSQL 18、Node 26 LTS、フロントエンド・インフラ・CI の版と運用原則は引き継ぐ | Rust・axum・sqlx・tokio の版を、確認したうえで固定する（記録先は tech-stack.md の R7 と版の表）。「ライブラリのサポート期限は書かない」「新規の依存は導入時に承認を得る」「確認日を記録する」は引き継ぐ |
| 014 ローカル開発だけ H2 | **見直す** | 動機（ローカル起動を軽くする。ユーザーの決定）と、固有機能をポート（`ProjectionLock`・`ChangeNotifier`）で抽象化する考え方は言語に依存しない。H2 は JVM の組み込み DB で Rust では使えないため、代替の DB（PostgreSQL のみとするか、別の軽量 DB か）は本文に記載がなく、設計時の未決事項として比較する |
| 015 復帰資格の受け渡しと失効 | **引き継ぐ** | 言語に依存しない |
| 016 資格の鍵の版 | **引き継ぐ** | 言語に依存しない |
| 017 参加・復帰の失敗の窓を DB に持つ | **引き継ぐ** | 言語に依存しない |
| 018 型の注釈から用語集・イベント一覧を生成 | **置き換える** | 方針（型から生成し、不一致を CI で落とす）と CI の 4 検査（注釈漏れ、ID 重複、設計書との差、生成物との差）は引き継ぐ。実現（注釈、リフレクション、テキスト走査）は、属性マクロ、doc コメントなどから設計時に定める（本文に代替の記載なし）。出力先は `docs/design/beer-game-rust/generated/` |
| 019 再試行の上限と間隔 | **見直す** | 値は Kotlin 版の計測にもとづく。Rust 版で再計測して決める |
| 020 資格の Cookie の名前をタブごとにする | **引き継ぐ** | フロントエンドと HTTP の仕様で、言語に依存しない。axum のミドルウェアで Cookie 名を解決する。Kotlin 版でも「提案」で、レビュー待ち |

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
- 引き継ぎ元の ADR の多くは Kotlin 版でも未承認のため、Kotlin 版で内容が変わると、この表の「引き継ぐ」が揺らぐ。003・019 の計測値（千件の再生時間、再試行の上限 10）と 017 の仮置き値（10 回・10 分）は、Rust 版で取り直す。

## コンプライアンス

- **契約の流用**: ストーリーの受入条件を Gherkin のシナリオにタグで対応付け、CI で対応表を検査する方針を引き継ぐ。Rust 版での実現はテスト戦略で定める。
- **API の契約が変わらないこと**: beer-game-kotlin の E2E のシナリオが Rust 版でそのまま使えるかを、最初の Bolt までに確かめる。変わる場合は設計の矛盾として扱う。
- **引き継ぎ表の整合**: 各行を、Rust 版の ADR・設計書を起こす時点で本文を読んで確認すること。レビューで確認する。
- **beer-game-kotlin の ADR を変更しないこと**（履歴）。

## 備考

- 著者: claude-code
- 確認済み: 引き継ぎ表は、beer-game-kotlin の ADR 002〜020 の本文で検証した（2026-11-19）。
- 追記（2026-11-19、ユーザーの決定。表の判定は変えない）: 表の **014（ローカル開発だけ H2）の「見直す」は、ローカルの DB を PostgreSQL 18（Docker）とすることで解決した**。**020（資格の Cookie の名前をタブごとにする）は、Rust 版のバックエンドでも扱う**（Kotlin 版の ADR-020 自体の承認は Kotlin 版の判断）。
- 未確認: Rust 各ライブラリの版と機能（axum・sqlx・tokio、Cucumber の Rust 実装）は未確認で、技術スタックの設計で確認する。
- 関連 ADR: beer-game-kotlin の [ADR-001](../beer-game-kotlin/001-kotlin-version-of-beer-game2.md)、[ADR-002](../beer-game-kotlin/002-event-sourcing-and-cqrs.md)、[ADR-007](../beer-game-kotlin/007-functional-core-with-arrow.md)。beer-game2 の [ADR-001](../beer-game-ts/001-rebuild-as-beer-game2.md)
- 参照: [beer-game-kotlin の設計書](../../design/beer-game-kotlin/index.md)、[関数型プログラミングガイド（Rust 編）](../../reference/関数型プログラミングガイド_Rust編.md)、[ユーザーストーリー](../../requirements/beer-game-ts/user_story.md)、[Unit 定義](../../requirements/beer-game-ts/unit_definition.md)
