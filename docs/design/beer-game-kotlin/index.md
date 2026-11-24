# beer-game-kotlin — 設計

beer-game-kotlin（[beer-game2](../beer-game-ts/index.md) の Kotlin 版）の設計ドキュメントです。機能・API の振る舞い・画面は beer-game2 を引き継ぎ、バックエンドを **Kotlin（Ktor + Arrow + kotlinx.coroutines）、イベントソーシング + CQRS** で再設計します。コーディングは [関数型プログラミングガイド（Kotlin 編）](../../reference/関数型プログラミングガイド_Kotlin編.md) に準拠します。フロントエンドは React/TypeScript を踏襲します。要件と ADR は beer-game2 のものを参照します（本プロジェクトでは新規に作りません）。

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

用語集・イベント一覧・コアのハイライト・サイトシーイング・マップ・ガイドツアーは、コードの注釈（`@Term`・`@EventSpec`・`@CoreConcept`・`@KeyLandmark`・`@GuidedTour`）から生成しています（手で編集しません。再生成は `./gradlew :domain:generateLivingDocs`。方式は [ADR-018](../../adr/beer-game-kotlin/018-living-documentation-annotations.md)、承認済み）。`LivingDocumentationSpec`・`GuidedTourSpec` が、コードとの差と設計書との不一致を検出します。入口は [README](../../../apps/beer-game-kotlin/README.md) の「コードの案内」です。

| ドキュメント | 概要 | 状況 |
| :--- | :--- | :--- |
| [イベント一覧（生成）](./generated/events.md) | 実装済みのドメインイベントの ID・ストリーム・発生条件・ペイロードの項目・購読する投影。設計書の EV 表との不一致は試験が検出する | 生成物 |
| [用語集（生成）](./generated/glossary.md) | 注釈 `@Term` を付けた型の用語・定義・出典（これから書くコードと B5 の概念から） | 生成物 |
| [コアのハイライト（生成）](./generated/core-highlight.md) | 中核（シミュレーション計算と進行）の主要な概念 5 つを、注釈 `@CoreConcept` から動的に選び出した、新しく参加する人の読む入口。中核の区分は設計書が正本で、補完・一般の概念の混入や数の超過（上限 10）は試験が検出する（[ダイナミックキュレーション導入ガイド](../../reference/ダイナミックキュレーション導入ガイド.md)） | 生成物 |
| [サイトシーイング・マップ: アプリケーションアーキテクチャ（生成）](./generated/architecture-sightseeing-map.md) | 核の純粋関数と、外側の薄い副作用の層という構造の見どころ 7 つを、注釈 `@KeyLandmark` から動的に選び出し、順序なしで層ごとに示す。層の間の依存の向きは、ビルドの定義（モジュールの依存）から導く。見どころの数（5〜7 個。上限 10）・層の網羅・場所が崩れたら試験が失敗する | 生成物 |
| [サイトシーイング・マップ: DDD（生成）](./generated/ddd-sightseeing-map.md) | 戦略的設計（ユビキタス言語・中核の識別）と戦術的設計（集約・値オブジェクト・ドメインイベント・ドメインサービス・プロセスマネージャー）の見どころ 7 つを、同じ注釈 `@KeyLandmark` から動的に選び出し、順序なしで示す。数・区分・場所が崩れたら試験が失敗する | 生成物 |
| [ガイドツアー: CQRS（生成）](./generated/cqrs-tour.md) | コマンド側 → イベントと投影 → 問い合わせ側の流れを、注釈 `@GuidedTour` から動的に選び出し、rank の順に 9 ステップで案内する。ツアーの注釈（数・順序・段階・場所）が崩れたら試験が失敗する | 生成物 |
| [ガイドツアー: イベントソーシング（生成）](./generated/event-sourcing-tour.md) | 状態を保存せず、事実（イベント）だけを残して、再生で状態を取り戻す流れを、事実を決める → 事実を残す → 状態を取り戻すの 3 段階・9 ステップで案内する。CQRS のツアーと、decide・イベントストアを共有する（同じ要素が複数のツアーに出る） | 生成物 |
| [ガイドツアー: ウォーキングスケルトン（生成）](./generated/walking-skeleton-tour.md) | 最初の縦の切片（作成 → 参加 → 割り当て → 開始 → 入力 → 確定 → 状態の表示）を、同じ注釈 `@GuidedTour` で 7 ステップに案内する。各操作の API の経路（仕様から）と発行するイベント（`@EventSpec` から）を添える | 生成物 |

## 補足

- 実ドキュメントを追加したら、この一覧を更新します。
- 各文書の「未決事項」に、実装の開始前に決める事項を集めています。
