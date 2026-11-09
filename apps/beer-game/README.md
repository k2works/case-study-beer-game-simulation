# Beer Game

## Local setup

Node.js 22 と Docker が必要です。`npm install` 後、`docker compose up -d postgres` で PostgreSQL を起動し、`migrations/001_u1_walking_skeleton.sql` から `005_u5_shared_game_store.sql` までを番号順に適用します。`DATABASE_URL`、`GAME_CREDENTIAL_ENCRYPTION_KEY`（32 byte の hex）、`ALLOWED_ORIGIN` を設定して `npm start` で起動します。DB 接続と暗号鍵は production では Secrets Manager から ECS task に注入します。既存データへの migration 適用は運用手順に従います。

### 開発サーバー

`npm run dev` で API（`http://localhost:3000`、DB なしの in-memory）と Vite dev server（`http://localhost:5173`、HMR）を並行起動し、ブラウザを自動で開きます。`/api` は Vite が API にプロキシし、`ALLOWED_ORIGIN` は `http://localhost:5173` に設定されます。

## Verification

- `npm run test:u1`: U1 unit / HTTP integration test。
- `npm run verify:u1`: format、lint、type-check、80% line coverage。
- `npm run e2e:u1`: Playwright walking-skeleton test（browser install が必要）。
- `GAME_TEST_DATABASE_URL` に専用の `_u5_test` database を指定して `npm run test:u5`: 独立した 2 API process の共有 DB integration を含みます。
- `npm run e2e:u5`: Chromium で主要な browser flow を検証します。
- `U5_BROWSER_MATRIX=1 npm run e2e:u5`: Chromium、Firefox、WebKit、Chrome for Testing、Edge で同じ flow を検証します。初回は `npx playwright install firefox webkit` と `npx --yes @puppeteer/browsers install chrome@stable --path .browser-binaries` を実行し、Edge は OS に導入してください。Chrome for Testing は user 領域の `.browser-binaries/` から自動検出します。

HTTP mutation は `Idempotency-Key` と同一 Origin を、versioned update は `If-Match` を使用します。cookie は HttpOnly、Secure、SameSite=Strict です。SSE 切断時は browser が 1 秒間隔の polling に切り替え、resource version が新しい response だけを適用します。

## Failure recovery

Committed state と outbox は同一 PostgreSQL transaction に含めます。dispatcher は unpublished row を transaction 内で排他取得し、失敗時は attempts を記録します。`LISTEN/NOTIFY` は hint に限定し、欠落時は 1 秒間隔の version reconciliation で回復します。production database は Multi-AZ と PITR を使用します。
