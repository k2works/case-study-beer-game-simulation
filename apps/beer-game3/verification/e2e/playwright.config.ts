import { fileURLToPath } from 'node:url';
import { defineConfig, devices, type PlaywrightTestConfig } from '@playwright/test';
import { checkTarget } from '../shared/target-guard.js';

/**
 * 画面の試験の設定。
 * - `retries: 0` を固定する（不安定な試験は再実行でなく原因を直す。reliability-design.md の NFR2.3）。
 * - トレースと画面の画像は、失敗時だけ取る。接続先の検査（TargetGuard）の結果が外部接続なら取らない（別々に判定しない）。
 * - 動画は取らない。
 * - 4 ブラウザ（Chromium、Firefox、WebKit、Edge の `msedge`）。通しの試験と主要な操作の試験だけを 4 つで動かし、
 *   axe-core、状態の表示、日本語表示は Chromium だけで動かす。
 */
const CROSS_BROWSER_SPECS = ['**/keyboard-flow.e2e.ts', '**/main-operations.e2e.ts'];

export function buildPlaywrightConfig(
  env: Record<string, string | undefined>,
): PlaywrightTestConfig {
  const guard = checkTarget({
    appUrl: env.VERIFY_TARGET_URL,
    allowRemote: env.VERIFY_ALLOW_REMOTE === '1',
  });
  if (!guard.ok) {
    throw new Error(`接続先の検査に失敗しました（${guard.item}）。${guard.reason}`);
  }
  const artifacts = guard.artifactsEnabled;
  return defineConfig({
    testDir: '.',
    testMatch: '**/*.e2e.ts',
    outputDir: fileURLToPath(new URL('../../test-results', import.meta.url)),
    fullyParallel: true,
    retries: 0,
    workers: env.CI ? 2 : undefined,
    timeout: 90_000,
    expect: { timeout: 15_000 },
    reporter: [['list']],
    globalSetup: './global-setup.ts',
    use: {
      locale: 'ja-JP',
      trace: artifacts ? 'retain-on-failure' : 'off',
      screenshot: artifacts ? 'only-on-failure' : 'off',
      video: 'off',
    },
    projects: [
      { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
      {
        name: 'firefox',
        use: { ...devices['Desktop Firefox'] },
        testMatch: CROSS_BROWSER_SPECS,
      },
      {
        name: 'webkit',
        use: { ...devices['Desktop Safari'] },
        testMatch: CROSS_BROWSER_SPECS,
      },
      {
        name: 'edge',
        use: { ...devices['Desktop Edge'], channel: 'msedge' },
        testMatch: CROSS_BROWSER_SPECS,
      },
    ],
  });
}

export default buildPlaywrightConfig(process.env);
