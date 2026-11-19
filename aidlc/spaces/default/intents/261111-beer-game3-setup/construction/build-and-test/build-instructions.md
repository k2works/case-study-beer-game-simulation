# ビルドの手順 - beer-game3

## 前提

| 項目 | 内容 |
| :--- | :--- |
| Node.js | 26（`apps/beer-game3/.nvmrc`）。`. ~/.nvm/nvm.sh && nvm use 26` |
| PostgreSQL | 18。試験用は `localhost:55432`（Docker のコンテナ `beer-game3-pg`）。接続は `postgres://postgres:postgres@localhost:55432/beer_game3_test` |
| 依存の導入 | `npm --prefix apps/beer-game3 ci` |
| ブラウザ（画面の試験のみ） | `npx playwright install chromium firefox webkit`（Edge は CI のジョブで導入） |

## 環境変数（アプリケーション）

必須: `DATABASE_URL`、`CODE_ENC_KEY`、`CODE_HMAC_KEY`（形式 `<識別子>:<base64 の 32 バイト>`）。任意: `HOST`、`PORT`、`RUN_MIGRATIONS=true`、`WEB_DIST`、保持と自動終了の設定（`RETENTION_DAYS` など）。`staging` と `production` では `TRUSTED_PROXY_HOPS` が必須（Operation で設定）。試験では鍵は試験用の固定値または実行ごとの生成値を使い、本番の鍵を使わない。

## ビルドのコマンド

| 手順 | コマンド | 確認 |
| :--- | :--- | :--- |
| 型検査と本番の変換と画面のビルド | `npm --prefix apps/beer-game3 run build` | `dist/server/` と `dist/web/`（`index.html`、`assets/`）ができる |
| 移行 | `npm --prefix apps/beer-game3 run migrate`（開発用データベース）。試験では `RUN_MIGRATIONS=true` で起動時に適用 | `pgmigrations` に 5 件（u1〜u5） |
| 本番の依存の検査 | `npm --prefix apps/beer-game3 run verify:prod-deps` | 検証の依存が本番の依存に含まれない |
| 全体の検証 | `DATABASE_URL=... npm --prefix apps/beer-game3 run verify` | 型検査、lint、整形、カバレッジつきの全試験 |

## よくある問題

| 症状 | 原因と対処 |
| :--- | :--- |
| `engines` の警告または失敗 | 既定のシェルが Node.js 24。`nvm use 26` で切り替える |
| 画面の試験が `DATABASE_URL` がないと失敗 | 管理用の接続が必要。上の接続を環境変数で渡す |
| `Port already in use` | 試験は空きポートを使う。開発サーバー（3000、5173）は止めない |
| `bg3_verify_*` のデータベースが残る | 1 時間より古いものは次の実行で自動で削除される |
| ルートから `vitest run tests/u6/integration` が 1 件失敗 | 設定ファイルが効かず並列になる。`npm --prefix apps/beer-game3 run test:u6` を使う |
