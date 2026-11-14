# ADR (Architecture Decision Records)

技術的意思決定を記録した ADR です。

## プロジェクト一覧

| プロジェクト | 概要 | 状況 |
| :--- | :--- | :--- |
| [beer-game](./beer-game/index.md) | 改訂版ビールゲームを再現し、サプライチェーンの動的挙動を学習するシミュレーション | 8 件（提案中） |
| [beer-game2](./beer-game2/index.md) | beer-game の知見をもとに、要件と設計を改訂して作り直す v2。共同担当、カスタム条件、観察者、自動確定を含む | 未着手 |
| [beer-game-kotlin](./beer-game-kotlin/index.md) | beer-game2 の Kotlin 版のアーキテクチャ決定記録 | 未着手 |

## 補足

- プロジェクトの追加は `apply-docs-structure` スキル（add-project）で行い、この一覧と `docs/index.md` を更新します。
- 実ドキュメントは `adr/<project>/` に置き、プロジェクトの `index.md` で一覧を管理します。
- ADR の作成には `creating-adr` スキルを使用してください。
- テンプレートは [template/ADR.md](../template/ADR.md) です。
