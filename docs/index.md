---
okf_version: "0.2"
---

# プロジェクトドキュメント

プロジェクトで管理しているドキュメントの入口です。

## まずこれを読もうリスト

- [戦略](./strategy/index.md) - ビジネス構造やプロジェクトの方向性を整理します。
- [要件](./requirements/index.md) - RDRA 2.0 ベースで要件を定義します。
- [設計](./design/index.md) - アーキテクチャ、モデル、品質方針を整理します。
- [開発](./development/index.md) - リリース計画とイテレーション管理の入口です。
- [運用](./operation/index.md) - 環境構築、デプロイ、運用関連の入口です。
- [記事](./article/index.md) - 学習用の記事シリーズの入口です。

## ドキュメント構成

| カテゴリ | 概要                                  | 状況 |
| :--- |:------------------------------------| :--- |
| [戦略](./strategy/index.md) | 企業分析、経営戦略、ビジネスアーキテクチャ、インセプションデッキの整理 | `index.md` を整備済み |
| [要件](./requirements/index.md) | RDRA 2.0 とユースケース整理の入口               | `index.md` を整備済み |
| [設計](./design/index.md) | アーキテクチャ、モデル、テスト、非機能の整理              | `index.md` を整備済み |
| [開発](./development/index.md) | リリース計画、イテレーション計画、進捗管理               | `index.md` を整備済み |
| [運用](./operation/index.md) | 環境構築、デプロイ、運用手順の整理                   | `index.md` を整備済み |
| [レビュー](./review/index.md) | 分析・開発レビュー結果の記録                      | `index.md` を整備済み |
| [ADR](./adr/index.md) | Architecture Decision Records の管理   | `index.md` を整備済み |
| [ジャーナル](./journal/index.md) | 開発ジャーナル（判断と学びの記録）        | `index.md` を整備済み |
| [記事](./article/index.md) | 学習用の記事シリーズ一覧                        | 公開サイトへのリンク集 |
| [リファレンス](./reference/index.md) | 開発ガイドラインやベストプラクティス                  | 39 件のドキュメントを配置 |
| [テンプレート](./template/index.md) | 各種ドキュメントの作成テンプレート                   | 18 件のテンプレートを配置 |

## 補足

- `strategy/` は企業で 1 つの統合戦略として管理し、プロジェクト別のサブディレクトリは作りません。
- `requirements/`、`design/`、`development/`、`operation/`、`adr/`、`journal/`、`review/` はプロジェクト別に管理します。カテゴリ直下の `index.md` はプロジェクト一覧の索引で、実ドキュメントとその一覧は `<category>/<project>/index.md` 配下に置きます。
- プロジェクトの追加は `apply-docs-structure` スキル（add-project）で行います。構成の規約は [ドキュメント構成ガイド](./reference/ドキュメント構成ガイド.md) を参照してください。
- `assets/` は MkDocs 用のスタイル・スクリプトを格納しています。
