# 試験の手順 - U3 u3-facilitation

U3 の試験の実行方法です。すべてのコマンドは、この Unit の試験だけを対象にします（`apps/beer-game3/` の `tests/u3/`）。U1・U2 の試験も緑のまま保ちます。

## 試験の構成

- 振る舞いの試験（Given/When/Then）: `tests/u3/features/*.spec.ts`。メモリ上の保存を使う。
- 単体の試験: `tests/u3/unit/*.spec.ts`（遷移の表、ラベル、履歴の型、静的な検査）。
- 結合の試験: `tests/u3/integration/*.spec.ts`。実際の PostgreSQL 18 に接続する。
- 画面の試験: `tests/u3/web/*.spec.tsx`（進行管理、置き換わりの通知、一時停止中の表示）。

## 事前準備

- Node.js 26（`source ~/.nvm/nvm.sh && nvm use 26`）。
- PostgreSQL 18 は、コンテナ `beer-game3-pg`（ポート 55432）。`DATABASE_URL=postgres://postgres:postgres@localhost:55432/beer_game3_test`。
- 鍵は `vitest.config.ts` の試験用の固定値。

## 実行するコマンド（`apps/beer-game3/` で実行）

| 目的 | コマンド |
| :--- | :--- |
| 振る舞いと単体（DB なし） | `npx vitest run tests/u3/features tests/u3/unit` |
| 画面 | `npx vitest run tests/u3/web` |
| 結合（要 PostgreSQL） | `DATABASE_URL=… npx vitest run tests/u3/integration` |
| 全体（U1・U2・U3、カバレッジの閾値つき） | `DATABASE_URL=… npm run verify` |

## カバレッジ

行 80% 以上。閾値は下げない。満たさないときは試験を足す。

## 方針

- 受入条件ごとに、名前に ID を含める（例: `AC2.6.1`）。実装の前に実行して、期待どおりに失敗することを確認し、その出力を記録する。
- 時計と乱数は注入して固定する。PostgreSQL はモックしない。
- 競合の試験（入れ替えと旧担当者の入力、最終週の確定と終了）は、実際の PostgreSQL で、占有の順を両方向で確かめる。
- ログの試験は、入れ替え後の出力に token の文字列と進行役用コードが無いことを確かめる。
- 静的な検査: 履歴の表に対する `UPDATE` と `DELETE` の文がソースに無いことを確かめる。

## 試験データ

- 同名の参加者（「太郎」2 人）、同じ役割に 4 人の共同担当、50 週のゲーム（最終週の確定）、履歴 1,000 件の上限の確認用のゲーム。
