# beer-game-kotlin

ビールゲームシミュレーションの Kotlin 版です（Ktor + Arrow。画面は Rust 版・TS 版と共有の [`apps/beer-game-web`](../beer-game-web)）。

- 設計: [設計ドキュメント](../../docs/design/beer-game-kotlin/index.md)、[ADR](../../docs/adr/beer-game-kotlin/index.md)
- 計画: [Bolt 計画](../../docs/development/beer-game-kotlin/)
- 運用: [運用手順書](../../docs/operation/beer-game-kotlin/)
- タスク: `just`（一覧。[`justfile`](./justfile)）

## コードの案内

初めて読むときは、次の順に。どれもコードの注釈から生成した文書で、コードを変えると追従します（手で編集しません）。

1. [コアのハイライト](../../docs/design/beer-game-kotlin/generated/core-highlight.md) — ここが核心。まず読む 5 つ
2. ガイドツアー — [ウォーキングスケルトン](../../docs/design/beer-game-kotlin/generated/walking-skeleton-tour.md)（作成から週の確定・状態の表示まで）、[CQRS](../../docs/design/beer-game-kotlin/generated/cqrs-tour.md)、[イベントソーシング](../../docs/design/beer-game-kotlin/generated/event-sourcing-tour.md)
3. サイトシーイング・マップ — [アーキテクチャ](../../docs/design/beer-game-kotlin/generated/architecture-sightseeing-map.md)、[DDD](../../docs/design/beer-game-kotlin/generated/ddd-sightseeing-map.md)
4. [イベント一覧](../../docs/design/beer-game-kotlin/generated/events.md)、[用語集](../../docs/design/beer-game-kotlin/generated/glossary.md)

注釈（`@Term`・`@EventSpec`・`@CoreConcept`・`@KeyLandmark`・`@GuidedTour`）の方式は [ADR-018](../../docs/adr/beer-game-kotlin/018-living-documentation-annotations.md)。注釈を足す・変えたら `./gradlew :domain:generateLivingDocs` で再生成します（`LivingDocumentationSpec`・`GuidedTourSpec` が、コードとの差・設計書との不一致を失敗にします）。

## 構成

```text
domain/               純粋な関数と型（decide / evolve、simulateWeek、値オブジェクト、注釈）。Arrow だけに依存する
application/         コマンドの実行手順、ポート。業務の規則は持たない
adapter-persistence/  JDBC のイベントストア、投影、マイグレーション
adapter-http/         Ktor のルーティング（共有の契約 /api/v1）
app/                  起動、設定、組み立て
config/               静的解析（detekt・PMD）の設定
infra/                Terraform
```

層の依存の向きは Gradle のモジュールの依存と静的解析で強制します（[アーキテクチャのマップ](../../docs/design/beer-game-kotlin/generated/architecture-sightseeing-map.md)に、ビルド定義から導いた向きがあります）。

## 開発

```sh
just backend        # API サーバー
just backend-check  # CI と同じ品質チェック
just dev            # バックエンドと画面
```

API の契約は [`apps/beer-game-contracts/openapi.yaml`](../beer-game-contracts/openapi.yaml)、受け入れ条件は [`apps/beer-game-features`](../beer-game-features) を、Rust 版・TS 版と共有します。
