---
type: ADR
title: "ADR-012: 受入条件を日本語 Gherkin と Cucumber で表し、細部は Kotest で書く"
description: "受入条件・デモ項目は日本語 Gherkin（Cucumber-JVM の @api、Cucumber-JS + Playwright の @ui）、ドメインの純粋関数・性質・DB/HTTP の細部は Kotest の Given/When/Then とし、二重に書かない。"
tags: [adr]
status: draft
generated: { by: claude-code/claude-sonnet-5-5, at: 2026-11-14T08:15:50Z }
---

# ADR-012: 受入条件を日本語 Gherkin と Cucumber で表し、細部は Kotest で書く

受入条件とデモ項目は日本語 Gherkin で書き、Cucumber が実行する。ドメインの純粋関数、性質、DB・HTTP の細部は Kotest の Given/When/Then で書く。同じ振る舞いを二重に書かない。

日付: 2026-11-14

## ステータス

承認済み（2026-11-14、ユーザーの決定）。ただし、Cucumber-JVM と Cucumber-JS の**依存関係の導入の承認は別に要る**（B1）。

## コンテキスト

本プロジェクトのチームの規約は「Given/When/Then を実装より先に定義する」である。デモ項目と受入条件は、人と AI の契約（Mob Elaboration の合意）であり、業務の言葉で読め、かつ自動テストとして実行できることが望ましい。シナリオとコードという冗長な知識の整合を、Cucumber が照合する「天秤」になる。

一方、イベントの列は実装の詳細に近く、業務のシナリオにすると冗長になる。そのため、ドメインの細部まで Gherkin にはしない。

## 決定

- **受入条件・デモ項目**（ストーリーの AC、業務シナリオ）は、**日本語 Gherkin**（フィーチャーファイル。先頭に `# language: ja`）で書き、Cucumber で実行する。語彙はユビキタス言語に合わせ、イベント名やテーブル名の実装の言葉を持ち込まない。
- **処理系**は層ごとの公式のもの: バックエンドは **Cucumber-JVM**（`@api`。Gradle のソースセット `acceptanceTest` を想定。Ktor のテスト用アプリケーションと実 PostgreSQL（Testcontainers）を通す）。画面は **Cucumber-JS + Playwright**（`@ui`。実 Ktor サーバーを通す）。
- **ドメインの純粋関数**（`decide`・`evolve`・`simulateWeek`）、性質、DB・HTTP の細部は、**Kotest** の日本語のテスト名で Given（過去のイベント）/ When（コマンド）/ Then（イベントまたはエラー）で書く。**同じ振る舞いを、Gherkin と Kotest で二重に書かない**。
- **タグ**でトレーサビリティを取る: ストーリーと受入条件の ID（例: `@US2.4 @AC2.4.1`）、層（`@api`・`@ui`）、重要度（`@acceptance-criteria`・`@happy-path`・`@negative`・`@core`）。タグの一覧と意味は、フィーチャーファイルと同じ場所に文書化する。
- **進め方**: 序盤・終盤のアウトサイドインでは、デモ項目をフィーチャーファイルにして入口にする（Undefined → Pending → Failing → Passing の順に回す）。中盤のインサイドアウトでは、シナリオを実装の前に書いて合意し、Bolt の最後に Cucumber で実行して結合を確認する。AI が書いたシナリオも、人が業務の言葉と例の妥当性を検証してから承認する。
- **生きたドキュメント**は、フィーチャーファイルをビルドごとに公開し、CI で自動化する（手作業にしない）。公開の道具（Pickles、Cucumber Reports など）は B1〜B2 で選ぶ。**版は未確認**。
- **配置**（B1 で確定）: フィーチャーファイルを `apps/beer-game-kotlin/features/<機能領域>/` に 1 か所にまとめ、両処理系から参照する案を第一とする。処理系の既定の場所と合わせられるかは未確認。

### 代替案

設計書の案（開発戦略、技術スタックの導入の表）から取る。

- Kotest と Playwright のテスト名だけで受入条件を表す: **ユーザーが 2026-11-14 に却下**した。契約を業務の言葉で読めず、シナリオとコードの照合も働かない。
- すべてを Gherkin にする: イベントの列が冗長になり、プロパティテストなどの網羅が表せない。実装の詳細を業務のシナリオに持ち込むことになるため採らない。

## 影響

### ポジティブ

- 受入条件が、業務の言葉で読める契約であり、同時に実行可能な検証になる。
- シナリオの ID タグから、ストーリーとの対応を自動で抽出できる。
- 生きたドキュメントが、コードと同期して公開される。

### ネガティブ

- 2 つの処理系（Cucumber-JVM、Cucumber-JS）を維持する。フィーチャーファイルを 1 か所から参照できるかは B1 まで未確認。
- ステップ定義と Gherkin の語彙の保守が要る。シナリオを書く手間が B1 を 3 日から 4 日にした。
- JUnit Platform の版（Kotest 6.2.7 が要求する版）との組み合わせは、B1 のビルドで確認するまで未確認。

## コンプライアンス

- **B1**: ウォーキングスケルトンのシナリオ（作成 → 参加 → 割り当て → 開始 → 入力 → 確定 → 状態の表示）が green で、Undefined・Pending のステップがない。タグの一覧と意味が文書化され、依存関係の導入の承認と版の確認の記録がある。2 つの処理系で、フィーチャーファイルを 1 か所から参照できること、日本語 Gherkin を Undefined → Pending → Failing → Passing の順に回せることを確かめる。
- **B2**: Cucumber を CI に組み込み、Undefined・Pending のステップで失敗することを確かめる。ステップ定義も静的解析の対象とする（[ADR-011](./011-strict-static-analysis.md)）。
- **各 Bolt**: 受入条件のシナリオが、実装前に書かれて合意済みで、Bolt の最後に green であること。
- **CI**: `@api` は Gradle のタスク、`@ui` は `npx cucumber-js` を毎回の工程に含める。ストーリー ID の整合の検査をタグから行う。生きたドキュメントの公開は B1〜B2 で CI に入れる。

## 備考

- 著者: claude-code
- 関連 ADR: [ADR-011](./011-strict-static-analysis.md)、[ADR-013](./013-tech-stack-versions.md)、[ADR-001](./001-kotlin-version-of-beer-game2.md)
- 参照: [開発戦略（アウトサイドインの入口を BDD で定義する）](../../development/beer-game-kotlin/development_strategy.md)、[テスト戦略](../../design/beer-game-kotlin/test-strategy.md)、[技術スタック（確認した重要な事項 18・19、新しく導入する依存関係）](../../design/beer-game-kotlin/tech-stack.md)、[リリース計画（B1、B2）](../../development/beer-game-kotlin/release_plan.md)、[BDD 導入ガイド](../../reference/BDD導入ガイド.md)
