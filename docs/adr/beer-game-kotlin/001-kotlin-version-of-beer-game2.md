---
type: ADR
title: "ADR-001: beer-game2 を Kotlin 版として作り、要件と ADR を流用する"
description: "beer-game2 の要件・ユースケース・ストーリー・Unit 定義を正本として流用し、Kotlin（Ktor + Arrow）と既存の React で作り直す。beer-game2 の ADR の引き継ぎ表を含む。"
tags: [adr]
status: draft
generated: { by: claude-code/claude-sonnet-5-5, at: 2026-11-14T08:15:50Z }
---

# ADR-001: beer-game2 を Kotlin 版として作り、要件と ADR を流用する

beer-game2 と同じ機能と振る舞いを、Kotlin（Ktor + Arrow）のバックエンドと既存の React のフロントエンドで作り直す（beer-game-kotlin）。要件・ユースケース・ストーリー・Unit 定義は beer-game2 のものを参照して流用し、ADR は本書の引き継ぎ表に従って引き継ぐ・変更する・置き換える。

日付: 2026-11-14

## ステータス

承認済み（2026-11-14、ユーザーの決定）

ユーザーが決めた事項は、Kotlin 版の作成、技術スタック（Ktor + Arrow + 既存 React）、コーディングを関数型プログラミングガイド（Kotlin 編）に準拠させることである。

## コンテキスト

beer-game2 は、要件（BR-01〜BR-17、FR-01〜FR-18、NFR-01〜NFR-12）、ユースケース、ユーザーストーリー、Unit 定義（U1〜U6）、ADR（001〜013）を持つ。バックエンドの技術は TypeScript（Fastify）である。ユーザーは、同じ学習の価値を、Kotlin の関数型設計とイベントソーシングで、変更を楽に安全にできる形で提供することを求めた（[リリース計画](../../development/beer-game-kotlin/release_plan.md) の Intent）。

この選択で、次の問題が生じる。

- 要件を作り直すと、beer-game2 との二重管理になり、機能の差が生まれる。
- beer-game2 の ADR の一部は、バックエンドの言語と永続化の方式（ES + CQRS）に依存しており、そのままでは当てはまらない。どれが有効かを明示しないと、二つの系列の ADR が混在する（beer-game2 の [ADR-002](../beer-game2/002-adopt-v1-adrs.md) と同じ問題）。

## 決定

- **機能と振る舞いは、beer-game2 を正本として引き継ぐ。** 要件・ユースケース・ストーリー・Unit 定義は新しく作らず、`docs/requirements/beer-game2/` を参照する。範囲は beer-game2 と同じ（Unit U1〜U6、Release 0.1 / 0.2 / 1.0）。
- **技術スタックは、バックエンドを Kotlin（Ktor + Arrow + kotlinx.coroutines）、フロントエンドを既存の React / TypeScript とする。** 言語をまたぐ型の共有はせず、API の契約は `contracts/openapi.yaml` の手書きを正本にする（[技術スタック](../../design/beer-game-kotlin/tech-stack.md) の選定の方針）。版は [ADR-013](./013-tech-stack-versions.md) で定める。
- **コーディングは、関数型プログラミングガイド（Kotlin 編）に準拠する。** アーキテクチャは [ADR-002](./002-event-sourcing-and-cqrs.md)（ES + CQRS）、中核の構造は [ADR-007](./007-functional-core-with-arrow.md) による。
- **beer-game2 の ADR は、次の表のとおり扱う。** beer-game2 の ADR のファイルは履歴として変更しない。

### beer-game2 の ADR の引き継ぎ表

各行は、beer-game2 の ADR の本文と、Kotlin 版の設計書の「beer-game2 からの変更」の表で確認した。

| beer-game2 の ADR | Kotlin 版での扱い | 内容 | Kotlin 版の ADR・設計書 |
| :--- | :--- | :--- | :--- |
| [001](../beer-game2/001-rebuild-as-beer-game2.md) 作り直し | **引き継ぐ**（本書で Kotlin 版へ） | beer-game2 の要件を正本にして作り直す方針を、Kotlin 版でも取る | 本書 |
| [002](../beer-game2/002-adopt-v1-adrs.md) v1 の ADR の引き継ぎ | **参照のみ** | v1 から v2 への引き継ぎの記録であり、本書がその Kotlin 版にあたる | 本書 |
| [003](../beer-game2/003-ports-and-adapters-with-lint.md) ポートとアダプター + lint | **変更** | 層の依存の向きは守る。守り方を、ESLint でなく **Gradle のモジュール境界**に、ポートとアダプターを**関数型コア（関数の束）**に変える | [ADR-007](./007-functional-core-with-arrow.md)、[ADR-011](./011-strict-static-analysis.md)。[バックエンド](../../design/beer-game-kotlin/architecture-backend.md) BD1・BD2 |
| [004](../beer-game2/004-separate-game-and-session-aggregates.md) Game と Session の分離 | **引き継ぐ** | 準備と進行を別の集約にし、開始だけを同時に扱う。ES では **2 ストリーム**（`game`・`session`）で表す | [ADR-002](./002-event-sourcing-and-cqrs.md)。[ドメインモデル](../../design/beer-game-kotlin/domain-model.md) D1・D3 |
| [005](../beer-game2/005-role-results-and-sql-read-models.md) 役割別の行と SQL の読み取りモデル | **引き継ぐ**（意図を保ち、投影として実現） | 役割別の週結果を行として持ち、SQL で返す。`WeekCommitted` が正本で、`week_role_results` は**投影**になる | [ADR-003](./003-synchronous-projections.md)。[データモデル](../../design/beer-game-kotlin/data-model.md) |
| [006](../beer-game2/006-sse-version-only.md) SSE は版の通知だけ | **引き継ぐ**（一部変更） | 版の通知だけで再生しない方針は同じ。`game` と `session` の**ストリーム別の版**を通知する | [ADR-002](./002-event-sourcing-and-cqrs.md)。[バックエンド](../../design/beer-game-kotlin/architecture-backend.md) の通知 |
| [007](../beer-game2/007-cascade-deletion-without-queues.md) カスケード削除 | **置き換える** | 1 回の削除で漏れなく消す意図は保つ。`games` が投影になるため、根を `game_roots` に独立させ、追記専用の `events` との両立を決める | [ADR-010](./010-retention-deletion-with-append-only.md) |
| [008](../beer-game2/008-auto-commit-and-event-audit.md) 自動確定と監査 | **変更** | 同じトランザクションで確定する判断は同じ。「最後の保存と同じ追記」で `decide` が複数のイベントを返す形にし、監査は `events` が兼ねる | [ADR-002](./002-event-sourcing-and-cqrs.md)。[ドメインモデル](../../design/beer-game-kotlin/domain-model.md) D6 |
| [009](../beer-game2/009-credential-key-versions.md) 資格の鍵の版 | **引き継ぐ** | 有効期限・失効・複数の鍵の版は同じ。資格のダイジェストと表示名は**イベントに入れず周辺ストア**に置く | [ADR-002](./002-event-sourcing-and-cqrs.md)。[ドメインモデル](../../design/beer-game-kotlin/domain-model.md) D7 |
| [010](../beer-game2/010-url-router-and-features.md) URL ルーターと機能単位 | **引き継ぐ** | フロントエンドは beer-game2 を踏襲する。エラーの表示の辞書の鍵が変わる | [ADR-008](./008-api-contract-and-error-codes.md)。[フロントエンド](../../design/beer-game-kotlin/architecture-frontend.md) |
| [011](../beer-game2/011-cloudfront-domain-tls-headers.md) CloudFront、独自ドメイン、TLS、ヘッダー | **引き継ぐ** | 配信の構成は同じ。JVM のコンテナ（Temurin の JRE 25）に合わせる | [インフラ](../../design/beer-game-kotlin/architecture-infrastructure.md) |
| [012](../beer-game2/012-delivery-pipeline-and-terraform.md) ECR、OIDC、ステージング自動・本番承認、Terraform | **引き継ぐ** | パイプラインの構成は同じ。Gradle の検証、契約テスト、N-1 互換のジョブを加える。AWS への適用は別ゲート | [インフラ](../../design/beer-game-kotlin/architecture-infrastructure.md)、[テスト戦略](../../design/beer-game-kotlin/test-strategy.md) |
| [013](../beer-game2/013-tech-stack-versions.md) 技術スタックの版（Node 26、TypeScript 6.0 ほか） | **置き換える** | バックエンドの版が Kotlin / JDK / Gradle などに変わる。PostgreSQL 18 とフロントエンドは引き継ぐ | [ADR-013](./013-tech-stack-versions.md) |

### 代替案

- beer-game2 の TypeScript を維持し、ES + CQRS のみを導入する: 言語を変えずに済むが、ユーザーが Kotlin と関数型の設計を求めている。
- beer-game2 の要件・ストーリーを Kotlin 版にコピーして改訂する: 機能の正本が 2 つになり、差が生まれる。
- beer-game2 の ADR をすべて有効とする: ポートとアダプターの守り方、削除の方式、技術スタックの版が、Kotlin 版と矛盾する。

## 影響

### ポジティブ

- 機能の正本が 1 つ（beer-game2）で、Kotlin 版は設計と実装の差に集中できる。
- どの判断が引き継がれ、どれが変わったかが、本書の 1 か所で分かる。

### ネガティブ

- 二つの系列（beer-game2 と Kotlin 版）の ADR を、読み手が参照する必要がある。
- beer-game2 の要件が変わると、Kotlin 版にも影響する。要件の変更は、beer-game2 側で行い、Kotlin 版へ追従する。

## コンプライアンス

- **契約の流用**: ストーリーの受入条件を、日本語 Gherkin のシナリオにタグ（例: `@US2.4 @AC2.4.1`）で対応付ける。CI でタグから対応表を生成し、整合を検査する。B1 から継続（[テスト戦略](../../design/beer-game-kotlin/test-strategy.md) のトレーサビリティ、[リリース計画](../../development/beer-game-kotlin/release_plan.md) の測定基準）。
- **API の契約が変わらないこと**: beer-game2 の E2E のシナリオが、Kotlin 版でそのまま使えるかを、B4 までに確かめる。変わる場合は設計の矛盾として扱う（テスト戦略の E2E の節）。
- **引き継ぎ表の整合**: 本書の表の各行が参照する Kotlin 版の ADR（002〜013）が存在し、置き換えた beer-game2 の ADR を備考で参照していること。レビューで確認する。
- **beer-game2 の ADR を変更しないこと**（履歴）。

## 備考

- 著者: claude-code
- 未確認: 引き継ぎ表の 011・012 は、設計書の「beer-game2 からの変更」の表と ADR の見出しで確認した。AWS 環境への適用は B3・B14 で定義するだけで、実際の適用結果は未確認。
- 関連 ADR: [ADR-002](./002-event-sourcing-and-cqrs.md)、[ADR-007](./007-functional-core-with-arrow.md)、[ADR-013](./013-tech-stack-versions.md)。beer-game2 の [ADR-001](../beer-game2/001-rebuild-as-beer-game2.md)、[ADR-002](../beer-game2/002-adopt-v1-adrs.md)
- 参照: [設計書の入口](../../design/beer-game-kotlin/index.md)、[技術スタック](../../design/beer-game-kotlin/tech-stack.md)、[リリース計画](../../development/beer-game-kotlin/release_plan.md)、[ユーザーストーリー](../../requirements/beer-game2/user_story.md)、[Unit 定義](../../requirements/beer-game2/unit_definition.md)
