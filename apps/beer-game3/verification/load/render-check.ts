import { parseVerifyConfig } from '../shared/config.js';
import { runVerification } from './runner.js';

/**
 * 実ブラウザの反映の測定の確認（npm run verify:render）。1 チームを実ブラウザ（Chromium）の 5 画面で見せ、
 * 数週を確定して、新しい週が画面に現れるまでを測る。Chromium が導入されている環境で動かす。
 * 合否は、5 画面 × 週数の標本があり、95 パーセンタイルが 2 秒以内であること。
 */

const write = (event: Record<string, unknown>): void => {
  process.stderr.write(`${JSON.stringify({ time: new Date().toISOString(), ...event })}\n`);
};

async function main(): Promise<number> {
  const parsed = parseVerifyConfig(
    {
      VERIFY_TEAMS: '2',
      VERIFY_BROWSER_TEAMS: '1',
      VERIFY_WARMUP_SECONDS: '1',
      VERIFY_NORMAL_SECONDS: '20',
      VERIFY_CONFIRM_INTERVAL_SECONDS: '5',
      ...process.env,
    },
    'smoke',
  );
  if (!parsed.ok) {
    write({ event: 'verify_end', exitCode: 2, problems: parsed.problems });
    return 2;
  }
  const adminDatabaseUrl = process.env.VERIFY_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!adminDatabaseUrl) {
    write({ event: 'verify_end', exitCode: 2, problems: ['DATABASE_URL が指定されていません'] });
    return 2;
  }
  const result = await runVerification({
    config: { ...parsed.config, browserTeams: 1 },
    mode: 'smoke',
    adminDatabaseUrl,
    allowRemote: process.env.VERIFY_ALLOW_REMOTE === '1',
    revision: { commit: 'local', branch: 'local' },
    log: write,
  });
  const browser = result.summary.phases.normal.reflectionBrowser;
  process.stdout.write(
    `${JSON.stringify({ verdict: result.summary.verdict, reflectionBrowser: browser })}\n`,
  );
  if (result.exitCode !== 0) {
    return result.exitCode;
  }
  const ok = browser.count >= 5 && browser.p95 !== null && browser.p95 <= 2000;
  return ok ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    write({
      event: 'verify_end',
      exitCode: 2,
      errorName: error instanceof Error ? error.name : 'unknown',
    });
    process.exit(2);
  });
