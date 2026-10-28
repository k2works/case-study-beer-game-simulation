# Beer Game U1 Walking Skeleton

## Local setup

Node.js 22 と Docker が必要です。`npm install` 後、`docker compose up -d postgres` で PostgreSQL を起動し、`migrations/001_u1_walking_skeleton.sql` を適用します。application は `npm start` で起動します。credential は URL や log に渡さず、production では Secrets Manager から database 接続を注入します。

## Verification

- `npm run test:u1`: U1 unit / HTTP integration test。
- `npm run verify:u1`: format、lint、type-check、80% line coverage。
- `npm run e2e:u1`: Playwright walking-skeleton test（browser install が必要）。

HTTP mutation は `Idempotency-Key`、versioned update は `If-Match`、cookie mutation は `X-CSRF-Token` を使用します。SSE 切断時は client が 4 秒間隔で state を再取得し、resource version が新しい response だけを適用します。

## Failure recovery

Committed state と outbox は同一 PostgreSQL transaction に含めます。dispatcher は unpublished row を順序取得し、失敗時は attempts を記録して backoff retry します。`LISTEN/NOTIFY` は hint に限定し、欠落時は outbox scan と version reconciliation で回復します。production database は Multi-AZ と PITR を使用し、RTO 15 分の restore drill を定期実行します。
