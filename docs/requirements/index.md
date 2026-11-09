# 要件

RDRA 2.0 に基づく要件定義ドキュメントです。

## プロジェクト一覧

| プロジェクト | 概要 | 状況 |
| :--- | :--- | :--- |
| [beer-game](./beer-game/index.md) | 改訂版ビールゲームを再現し、サプライチェーンの動的挙動を学習するシミュレーション | 要件定義中 |
| [beer-game2](./beer-game2/index.md) | beer-game の知見をもとに、要件と設計を改訂して作り直す v2。共同担当、カスタム条件、観察者、自動確定を含む | 未着手 |

## 補足

- プロジェクトの追加は `apply-docs-structure` スキル（add-project）で行い、この一覧と `docs/index.md` を更新します。
- 実ドキュメントは `requirements/<project>/` に置き、プロジェクトの `index.md` で一覧を管理します。
- テンプレートは次を利用できます。
  - [template/要件定義.md](../template/要件定義.md)
  - [template/完全形式のユースケース.md](../template/完全形式のユースケース.md)
