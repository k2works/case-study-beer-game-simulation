# beer-game-rust

ビールゲームシミュレーションの Rust 版です（axum + sqlx + tokio。画面は Kotlin 版・TS 版と共有の [`apps/beer-game-web`](../beer-game-web)）。

- 設計: [設計ドキュメント](../../docs/design/beer-game-rust/index.md)、[ADR](../../docs/adr/beer-game-rust/index.md)
- 計画: [Bolt 計画](../../docs/development/beer-game-rust/)
- 運用: [運用手順書](../../docs/operation/beer-game-rust/)
- タスク: `just`（一覧。[`justfile`](./justfile)）

## コードの案内

初めて読むときは、次の順に。どれもコードの注釈（`/// @…`）から生成した文書で、コードを変えると追従します（手で編集しません）。

1. [コアのハイライト](../../docs/design/beer-game-rust/generated/core-highlight.md) — ここが核心。まず読む 5 つ
2. [ガイドツアー: ウォーキングスケルトン](../../docs/design/beer-game-rust/generated/walking-skeleton-tour.md) — 作成から週の確定・状態の表示までを 7 ステップで
3. [サイトシーイング・マップ: アーキテクチャ](../../docs/design/beer-game-rust/generated/architecture-sightseeing-map.md)、[DDD](../../docs/design/beer-game-rust/generated/ddd-sightseeing-map.md) — 見どころを順序なしで
4. [イベント一覧](../../docs/design/beer-game-rust/generated/events.md)、[用語集](../../docs/design/beer-game-rust/generated/glossary.md)

注釈の書き方、生成と検査の仕組みは [ADR-002](../../docs/adr/beer-game-rust/002-living-documentation-doc-comments.md)。注釈を足す・変えたら、`just livingdoc` で再生成します（`cargo test` が、コードとの差・設計書との不一致を失敗にします）。

## 構成

```text
crates/
  domain/               純粋な関数と型（decide / evolve、simulate_week、値オブジェクト）。I/O に依存しない
  application/          コマンドの実行手順（execute）、ポート（トレイト）。業務の規則は持たない
  adapter-persistence/  PostgreSQL のイベントストア、投影、マイグレーション
  adapter-http/         axum のルーター（共有の契約 /api/v1）
  app/                  起動、設定、組み立て
  guards/               守りの検査（依存の向き、lint の fixture）
  acceptance/           共有の受け入れ条件（apps/beer-game-features）の実行
  livingdoc/            Living Documentation の生成（標準ライブラリだけ）
infra/                  Terraform（staging・production）
```

層の依存の向きは [`guards`](./crates/guards) が検査します。

## 開発

```sh
just db-up        # PostgreSQL 18（Docker）
just dev          # バックエンド（3000）と画面（5173）
just backend-check  # CI と同じ品質チェック
```

API の契約は [`apps/beer-game-contracts/openapi.yaml`](../beer-game-contracts/openapi.yaml)、受け入れ条件は [`apps/beer-game-features`](../beer-game-features) を、Kotlin 版・TS 版と共有します。
