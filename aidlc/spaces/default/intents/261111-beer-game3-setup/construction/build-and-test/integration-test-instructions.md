# 結合試験の手順 - beer-game3

## 対象の境界

| 境界 | 内容 | 試験の場所 |
| :--- | :--- | :--- |
| HTTP ↔ GameSession ↔ PostgreSQL | 作成、参加、割当て、開始、入力、週の確定、一時停止・再開・終了、入れ替え、復元 | `tests/u1/integration`、`tests/u2/integration`、`tests/u3/integration`、`tests/u4/integration` |
| AccessControl ↔ すべての経路 | 資格情報の種類 × 経路の網羅（新しい経路は表に足すまで失敗） | `tests/u4/features/authorization-matrix.spec.ts` |
| Reporting ↔ GameSession（読み取りの一貫性） | 結果と出力。確定済みの週だけ、CSV と JSON の一致 | `tests/u5/integration`、`tests/u5/features` |
| Retention ↔ PostgreSQL | 自動終了と削除の原子性、ロック、除外、再検査 | `tests/u5/integration/retention-pg.spec.ts` |
| 検証の仕組み ↔ アプリケーション ↔ PostgreSQL | 使い捨ての起動と破棄、読み取り専用の整合性検査、負荷の実行 | `tests/u6/integration` |
| 画面 ↔ サーバー ↔ PostgreSQL（実ブラウザ） | 作成から結果までの通し、主要な操作、axe-core、状態の表示、日本語表示 | `verification/e2e/*.e2e.ts` |

## 実行

| 目的 | コマンド |
| :--- | :--- |
| 全 Unit の結合試験 | `DATABASE_URL=postgres://postgres:postgres@localhost:55432/beer_game3_test npm --prefix apps/beer-game3 run test:integration` |
| U6 の Vitest 全部 | `DATABASE_URL=... npm --prefix apps/beer-game3 run test:u6` |
| 画面の試験（Chromium） | `DATABASE_URL=... npm --prefix apps/beer-game3 run e2e -- --project=chromium` |
| 画面の試験（4 ブラウザ） | `DATABASE_URL=... npm --prefix apps/beer-game3 run e2e`（Edge は CI） |

## 環境とデータ

- ファイルは順に実行する（`fileParallelism: false`）。結合の試験は同じ PostgreSQL を使う。
- データは試験の中で生成した架空の値。表示名、参加コード、token は実在の個人を指さない。
- 使い捨てのデータベースは、成功しても失敗しても終了時に削除する。

## 期待

- 失敗 0 件。行のカバレッジ 80% 以上（現在 94.5%）。
- 再実行で通ることを合格にしない（`retries: 0`）。
