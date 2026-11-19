import { fileURLToPath } from 'node:url';
import { runner } from 'node-pg-migrate';

/** 移行の置き場（`migrations/`）。ビルド後（dist/server）からも、ソースからも同じ場所を指す。 */
export function migrationsDir(): string {
  // src/server/ と dist/server/ のどちらからも、2 つ上がアプリのルート
  return fileURLToPath(new URL('../../migrations', import.meta.url));
}

/** 移行を実行する。起動のとき（または scripts/migrate.mjs）から呼ぶ。 */
export async function runMigrations(
  databaseUrl: string,
  direction: 'up' | 'down' = 'up',
  count: number = Infinity,
): Promise<string[]> {
  const applied = await runner({
    databaseUrl,
    dir: migrationsDir(),
    direction,
    count,
    migrationsTable: 'pgmigrations',
    log: () => undefined,
  });
  return applied.map((m) => m.name);
}
