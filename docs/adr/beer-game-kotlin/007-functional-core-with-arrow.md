---
type: ADR
title: "ADR-007: ドメインを Arrow の Either と純粋な decide/evolve で書き、層の依存を Gradle のモジュールで強制する"
description: "ドメインは Kotlin 標準と Arrow Core だけに依存する純粋関数（decide/evolve）で書き、失敗は Either と Raise で返し、副作用は外側の層に置く。"
tags: [adr]
status: draft
generated: { by: claude-code/claude-sonnet-5-5, at: 2026-11-14T08:15:50Z }
---

# ADR-007: ドメインを Arrow の Either と純粋な decide/evolve で書き、層の依存を Gradle のモジュールで強制する

ドメインは、Kotlin 標準ライブラリと Arrow Core だけに依存する純粋関数（`decide` / `evolve`）で書く。失敗は例外でなく `Either` と `Raise` で返す。副作用（HTTP、データベース、時計、乱数、ログ）は外側の層に置き、依存の向きは Gradle のモジュール分割で強制する。

日付: 2026-11-14

## ステータス

提案中（レビュー待ち）

## コンテキスト

Kotlin 版は、イベントソーシングと CQRS を採る（ユーザーの決定。[ADR-002](./002-event-sourcing-and-cqrs.md)）。コーディングは、関数型プログラミングガイド（Kotlin 編）に準拠する。ES では、テストの形が Given（過去のイベント）／When（コマンド）／Then（新しいイベント、またはエラー）にそのまま対応するため、ドメインが純粋関数であることの価値が大きい（[テスト戦略](../../design/beer-game-kotlin/test-strategy.md)）。

beer-game2 は、ポートとアダプターで依存の向きを守り、集約のメソッドが状態を変更していた。Kotlin 版では、同じ依存の向きを、関数の型で表すかを決める必要がある。加えて、`evolve`（イベントを状態に適用する関数）が `as` / `as?` の連鎖で書かれると、想定外のイベント列で `ClassCastException` が起き、そのストリームのコマンドが止まる（[ドメインモデル](../../design/beer-game-kotlin/domain-model.md) の「`evolve` の全域化」）。

## 決定

- **ドメインは純粋な `decide` / `evolve` で書く。** `decide` は `(状態, コマンド) -> Either<DomainError, イベント列>`、`evolve` は `(状態, イベント) -> 状態`。状態・コマンド・イベント・エラーは `sealed interface` と `data class` / `value class` で表す。
- **失敗は `Either` と `Raise` で返し、例外は使わない。** 入力の検証は複数の誤りを集める（`zipOrAccumulate`）。
- **依存は関数の型で表す。** 外部とのやり取りは `typealias` と `data class` の関数の束（`Ports`）にする。副作用のある関数は `suspend` とし、型で副作用を示す。DI のコンテナは使わず、`app` で手動に組み立てる（バックエンド設計 BD2）。
- **副作用は境界へ。** ドメインは時計・乱数・UUID の生成を直接呼ばない。
- **`evolve` は全域。** 状態とイベントの組を `else` なしの `when` で網羅し、強制キャスト（`as`、`as?`）を使わない。`decide` が作らない列が来たときは、状態を変えずに返し、`InvalidTransition` を検知（ログとメトリクス）する。
- **モジュールの依存は Gradle で強制する。** `domain` は他のモジュールを参照できず、Kotlin 標準ライブラリと Arrow Core だけに依存する。`application` は `adapter-*` を参照できない。違反はコンパイル時に import できない。detekt と PMD の関数型ルールの検査を二重に重ねる（BD1）。
- コーディングは、関数型プログラミングガイド（Kotlin 編）に準拠する。

設計書の該当節: [バックエンドアーキテクチャ](../../design/beer-game-kotlin/architecture-backend.md)（層と依存の向き、BD1、BD2、モジュール構成と依存の検査）、[ドメインモデル](../../design/beer-game-kotlin/domain-model.md)（`evolve` の全域化と `InvalidTransition`）。

### 代替案

- 従来のオブジェクト指向（集約のメソッドが状態を変更する。beer-game2 の形）: 依存の向きは守れるが、ES の Given/When/Then に対応するテストが書きにくく、状態の変更が隠れる。ドメインが純粋でなくなり、時計や乱数がドメインに入り込みやすい。
- Arrow を使わず標準ライブラリのみ（標準の `Result` と自前の `Either`）: 依存は増えない。ガイドの前提（`Either`、`Raise`、`zipOrAccumulate`）と合わず、誤りを集める検証や型で表すエラーを自前で持つことになる（[技術スタック](../../design/beer-game-kotlin/tech-stack.md) の新規依存関係の表）。
- 1 モジュールで、パッケージ規約を検査ツールで守る（BD1 の案 B）: ビルドは単純だが、依存の違反がツールの設定の穴で通りうる。

## 影響

### ポジティブ

- ドメインのテストにモックが要らない。過去のイベントとコマンドを与えるだけで検証できる。
- `domain` の依存が、コンパイル時に機械的に強制される。
- 差し替えが関数で済み、リフレクションに依存しない。
- 型でエラーと副作用が見える。`evolve` の全域化で、想定外の列でもストリームが止まらない。

### ネガティブ

- モジュールの数だけ Gradle の設定が増え、`app` の組み立てのコードが長くなる。
- 関数型の規約を守る検査（detekt、PMD）の整備が要る（[ADR-011](./011-strict-static-analysis.md)）。
- Arrow は外部ライブラリで、版の組み合わせの確認が要る。Arrow 2.3.0 の確認済みの範囲は `arrow-core` だけで、`arrow-fx-coroutines` と `arrow-resilience` の同じ版の有無は未確認（実装開始時に確認）。Kotlin 2.4.21、Gradle 9.9.1、Arrow の組み合わせも、最初のビルドで確認するまで未確認である。
- 開発者に、関数型のスタイルへの習熟が要る。

## コンプライアンス

- B1（ウォーキングスケルトン）: Gradle のマルチモジュール（domain、application、adapters）を作り、`decideGame` / `decideSession` / `simulateWeek` の最小と、`decide`・`evolve` のプロパティテストを置く。`domain` が他のモジュールを参照すればビルドが失敗する。Kotlin 2.4・JDK 25・Gradle・Ktor・Arrow の組み合わせが動くことを確認する（[リリース計画](../../development/beer-game-kotlin/release_plan.md)）。
- B2: 規約違反のコードを 1 つ置くと CI が落ちることを、detekt と PMD のそれぞれで確認する（`Instant.now` を `ForbiddenMethodCall` で禁止、`var`・`!!`・`throw` などを PMD の関数型ルールで禁止）。`InvalidTransition` の性質テストを置き、`decide` が作らない列を与えても、状態を変えず、例外を投げず、検知が 1 件記録されることを確かめる（[テスト戦略](../../design/beer-game-kotlin/test-strategy.md) の `evolveGame` / `evolveSession` の行）。CI で `domain` の行カバレッジ 100% のゲートを有効にする。
- 全 Bolt: 承認ゲートで、`sealed interface` の `when` に `else` を書かないこと、純粋関数の性質をプロパティテストで書くことを、チェックリストで確認する（構文で表せない規約。開発戦略）。

## 備考

- 著者: claude-code
- 関連 ADR: [ADR-002](./002-event-sourcing-and-cqrs.md)、[ADR-011](./011-strict-static-analysis.md)、[ADR-012](./012-gherkin-and-cucumber.md)、[ADR-013](./013-tech-stack-versions.md)、beer-game2 の [ADR-003](../beer-game2/003-ports-and-adapters-with-lint.md)
- 参照: [バックエンドアーキテクチャ](../../design/beer-game-kotlin/architecture-backend.md)、[ドメインモデル](../../design/beer-game-kotlin/domain-model.md)、[テスト戦略](../../design/beer-game-kotlin/test-strategy.md)、[開発戦略](../../development/beer-game-kotlin/development_strategy.md)、[関数型プログラミングガイド（Kotlin 編）](../../reference/関数型プログラミングガイド_Kotlin編.md)
