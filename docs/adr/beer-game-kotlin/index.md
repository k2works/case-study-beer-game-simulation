# beer-game-kotlin — ADR

beer-game-kotlin プロジェクトの ADR ドキュメントです。

## ドキュメント一覧

| ADR | 決定内容 | ステータス |
| :--- | :--- | :--- |
| [ADR-001](./001-kotlin-version-of-beer-game2.md) | beer-game2 を Kotlin 版として作り、要件と ADR を流用する | 承認済み |
| [ADR-002](./002-event-sourcing-and-cqrs.md) | イベントソーシングと CQRS を採用し、2 ストリームで表す | 承認済み |
| [ADR-003](./003-synchronous-projections.md) | 投影を同期で更新し、スナップショットを入れず、出力を要求時に作る | 提案中 |
| [ADR-004](./004-idempotency-after-authorization.md) | 冪等記録の照合を認可の後に置き、成功した応答だけを保存する | 提案中 |
| [ADR-005](./005-optimistic-concurrency-and-advisory-lock.md) | 楽観的並行制御と自動再試行を基本とし、投影の再構築との直列化にだけアドバイザリロックを使う | 提案中 |
| [ADR-006](./006-event-schema-evolution.md) | イベントのスキーマ進化を EventCodec のアップキャストと 2 段階リリースで行う | 提案中 |
| [ADR-007](./007-functional-core-with-arrow.md) | ドメインを Arrow の Either と純粋な decide/evolve で書き、層の依存を Gradle のモジュールで強制する | 提案中 |
| [ADR-008](./008-api-contract-and-error-codes.md) | API の契約を OpenAPI の手書きの仕様で持ち、エラーを problem+json の code で識別する | 提案中 |
| [ADR-009](./009-observer-access-control.md) | 観察者を DB ロールと接続プールで分け、読める表を 3 表に限る | 提案中 |
| [ADR-010](./010-retention-deletion-with-append-only.md) | events を追記専用にし、保持削除を game_roots の連鎖削除 1 回で行う | 提案中 |
| [ADR-011](./011-strict-static-analysis.md) | 静的解析とルール設定を厳格に適用する（detekt を中心に PMD で補完） | 提案中 |
| [ADR-012](./012-gherkin-and-cucumber.md) | 受入条件を日本語 Gherkin と Cucumber で表し、細部は Kotest で書く | 承認済み |
| [ADR-013](./013-tech-stack-versions.md) | 技術スタックの版を、確認済みの値で固定する（JDK 25 LTS、Kotlin 2.4、PostgreSQL 18） | 提案中 |
| [ADR-014](./014-h2-for-local-development.md) | ローカル開発だけ H2（PostgreSQL モード）を使い、PostgreSQL 固有の機能をポートで抽象化する | 提案中 |

## 補足

- 実ドキュメントを追加したら、この一覧を更新します。
- beer-game2 の ADR のうち、引き継ぐもの・変更するもの・置換するものは、[ADR-001](./001-kotlin-version-of-beer-game2.md) の表にあります。要件・ユースケース・ストーリーは beer-game2 のものを参照します。
- 本文のステータスは意思決定の状態です。承認済みは、ユーザーが 2026-11-14 に決めた事項（Kotlin 版の作成、ES+CQRS、Gherkin と Cucumber の導入）で、それ以外は人のレビュー待ちです。
