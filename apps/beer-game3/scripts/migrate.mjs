// データベースの移行を実行する。使い方: node scripts/migrate.mjs up | down
// 接続先は環境変数 DATABASE_URL から渡す（ソースにも DB にも置かない）。
import { runner } from 'node-pg-migrate';
import { fileURLToPath } from 'node:url';

const direction = process.argv[2] === 'down' ? 'down' : 'up';
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('DATABASE_URL が設定されていません');
  process.exit(1);
}

const applied = await runner({
  databaseUrl,
  dir: fileURLToPath(new URL('../migrations', import.meta.url)),
  direction,
  count: direction === 'down' ? 1 : Infinity,
  migrationsTable: 'pgmigrations',
  log: (message) => console.log(message),
});
console.log(`${direction}: ${applied.length} 件の移行を適用しました`);
