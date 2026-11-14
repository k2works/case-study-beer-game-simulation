# beer-game-kotlin — 設計

beer-game-kotlin（[beer-game2](../beer-game2/index.md) の Kotlin 版）の設計ドキュメントです。機能・API の振る舞い・画面は beer-game2 を引き継ぎ、バックエンドを **Kotlin（Ktor + Arrow + kotlinx.coroutines）、イベントソーシング + CQRS** で再設計します。コーディングは [関数型プログラミングガイド（Kotlin 編）](../../reference/関数型プログラミングガイド_Kotlin編.md) に準拠します。フロントエンドは React/TypeScript を踏襲します。要件と ADR は beer-game2 のものを参照します（本プロジェクトでは新規に作りません）。

## ドキュメント一覧

### アーキテクチャ

| ドキュメント | 概要 | 状況 |
| :--- | :--- | :--- |
| [バックエンドアーキテクチャ](./architecture-backend.md) | Ktor + Arrow、ES+CQRS のコマンド側・問い合わせ側、冪等性、競合の再試行、自動確定、SSE、API、観測性、セキュリティ | Draft |
| [フロントエンドアーキテクチャ](./architecture-frontend.md) | React/TypeScript の踏襲、OpenAPI からの型生成、リアルタイム更新、beer-game2 からの変更 | Draft |
| [インフラストラクチャ](./architecture-infrastructure.md) | JVM のコンテナと起動モード、実行基盤、CI/CD、ビルド | Draft |

### モデル設計

| ドキュメント | 概要 | 状況 |
| :--- | :--- | :--- |
| [データモデル設計](./data-model.md) | イベントストア、冪等記録、投影テーブル、保持削除、マイグレーション、ER 図 | Draft |
| [ドメインモデル設計](./domain-model.md) | Game・Session の 2 ストリーム、decide / evolve、`DomainError`、simulateWeek、全イベント一覧、投影 | Draft |

### UI/UX設計

| ドキュメント | 概要 | 状況 |
| :--- | :--- | :--- |
| [UI 設計](./ui-design.md) | 画面は beer-game2 を踏襲。保存直後の表示、競合の 4 種類の文言、通信断の再送を見直し | Draft |

### 品質・運用

| ドキュメント | 概要 | 状況 |
| :--- | :--- | :--- |
| [テスト戦略](./test-strategy.md) | decide / evolve の純粋関数テスト、プロパティベース、イベントストアの統合テスト、カバレッジ、CI | Draft |
| [非機能要件](./non-functional.md) | beer-game2 の 69 件を引き継ぎ、ES+CQRS と JVM で 15 件を追加した 84 件 | Draft |
| [運用要件](./operation.md) | 監視（投影の遅れ、追記競合率、JVM）、投影の再構築、イベントスキーマの進化、障害対応 | Draft |

### その他

| ドキュメント | 概要 | 状況 |
| :--- | :--- | :--- |
| [技術スタック選定](./tech-stack.md) | JDK 25、Kotlin、Gradle、Ktor、Arrow ほか。2026-11-14 に確認した版と出典 | Draft |

### コードの案内（Living Documentation）

サイトシーイング・マップとガイドツアーは、コードの注釈から自動生成する成果物です。**実装後に生成します**（現時点では作りません）。

## 補足

- 実ドキュメントを追加したら、この一覧を更新します。
- 各文書の「未決事項」に、実装の開始前に決める事項を集めています。
