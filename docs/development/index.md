# 開発

開発フェーズのドキュメントです。リリース計画、イテレーション計画、ふりかえり、完了報告書を管理します。

## プロジェクト一覧

| プロジェクト | 概要 | 状況 |
| :--- | :--- | :--- |
| [beer-game](./beer-game/index.md) | 改訂版ビールゲームを再現し、サプライチェーンの動的挙動を学習するシミュレーション | 未着手 |
| [beer-game-ts](./beer-game-ts/index.md) | beer-game の知見をもとに、要件と設計を改訂して作り直す v2。共同担当、カスタム条件、観察者、自動確定を含む | 進行中（Release 0.2 の範囲の機能が完了。ステージングは未達。[リリース完了報告書 0.2](./beer-game-ts/release_report-0_2_0.md)） |
| [beer-game-kotlin](./beer-game-kotlin/index.md) | beer-game2 の Kotlin 版の開発計画（リリース計画・Bolt 計画） | 未着手 |
| [beer-game-rust](./beer-game-rust/index.md) | beer-game-kotlin の Rust 版。axum + sqlx、ES + CQRS | B1〜B16 完了（Release 1.0 の完了承認済み。AWS には未適用） |
| [beer-game-scala](./beer-game-scala/index.md) | beer-game-kotlin の Scala 版。Scala 3 + Cats Effect + http4s + doobie。U1〜U3 を約束 | 計画の草案（リリース計画・開発戦略。人の承認待ち） |

## 補足

- プロジェクトの追加は `apply-docs-structure` スキル（add-project）で行い、この一覧と `docs/index.md` を更新します。
- 実ドキュメントは `development/<project>/` に置き、プロジェクトの `index.md` で一覧と進捗を管理します。
- テンプレートは次を利用できます。
  - [template/リリース計画.md](../template/リリース計画.md)
  - [template/イテレーション計画.md](../template/イテレーション計画.md)
  - [template/イテレーション完了報告書.md](../template/イテレーション完了報告書.md)
  - [template/リリース完了報告書.md](../template/リリース完了報告書.md)
