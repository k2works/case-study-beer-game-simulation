import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { buildChildEnv } from '../shared/child-env.js';

/**
 * 使い捨てのデータベースとアプリケーションの子プロセスの起動と破棄（Lifecycle。reliability-design.md）。
 * 試験の起動と破棄はスクリプト自身が行う。失敗、例外、中断（SIGINT、SIGTERM）のいずれでも同じ破棄の処理を通す。
 */

const APP_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const DB_PREFIX = 'bg3_verify_';
const STALE_AFTER_MS = 3600_000;

/** 実行の識別子。時刻（秒）を埋め込み、古い残りの掃除に使う。 */
export function newRunId(now: number = Date.now()): string {
  return `${Math.floor(now / 1000)}_${randomBytes(4).toString('hex')}`;
}

function withDatabaseName(connectionString: string, name: string): string {
  const replaced = connectionString.replace(
    /^(postgres(?:ql)?:\/\/[^/?#]*)(\/[^?#]*)?/i,
    (_all, authority: string) => `${authority}/${name}`,
  );
  return replaced;
}

async function withAdminClient<T>(
  adminUrl: string,
  fn: (client: pg.Client) => Promise<T>,
): Promise<T> {
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

export interface DisposableDatabase {
  name: string;
  url: string;
  drop(): Promise<void>;
}

export async function createDisposableDatabase(
  adminUrl: string,
  runId: string,
): Promise<DisposableDatabase> {
  const name = `${DB_PREFIX}${runId}`;
  if (!/^bg3_verify_\d+_[0-9a-f]+$/.test(name)) {
    throw new Error('実行の識別子の形式が正しくありません');
  }
  await withAdminClient(adminUrl, (client) => client.query(`create database ${name}`));
  let dropped = false;
  return {
    name,
    url: withDatabaseName(adminUrl, name),
    async drop() {
      if (dropped) {
        return;
      }
      dropped = true;
      await withAdminClient(adminUrl, (client) =>
        client.query(`drop database if exists ${name} with (force)`),
      );
    },
  };
}

/** 1 時間より古い bg3_verify_ のデータベースを削除する。新しいものと、ほかのデータベースには触れない。 */
export async function sweepStaleDatabases(
  adminUrl: string,
  nowMs: number = Date.now(),
  maxAgeMs: number = STALE_AFTER_MS,
): Promise<string[]> {
  return withAdminClient(adminUrl, async (client) => {
    const result = await client.query<{ datname: string }>(
      "select datname from pg_database where datname like 'bg3\\_verify\\_%'",
    );
    const removed: string[] = [];
    for (const { datname } of result.rows) {
      const match = /^bg3_verify_(\d+)_[0-9a-f]+$/.exec(datname);
      if (!match) {
        continue;
      }
      const createdMs = Number(match[1]) * 1000;
      if (nowMs - createdMs > maxAgeMs) {
        await client.query(`drop database if exists ${datname} with (force)`);
        removed.push(datname);
      }
    }
    return removed;
  });
}

/** 空きポートを OS に選ばせる。 */
export async function freePort(): Promise<number> {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  server.close();
  await once(server, 'close');
  return port;
}

export interface AppProcess {
  pid: number;
  port: number;
  baseUrl: string;
  stop(): Promise<void>;
}

export interface StartAppOptions {
  databaseUrl: string;
  /** 画面の配信用（ビルド済み）。既定は dist/web */
  webDist?: string;
  /** 試験のための環境の上書き（許可リストの組み立てを通す） */
  envOverrides?: Record<string, string>;
  startTimeoutMs?: number;
  /** 起動の方式。tsx はビルド不要、dist は npm run build の後 */
  mode?: 'tsx' | 'dist';
}

const liveChildren = new Set<ChildProcess>();

function generatedKey(id: string): string {
  return `${id}:${randomBytes(32).toString('base64')}`;
}

function waitExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolve) => child.once('exit', () => resolve()));
}

async function terminate(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    liveChildren.delete(child);
    return;
  }
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
  await waitExit(child);
  clearTimeout(timer);
  liveChildren.delete(child);
}

/**
 * アプリケーションを空きポートの子プロセスとして起動し、`listening` のログと GET /health の成功を待つ。
 * 環境は空から組み立て（許可リスト方式）、鍵は実行ごとに生成する。待ちは上限つきで、失敗したら子プロセスを止める。
 */
export async function startApp(options: StartAppOptions): Promise<AppProcess> {
  const port = await freePort();
  const mode = options.mode ?? (process.env.VERIFY_APP_MODE === 'dist' ? 'dist' : 'tsx');
  const timeoutMs = options.startTimeoutMs ?? 30_000;
  const env = buildChildEnv(process.env, {
    HOST: '127.0.0.1',
    PORT: String(port),
    DATABASE_URL: options.databaseUrl,
    CODE_ENC_KEY: generatedKey('e1'),
    CODE_HMAC_KEY: generatedKey('h1'),
    RUN_MIGRATIONS: 'true',
    WEB_DIST: options.webDist ?? `${APP_ROOT}dist/web`,
    APP_ENV: 'test',
    ...options.envOverrides,
  });
  const args =
    mode === 'dist' ? ['dist/server/main.js'] : ['--import', 'tsx', 'src/server/main.ts'];
  const child = spawn(process.execPath, args, {
    cwd: APP_ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  liveChildren.add(child);
  child.stderr?.resume();

  let lastEvent = 'none';
  const ready = new Promise<void>((resolve, reject) => {
    let buffer = '';
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      buffer += chunk;
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        try {
          const event = (JSON.parse(line) as { event?: unknown }).event;
          if (typeof event === 'string') {
            lastEvent = event;
            if (event === 'listening') {
              resolve();
            }
          }
        } catch {
          // JSON でない行は無視する
        }
        newline = buffer.indexOf('\n');
      }
    });
    child.once('exit', () =>
      reject(new Error(`アプリケーションの起動に失敗しました（終了。最後の事象: ${lastEvent}）`)),
    );
    child.once('error', () =>
      reject(new Error('アプリケーションの起動に失敗しました（実行できません）')),
    );
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + timeoutMs;
  try {
    await Promise.race([
      ready,
      new Promise<never>((_resolve, reject) =>
        setTimeout(
          () => reject(new Error('アプリケーションの起動の待ちが上限を超えました')),
          timeoutMs,
        ).unref(),
      ),
    ]);
    // listening の後、公開の面の健全性の確認が通るまで待つ
    for (;;) {
      try {
        const response = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(2000) });
        if (response.status === 200) {
          break;
        }
      } catch {
        // 起動の直後は接続できないことがある
      }
      if (Date.now() > deadline) {
        throw new Error('アプリケーションの起動の確認（/health）が上限を超えました');
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  } catch (error) {
    await terminate(child);
    throw error;
  }

  return {
    pid: child.pid ?? 0,
    port,
    baseUrl,
    stop: () => terminate(child),
  };
}

export interface LifecycleEnv {
  databaseName: string;
  databaseUrl: string;
  /** 破棄のときに、登録の逆順に呼ぶ処理を足す */
  registerCleanup(fn: () => Promise<void> | void): void;
}

/**
 * 使い捨てのデータベースを作って fn を実行し、終了時に必ず破棄する。
 * 残っているアプリケーションの子プロセスを止め、データベースを削除する。SIGINT、SIGTERM、未処理の例外でも同じ破棄を通す。
 */
export async function withLifecycle<T>(
  adminUrl: string,
  fn: (env: LifecycleEnv) => Promise<T>,
): Promise<T> {
  await sweepStaleDatabases(adminUrl).catch(() => []);
  const database = await createDisposableDatabase(adminUrl, newRunId());
  const cleanups: Array<() => Promise<void> | void> = [];
  const before = new Set(liveChildren);
  let cleaned = false;
  const cleanup = async (): Promise<void> => {
    if (cleaned) {
      return;
    }
    cleaned = true;
    for (const fnCleanup of cleanups.reverse()) {
      await Promise.resolve(fnCleanup()).catch(() => undefined);
    }
    for (const child of [...liveChildren]) {
      if (!before.has(child)) {
        await terminate(child).catch(() => undefined);
      }
    }
    await database.drop().catch(() => undefined);
  };

  const onSignal = (signal: NodeJS.Signals): void => {
    void cleanup().finally(() => process.exit(signal === 'SIGINT' ? 130 : 143));
  };
  const onCrash = (error: unknown): void => {
    void cleanup().finally(() => {
      process.stderr.write(
        `${JSON.stringify({ event: 'verify_crash', errorName: error instanceof Error ? error.name : 'unknown' })}\n`,
      );
      process.exit(1);
    });
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  process.once('uncaughtException', onCrash);

  try {
    return await fn({
      databaseName: database.name,
      databaseUrl: database.url,
      registerCleanup: (cleanupFn) => cleanups.push(cleanupFn),
    });
  } finally {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    process.removeListener('uncaughtException', onCrash);
    await cleanup();
  }
}
