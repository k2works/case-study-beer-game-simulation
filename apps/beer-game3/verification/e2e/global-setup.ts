import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  createDisposableDatabase,
  newRunId,
  startApp,
  sweepStaleDatabases,
} from '../load/lifecycle.js';
import { checkTarget } from '../shared/target-guard.js';

const WEB_DIST = fileURLToPath(new URL('../../dist/web', import.meta.url));

/**
 * 画面の試験の準備。使い捨てのデータベースとアプリケーション（空きポート）を起動し、
 * 試験が使う接続先を E2E_BASE_URL に入れる。終了時（返す関数）に必ず止めて破棄する。
 * `VERIFY_TARGET_URL` を指定する外部接続のモードでは、何も起動せず、接続先の検査を通ったその URL を使う。
 */
export default async function globalSetup(): Promise<() => Promise<void>> {
  const external = process.env.VERIFY_TARGET_URL;
  if (external) {
    const guard = checkTarget({
      appUrl: external,
      allowRemote: process.env.VERIFY_ALLOW_REMOTE === '1',
    });
    if (!guard.ok) {
      throw new Error(`接続先の検査に失敗しました（${guard.item}）`);
    }
    process.env.E2E_BASE_URL = external;
    return async () => undefined;
  }

  const adminUrl = process.env.VERIFY_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!adminUrl) {
    throw new Error('DATABASE_URL（または VERIFY_DATABASE_URL）が指定されていません');
  }
  const guard = checkTarget({
    databaseUrl: adminUrl,
    allowRemote: process.env.VERIFY_ALLOW_REMOTE === '1',
    env: process.env,
  });
  if (!guard.ok) {
    throw new Error(`接続先の検査に失敗しました（${guard.item}）`);
  }
  if (!existsSync(`${WEB_DIST}/index.html`)) {
    throw new Error('画面のビルドがありません。先に npm run build を実行してください');
  }

  await sweepStaleDatabases(adminUrl).catch(() => []);
  const database = await createDisposableDatabase(adminUrl, newRunId());
  let app: Awaited<ReturnType<typeof startApp>>;
  try {
    // 試験は同じ接続元（localhost）から多数の無効な資格情報の試行を行うため、窓の上限を広げる（試験用の設定）
    app = await startApp({
      databaseUrl: database.url,
      webDist: WEB_DIST,
      envOverrides: { JOIN_WINDOW_MAX_ATTEMPTS: '1000' },
    });
  } catch (error) {
    await database.drop();
    throw error;
  }
  process.env.E2E_BASE_URL = app.baseUrl;
  return async () => {
    await app.stop();
    await database.drop();
  };
}
