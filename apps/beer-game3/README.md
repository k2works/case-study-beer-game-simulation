# beer-game3

ビールゲーム シミュレーション beer-game3。この版（U1）は、1 ゲームを作成し、4 役割が入力し、進行役が 1 週ずつ確定して、役割別の状態を表示する「薄い一通り」です。

## 構成

| 場所                  | 内容                                                                         |
| :-------------------- | :--------------------------------------------------------------------------- |
| `src/server/domain/`  | SimulationEngine（週の計算。純粋な関数）、役割などの定数                     |
| `src/server/access/`  | AccessControl（コードと token の発行、鍵付きハッシュと暗号化、権限の判定）   |
| `src/server/session/` | GameSession（ゲームの集約の操作）、保存（PostgreSQL とメモリ）、役割別の投影 |
| `src/server/http/`    | Fastify の入口（共通のエラー形式、構造化ログ、セキュリティヘッダ）           |
| `src/web/`            | React の画面（S0 参加入口、S1 ゲーム作成、S2 ロビー、S3 役割別プレイ）       |
| `migrations/`         | データベースの移行（SQL）                                                    |
| `tests/u1/`           | 振る舞い・単体・結合・画面の試験                                             |

## 準備

- Node.js 26（`.nvmrc`）、PostgreSQL 18。
- 依存のインストール: `npm install`
- `.env.example` を `.env` にコピーして、`DATABASE_URL` と鍵（`CODE_ENC_KEY`、`CODE_HMAC_KEY`）を設定する。鍵が無ければサーバーは起動しない。
- 移行: `npm run migrate`

## よく使うコマンド

| 目的                                  | コマンド                                                    |
| :------------------------------------ | :---------------------------------------------------------- |
| 試験（DB なし）                       | `npm run test:unit`                                         |
| 試験（結合。要 `DATABASE_URL`）       | `npm run test:integration`                                  |
| 試験（画面）                          | `npm run test:web`                                          |
| カバレッジ（行 80% 以上を満たすこと） | `npm run test:coverage`                                     |
| 型検査・lint・書式                    | `npm run typecheck`、`npm run lint`、`npm run format:check` |
| ビルド                                | `npm run build`                                             |
| 本番の起動                            | `npm run start`（画面は `dist/web` から配信する）           |
| 開発（サーバー）                      | `npm run dev:server`（既定のポート 3100）                   |
| 開発（画面）                          | `npm run dev:web`（ポート 5273。`/api` は 3100 へ中継）     |

開発のポートは、別の開発サーバー（3000 と 5173）と重ならない値にしてあります。
