---
type: ADR
title: "ADR-014: ローカル開発だけ H2（PostgreSQL モード）を使い、PostgreSQL 固有の機能をポートで抽象化する"
description: "H2 の PostgreSQL モードはローカル開発の起動・動作確認にだけ使い、テスト・CI・ステージング・本番は PostgreSQL 18 のままとする。アドバイザリロックと通知はポートの裏で両対応にする。"
tags: [adr]
status: draft
generated: { by: claude-code/claude-sonnet-5-5, at: 2026-11-14T08:30:39Z }
---

# ADR-014: ローカル開発だけ H2（PostgreSQL モード）を使い、PostgreSQL 固有の機能をポートで抽象化する

Kotlin 版は、開発機での起動と動作確認に限り、H2 の PostgreSQL モードを使えるようにする。統合テスト、CI、ステージング、本番は PostgreSQL 18 のままとする。PostgreSQL 固有の機能（アドバイザリロック、LISTEN/NOTIFY）は、ポートの裏に抽象化し、PostgreSQL 版と H2 版の両方の実装を持つ。

日付: 2026-11-14

## ステータス

提案中（レビュー待ち）。ただし、H2 を使う範囲（ローカル開発のみ）と、PostgreSQL 固有機能の抽象化（両対応）は**ユーザーの決定（2026-11-14）**であり、変更しない。H2 の版、H2 の PostgreSQL モードで動く範囲、マイグレーションの配置の詳細は、B1 の最初に実測して確定する（未確認）。

## コンテキスト

設計は PostgreSQL 18 を前提にしている。ES + CQRS の書き込みは `events` の一意制約とアドバイザリロック（[ADR-005](./005-optimistic-concurrency-and-advisory-lock.md)）に、SSE の通知は `pg_notify` に、権限の分離は DB ロールと GRANT（[ADR-009](./009-observer-access-control.md)、[ADR-010](./010-retention-deletion-with-append-only.md)）に依存する。ローカルで動かすには、PostgreSQL（Docker など）が要る。

ユーザーは、開発機での起動・動作確認を軽くするため、ローカル開発だけ H2 の PostgreSQL モードを使うことを決めた。一方で、H2 でしか通らない記述が増えると、CI（PostgreSQL）で落ちる乖離が起きうる。2026-11-14 に H2 の公式ドキュメント（features の PostgreSQL 互換モード）を確認した範囲では、アドバイザリロック、LISTEN/NOTIFY、部分インデックス、ロール/GRANT、JSONB、SQLSTATE、分離レベルの差異は、ドキュメントで確認できなかった（非対応とは断定しない）。実際の動作は実測するまで分からない。

## 決定

- **H2 の PostgreSQL モードは、ローカル開発（開発機での起動・動作確認）だけに使う。** 統合テスト、CI、ステージング、本番は PostgreSQL 18（Testcontainers、RDS）のままとする。H2 を、設計の検証（並行性・権限・部分一意索引・連鎖削除）や性能の計測には使わない。
- **PostgreSQL 固有の機能は、ポートの裏に抽象化し、PostgreSQL 版と H2 版の両方の実装を持つ。**

  | 機能 | ポート | PostgreSQL 版 | H2 版 |
  | :--- | :--- | :--- | :--- |
  | 投影の再構築との直列化 | `ProjectionLock` | `pg_advisory_xact_lock(_shared)` | プロセス内の読み書きロック（単一プロセスでのみ有効。複数プロセスでは保証しない） |
  | SSE の版の通知 | `ChangeNotifier` | `pg_notify` と専用の LISTEN 接続 | プロセス内のイベント（単一プロセスでのみ有効） |

- **部分一意索引（`uq_idempotency_create`）、DB ロールと GRANT（追記専用、`TRUNCATE` の拒否を含む）、接続プールの分離、`jsonb` などの PostgreSQL 固有の型は、PostgreSQL の統合テストでだけ検証する。** H2 版では、同等の制約を、H2 で表せる形（通常の一意制約、アプリケーション側の検査）に置き換えるか、省略する。**省略した制約は、ローカルでは守られない。**
- H2 版のマイグレーションは、Flyway のベンダー別の場所（PostgreSQL 用と H2 用）で、共通の部分を最大化し、差分だけを分ける（配置の詳細は B1 で確定）。
- 実行の選択は、設定（プロファイル。例: `DB_KIND=postgres|h2`）で行う。**本番・ステージングで H2 が選ばれないよう、起動時の検査で、本番の環境では H2 を拒否して起動に失敗する。**
- 乖離への対策: (a) H2 でしか通らない記述を禁止する（PostgreSQL の統合テストが正）、(b) ポートの契約テストを両実装で実行する（PostgreSQL 版は統合テスト、H2 版はユニット）、(c) 受け入れ（Cucumber の `@api`）は PostgreSQL で実行する。
- 新しい依存として H2（`com.h2database:h2`、開発用）を追加する。導入は承認待ち。

### 代替案

いずれも、ユーザーが選ばなかった案である。設計書に、技術的な根拠を示す記述がないものは、理由を創作せず、決定事項から言える範囲だけを書く。

- **(a) 全環境で PostgreSQL（Docker、Testcontainers）のままにする（選ばれなかった）**: 検証と本番が同じ DB になり、乖離は起きない。ユーザーは、ローカル開発だけ H2 を使うことを選んだ。
- **(b) 開発とテスト（CI を含む）も H2 にする（選ばれなかった）**: ユーザーの決定は、H2 の範囲をローカル開発に限る。テスト・CI にまで広げると、並行性・権限・部分一意索引・連鎖削除という、PostgreSQL 固有の機能に依存する設計を、検証できなくなる。
- **(c) 全環境を H2 にする（選ばれなかった）**: 本番の設計（RDS、DB ロール、アドバイザリロック、`pg_notify`）が成り立たなくなり、ユーザーの決定の範囲を超える。複数プロセスでの並行制御も保証できない。
- **(d) PostgreSQL 固有の機能に依存しない設計に変える（選ばれなかった）**: アドバイザリロックや LISTEN/NOTIFY をやめれば H2 との差は減るが、ユーザーの決定は、設計を変えず、ポートの裏で両対応にすることである。再設計は、検証済みの設計判断（ADR-005、ADR-009、ADR-010）を作り直すことになる。

## 影響

### ポジティブ

- 開発機で、Docker なしでも起動と動作確認ができる（実測で確認する）。
- PostgreSQL 固有の機能がポートの裏にあるため、ドメインとアプリケーションは DB の種類を知らない。

### ネガティブ

- **ローカル（H2）で通っても、CI（PostgreSQL）で落ちる乖離が起きうる。** 対策は上の決定のとおり。
- H2 版では、省略した制約（部分一意索引、DB ロール、追記専用、接続プールの分離）が、ローカルでは守られない。
- H2 版の `ProjectionLock` と `ChangeNotifier` は、単一プロセスでだけ有効である。複数プロセスの競合は、ローカルでは再現しない。
- ポートの実装とマイグレーションが 2 系統になり、保守の対象が増える。

## コンプライアンス

- **ポートの契約テスト**: `ProjectionLock` と `ChangeNotifier` の契約テストを、両実装で実行する（PostgreSQL 版は統合テスト、H2 版はユニット）。
- **本番で H2 を拒否する起動の検査**: 本番・ステージングの環境で `DB_KIND=h2` を指定すると、起動に失敗することを、テストで検証する。
- **PostgreSQL での統合テスト・受け入れ**: 並行性、権限、部分一意索引、連鎖削除、`jsonb` は、PostgreSQL 18（Testcontainers）の統合テストでだけ検証する。受け入れ（Cucumber の `@api`）は PostgreSQL で実行する。CI で H2 を使わないことを確認する。
- **B1 の最初の実測**: H2 の PostgreSQL モードで動く範囲（アドバイザリロック、LISTEN/NOTIFY、部分インデックス、ロール/GRANT、JSONB、SQLSTATE、分離レベル）を実測して確定し、H2 の版と、マイグレーションの配置を決める。実測で動かない機能は、H2 版で置き換えるか省略するかを、省略した制約の一覧に記録する。

## 備考

- 著者: claude-code
- H2 の版、H2 の PostgreSQL モードで動く範囲、マイグレーションの配置は未確認（B1 の最初に実測して確定する）。
- 関連 ADR: [ADR-005](./005-optimistic-concurrency-and-advisory-lock.md)、[ADR-009](./009-observer-access-control.md)、[ADR-010](./010-retention-deletion-with-append-only.md)、[ADR-013](./013-tech-stack-versions.md)
- 参照: [データモデル](../../design/beer-game-kotlin/data-model.md)、[バックエンドアーキテクチャ](../../design/beer-game-kotlin/architecture-backend.md)、[技術スタック](../../design/beer-game-kotlin/tech-stack.md)、[テスト戦略](../../design/beer-game-kotlin/test-strategy.md)、[リリース計画](../../development/beer-game-kotlin/release_plan.md)
