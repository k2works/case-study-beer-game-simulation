# beer-game-scala — 設計

beer-game-scala プロジェクトの設計ドキュメントです。beer-game-kotlin の設計を正本とし、実装規約は [関数型プログラミングガイド（Scala 編）](../../reference/関数型プログラミングガイド_Scala編.md) に準拠します。要件・ストーリー・Unit は beer-game-ts（旧 beer-game2）を正本とします。派生の経緯と引き継ぎ表は [ADR-001](../../adr/beer-game-scala/001-scala-version-of-beer-game-kotlin.md) にあります。

## ドキュメント一覧

### アーキテクチャ

| ドキュメント | 概要 | 状況 |
| :--- | :--- | :--- |
| [バックエンドアーキテクチャ](./architecture-backend.md) | sbt のモジュール分割、`IO` と `ConnectionIO` の境界、`handle` / `apply`、`Kleisli` による文脈 | Draft |
| [フロントエンドアーキテクチャ](./architecture-frontend.md) | React 画面の共有と、Scala 版バックエンドとの接点の差分 | Draft |
| [インフラストラクチャ](./architecture-infrastructure.md) | 実行環境、sbt によるビルド、コンテナ、デプロイ構成 | Draft |

### モデル設計

| ドキュメント | 概要 | 状況 |
| :--- | :--- | :--- |
| [データモデル設計](./data-model.md) | 論理データモデル、テーブル定義、doobie との対応 | Draft |
| [ドメインモデル設計](./domain-model.md) | 集約、`enum` による状態・コマンド・イベント・誤り、`Evolution` | Draft |

### UI/UX設計

| ドキュメント | 概要 | 状況 |
| :--- | :--- | :--- |
| [UI 設計](./ui-design.md) | 画面設計は Kotlin 版を継承し、差分だけを整理 | Draft |

### 品質・運用

| ドキュメント | 概要 | 状況 |
| :--- | :--- | :--- |
| [テスト戦略](./test-strategy.md) | munit、代数法則のテスト、Testcontainers、受け入れテスト、静的解析 | Draft |
| [非機能要件](./non-functional.md) | 性能、可用性、セキュリティ、保守性、拡張性（NF-SC の追加を含む） | Draft |
| [運用要件](./operation.md) | `LogRecord` による監視、バックアップ、デプロイ、障害対応 | Draft |

### その他

| ドキュメント | 概要 | 状況 |
| :--- | :--- | :--- |
| [技術スタック選定](./tech-stack.md) | Scala 3、Cats Effect、http4s、doobie など。版は Maven Central で確認した値 | Draft |

## 設計判断（すべて未承認）

次の判断はすべて**提案**で、ユーザーの承認を得ていません。承認の記録は、ユーザーが指示した範囲だけを追記します。

| 判断 | 内容 | 文書 |
| :--- | :--- | :--- |
| ADR-001 | beer-game-kotlin を Scala 版として作り、設計と ADR を流用する | [ADR-001](../../adr/beer-game-scala/001-scala-version-of-beer-game-kotlin.md) |
| ST1〜ST9 | 技術スタックの判断（ローカル DB を PostgreSQL のみにする案 ST9、JSON は circe、接続プールは HikariCP など） | [技術スタック](./tech-stack.md) |
| SD1〜SD7 | ドメインの判断（`enum` による状態、`Evolution`、`ValidatedNec` による検証など） | [ドメインモデル](./domain-model.md) |
| SBD1〜SBD11 | バックエンドの判断（`Left` での明示 ROLLBACK、`Supervisor`、`Kleisli` による文脈など） | [バックエンドアーキテクチャ](./architecture-backend.md) |
| SI1〜SI5 | インフラの判断（配布物の作り方は 3 案で未決、タスクサイズの初期案、SIGTERM の終了コードは未確認、Terraform と CI の Scala 版専用化） | [インフラストラクチャ](./architecture-infrastructure.md) |
| SF1〜SF3 | フロントの判断（共有 web の再利用、起動案内の差し替え、`@ui` による同等性の確認） | [フロントエンドアーキテクチャ](./architecture-frontend.md) |
| SU1〜SU2 | UI 設計は複製しない、契約の逸脱はバックエンドで直す | [UI 設計](./ui-design.md) |
| STT1〜STT4 | テスト戦略の判断（カバレッジは文 85%・分岐 75% を暫定とし、scoverage に行の指標がないため行 80% の基準を文の率で代替してよいかは人の判断待ち） | [テスト戦略](./test-strategy.md) |
| SN1〜SN3 | 非機能要件の判断。NF-P2 は Rust 版に倣い p95 4 秒へ再定義するか、SSE で 2 秒を保つかが未決 | [非機能要件](./non-functional.md) |
| NF-SC1〜 | Scala 固有の非機能要件の追加（`NF-C` は容量用で使用済みのため、この接頭辞にした） | [非機能要件](./non-functional.md) |

## 未確認の前提

- 設計時の検証は、一時プロジェクトでのドメイン断片のコンパイルと munit 2 件までです。実 DB での ROLLBACK、キャンセル、http4s の SSE は**未確認**で、各文書に明記しています。
- ガイドが書く doobie 1.0.0-RC13 は Maven Central の一覧になく、RC12 を設計時の版にしました。
- ローカル開発の DB、scoverage のしきい値（暫定値）、Scala の版（3.7 系に据え置き）は、人の承認待ちです。
- 実装（`apps/beer-game-scala/`）はまだありません。生成物（`generated/`）は、コード着手後に方式を決めます。

## 補足

- 実ドキュメントを追加したら、この一覧を更新します。
