# 試験の手順 - U2 u2-weekly-rules

U2 の試験の実行方法です。すべてのコマンドは、この Unit の試験だけを対象にします（`apps/beer-game3/` の `tests/u2/`）。U1 の試験も緑のまま保ちます。

## 試験の構成

- 振る舞いの試験（Given/When/Then）: `tests/u2/features/*.spec.ts`。メモリ上の保存を使う。
- 単体の試験: `tests/u2/unit/*.spec.ts`（キット準拠の判定、設定の検証）。
- 結合の試験: `tests/u2/integration/*.spec.ts`。実際の PostgreSQL 18 に接続する。
- golden test の期待値: `tests/u2/fixtures/` に固定したファイル。実装とは別の計算で作る。

## 事前準備

- Node.js 26（`source ~/.nvm/nvm.sh && nvm use 26`）。
- PostgreSQL 18 は、コンテナ `beer-game3-pg`（ポート 55432）。`DATABASE_URL=postgres://postgres:postgres@localhost:55432/beer_game3_test`。
- 鍵は `vitest.config.ts` の試験用の固定値。

## 実行するコマンド（`apps/beer-game3/` で実行）

| 目的 | コマンド |
| :--- | :--- |
| 振る舞いと単体（DB なし） | `npx vitest run tests/u2/features tests/u2/unit` |
| 結合（要 PostgreSQL） | `DATABASE_URL=… npx vitest run tests/u2/integration` |
| 全体（U1 と U2、カバレッジの閾値つき） | `DATABASE_URL=… npm run verify` |

## golden test の期待値の再生成と確認

| 目的 | コマンド（`apps/beer-game3/` で実行） |
| :--- | :--- |
| 期待値を導出して書く | `node tests/u2/fixtures/derive-golden.mjs` |
| 保存した期待値が導出と一致することを確かめる | `node tests/u2/fixtures/derive-golden.mjs --check`（振る舞いの試験の中でも実行される） |

導出の script はエンジンを読み込まない。期待値の JSON は書式の対象外（`.prettierignore`）。

## カバレッジ

行 80% 以上。閾値は下げない。満たさないときは試験を足す。

## 方針

- 受入条件ごとに、名前に ID を含める（例: `AC1.6.3`）。実装の前に実行して、期待どおりに失敗することを確認し、その出力を記録する。
- golden test: 需要は週 1〜4 が 4、週 5 以降が 8。意思決定は、各役割が受注の数を発注する。期待値は 50 週 × 4 役割の在庫、受注残、受注、入荷、出荷、費用。実装の出力をそのまま期待値にしない。
- 時計と乱数は注入して固定する。PostgreSQL はモックしない。

## 試験データ

- 試験用のキット準拠のプリセット（全項目一致と、需要系列を含む仮の値）を、試験の中だけに定義する。実際の KitPreset は需要系列が未提供のまま。
- 上限ぎりぎりの設定: 初期在庫 9999、初期パイプライン 9999、単価 10000、需要 9999。
