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

## 復帰と権限の設定（U4）

| 環境変数                       | 既定              | 内容                                                                             |
| :----------------------------- | :---------------- | :------------------------------------------------------------------------------- |
| `APP_ENV`                      | `development`     | `development`、`test`、`staging`、`production`                                   |
| `TRUSTED_PROXY_HOPS`           | 未設定            | 信頼するプロキシの段数。`staging` と `production` では必須で、無ければ起動しない |
| `RETURN_TOKEN_TTL_MINUTES`     | `1440`（24 時間） | 復帰用 token の有効期間（最後の操作から）                                        |
| `TOKEN_TOUCH_INTERVAL_SECONDS` | `60`              | 最後の操作の時刻を書き込む最短の間隔                                             |
| `JOIN_WINDOW_SECONDS`          | `60`              | 参加の無効な試行を数える窓の長さ                                                 |
| `JOIN_WINDOW_MAX_ATTEMPTS`     | `10`              | 窓に許す件数。これを超える（11 件目の）試行は、有効なコードでも 429 で拒否する   |
| `JOIN_SWEEP_INTERVAL_MINUTES`  | `10`              | 窓の古い行を削除する周期（起動時にも 1 回削除する）                              |

ロードバランサーの背後では `TRUSTED_PROXY_HOPS` を必ず設定してください（設定しないと全員が 1 つの接続元になり、他人の誤入力で参加できなくなります）。`npm run test:u4` で U4 の試験だけを実行できます（結合の試験には `DATABASE_URL` が必要です）。

## 結果と出力、保持と削除の設定（U5）

| 環境変数                         | 既定  | 範囲    | 内容                                                                                   |
| :------------------------------- | :---- | :------ | :------------------------------------------------------------------------------------- |
| `RETENTION_DAYS`                 | `30`  | 1〜3650 | 終了から削除までの日数。短くすると、すでに終了したゲームにも次の定期処理から適用される |
| `AUTO_END_DAYS`                  | `30`  | 1〜3650 | 最後の操作から自動終了までの日数。準備中と一時停止中のゲームも対象                     |
| `RETENTION_JOB_INTERVAL_MINUTES` | `60`  | 1〜1440 | 定期処理の間隔。起動の完了後に待たずに 1 回、その後はこの間隔で動く                    |
| `RETENTION_BATCH_LIMIT`          | `100` | 1〜1000 | 1 回の処理で、自動終了と削除のそれぞれに扱うゲームの数の上限。処理が重いときは下げる   |

範囲の外や整数でない値は、起動を拒否します。起動の完了時に有効な値を `retention_config` のログに出し、`RETENTION_DAYS` または `AUTO_END_DAYS` が既定（30）より短いときは `retention_config_shorter_than_default` を警告で出します。定期処理は HTTP の入口を持たず、複数台でも PostgreSQL のアドバイザリロックで二重に実行しません。結果は `retention_run`（自動終了・削除・失敗の数と所要時間）、削除は `game_deleted`（ゲームの識別子・時刻・理由だけ）のログで分かります。

運用への引き渡し: 構造化ログの保持期間と、データベースのバックアップの保持期間は、ゲームの保持期間（既定 30 日）を超えない目標で定めてください。`npm run test:u5` で U5 の試験だけを実行できます（結合の試験には `DATABASE_URL` が必要です）。

## 非機能の検証（U6）

負荷、画面の品質（キーボード、アクセシビリティ、日本語表示）、主要なブラウザでの動作を測って合否を決める仕組みです。場所は `verification/` で、アプリケーションの `src/` は変えません。HTTP の公開の面だけを使い、使い捨てのデータベースとアプリケーション（空きポート）を自分で起動して、終了時に破棄します。

| 目的                                     | コマンド                                                                      |
| :--------------------------------------- | :---------------------------------------------------------------------------- |
| 検証の部品の試験（Vitest）               | `npm run test:u6`（結合の試験には `DATABASE_URL` が必要）                     |
| 短い負荷試験（1 分、15 チーム）          | `npm run verify:load:smoke`                                                   |
| 本試験（通常負荷 10 分 + 最大想定 3 分） | `npm run verify:load:main`（約 14 分。手元の実行は合否の証拠にしない）        |
| 実ブラウザの反映の測定の確認             | `npm run verify:render`（要 Chromium）                                        |
| 画面の試験（Chromium）                   | `npm run build` のあと `npm run e2e -- --project=chromium`                    |
| 画面の試験（4 ブラウザ）                 | `npm run e2e`（Firefox、WebKit、Edge の導入が必要。CI の `e2e` ジョブが担当） |
| 本番の依存の検査                         | `npm run verify:prod-deps`                                                    |

- **前提**: `DATABASE_URL`（使い捨てのデータベースを作れる、`localhost` の PostgreSQL への接続）。ブラウザは `npx playwright install chromium`（Firefox、WebKit、Edge も同様）。画面の試験は、先に `npm run build` で画面を作る。
- **接続先の検査**: 接続先が `localhost`（`127.0.0.1`、`::1`、Unix ドメインソケット）でなければ、何も送らず終了コード 2 で終わります。外部を指すには `VERIFY_ALLOW_REMOTE=1` が必要で、そのときはトレースと画面の画像を保存しません。
- **設定**: `VERIFY_TEAMS`（既定 15）、`VERIFY_NORMAL_SECONDS`（600）、`VERIFY_PEAK_SECONDS`（180）、`VERIFY_SEED`（種）など。不正な値は終了コード 2 です。結果は標準出力の最後の行と `verify-summary.json`（`verify-summary.md` はジョブの要約の表）に出ます。
- **終了コード**: 合格 0、不合格 1、無効（測定器の飽和、起動の失敗、設定の誤り）2。閾値は緩めず、再実行で通ったことを合格にしません。
- **CI**: `.github/workflows/beer-game3.yml`。必須のチェックは `gate` の 1 つだけです（設定の手順と戻し方は `docs/operation/beer-game3/required-check.md`）。リリース前の確認票は `docs/operation/beer-game3/release-checklist.md` です。
