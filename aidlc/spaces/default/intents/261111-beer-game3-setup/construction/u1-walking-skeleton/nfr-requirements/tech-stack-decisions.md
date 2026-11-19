# 技術スタックの決定 - U1 u1-walking-skeleton

U1 が使う技術の選択と理由です。Q1 の決定どおり、beer-game2 と同じ構成を引き継ぎます。コードは複製しません。以降の Unit も、この構成の上に積みます。

出典: `requirements.md`（NFR3、NFR8、NFR10、NFR11）、`team-practices.md` の Code Style（Node.js 26、PostgreSQL 18、ESM、camelCase）、`technology-stack.md`（beer-game2 の構成。参考）、`nfr-requirements-questions.md`（Q1）。

版は、`technology-stack.md`（beer-game2 の `package.json` を 2026-11-11 に読んだ記録）にある値を、候補として載せています。npm や公式サイトでの再確認はまだしていません。実装（Code Generation）の時点で、公式情報で確かめて決めます。

## 決定

| 区分 | 選択 | 候補の版 | 理由 | 関連する要件 |
| :--- | :--- | :--- | :--- | :--- |
| 実行環境 | Node.js | 26 | team の方針。ESM と camelCase を継続する | team の Code Style |
| 言語 | TypeScript（strict） | 6.0.3 | 型でサーバー側の検証と契約を支える。週の計算の誤りを型で減らす | NFR1.1、NFR6.5 |
| Web サーバー | Fastify | 5.12.8 | 軽量で、スキーマによる検証と相性がよい | NFR3.1 |
| データベース | PostgreSQL | 18 | team の方針。1 回の保存での原子的な更新と、ゲーム単位の直列処理に使う | NFR2.1、NFR4.2 |
| データベース接続・移行 | pg、node-pg-migrate | 8.23.1、9.0.0 | 移行を Unit ごとに足す（`contract-summary.md` の C3） | NFR2.1 |
| 入力の検証 | zod | 4.6.7 | 型と実行時の検証を一致させる | NFR6.5 |
| 画面 | React、Vite | 19.3.1、8.3.6 | 日本語の画面を、ブラウザで配信する | NFR10.1、NFR11.1 |
| 単体・結合の試験 | Vitest | 5.1.0 | 型と相性がよく、行カバレッジ 80% の検査に使う | team の Testing Posture |
| 画面の試験 | Testing Library | 候補（実装時に確認） | 振る舞いで画面を試験する | NFR8.1 |
| E2E・アクセシビリティ | Playwright、axe-core | 1.65.0、4.14.0 | キーボード操作とコントラストを自動で検査する | NFR8.1、NFR10.1 |
| 品質 | ESLint、typescript-eslint、Prettier | 10.14.0、8.72.1、3.9.10 | team の方針（formatter、linter、type-check） | team の Code Style |
| 暗号 | Node.js 標準の暗号（AES-256-GCM、SHA-256） | - | 追加の依存を増やさない | NFR6.3 |
| コンテナ | node:26-alpine（複数段、非 root） | - | 後の CI とデプロイで使う | team の Deployment |

## 方針

- 構成は beer-game2 を踏襲するが、コードは複製しない。beer-game2 の設計は、参考にとどめる（team の方針）。
- 依存を増やすときは、理由を記録する（外部ライブラリの導入は確認必須）。
- 版は、実装の時点で公式情報で確かめ、サポート期限を確認して決める。固定する版は、`package.json` に記録する。
- 週の計算（SimulationEngine）は、フレームワークに依存しない純粋な関数として作る。

## 却下した案

- 画面とサーバーを 1 つにまとめる全部入りのフレームワーク: 週の計算と権限の投影を、フレームワークの規約から切り離して試験したいこと、team が既に beer-game2 で今の構成の実績を持つことから、却下した。

## 上流の資料

`requirements.md`、`team-practices.md`、`technology-stack.md`、`nfr-requirements-questions.md`
