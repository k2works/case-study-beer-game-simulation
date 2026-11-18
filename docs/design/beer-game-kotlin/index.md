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

用語集とイベント一覧は、B5 Step 8.4 から、コードの注釈（`@Term`・`@EventSpec`）から生成しています（手で編集しません。再生成は `./gradlew :domain:generateLivingDocs`。方式は [ADR-018](../../adr/beer-game-kotlin/018-living-documentation-annotations.md)、提案）。

| ドキュメント | 概要 | 状況 |
| :--- | :--- | :--- |
| [イベント一覧（生成）](./generated/events.md) | 実装済みのドメインイベントの ID・ストリーム・発生条件・ペイロードの項目・購読する投影。設計書の EV 表との不一致は試験が検出する | 生成物 |
| [用語集（生成）](./generated/glossary.md) | 注釈 `@Term` を付けた型の用語・定義・出典（これから書くコードと B5 の概念から） | 生成物 |
| [コアのハイライト（生成）](./generated/core-highlight.md) | 中核（シミュレーション計算と進行）の主要な概念 5 つを、注釈 `@CoreConcept` から動的に選び出した、新しく参加する人の読む入口。中核の区分は設計書が正本で、補完・一般の概念の混入や数の超過（上限 10）は試験が検出する（[ダイナミックキュレーション導入ガイド](../../reference/ダイナミックキュレーション導入ガイド.md)） | 生成物 |
| [ウォーキングスケルトンのガイドツアー（生成）](./generated/walking-skeleton-tour.md) | 最初の縦の切片（作成 → 参加 → 割り当て → 開始 → 入力 → 確定 → 状態の表示）を、画面・API・アプリケーション・ドメイン・イベント・投影・受入の層ごとにたどる案内。場所はコードの走査から導き、見つからなければ試験が失敗する | 生成物 |

## 補足

- 実ドキュメントを追加したら、この一覧を更新します。
- 各文書の「未決事項」に、実装の開始前に決める事項を集めています。
