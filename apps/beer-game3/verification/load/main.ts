import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { parseVerifyConfig, type VerifyMode } from '../shared/config.js';
import { renderStepSummary } from '../shared/summary.js';
import { runVerification } from './runner.js';

/**
 * 負荷試験の入口（npm run verify:load、verify:load:smoke、verify:load:main）。
 * 標準エラー出力に 1 行 1 件の JSON のログを出し、標準出力の最後の行に要約の JSON を出す。
 * 終了コードは、合格 0、不合格 1、無効（設定の誤りと接続先の検査を含む）2。
 */

const writeErr = (event: Record<string, unknown>): void => {
  process.stderr.write(`${JSON.stringify({ time: new Date().toISOString(), ...event })}\n`);
};

function git(args: string[]): string | null {
  try {
    return execFileSync('git', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

function modeFromArgs(argv: string[], env: NodeJS.ProcessEnv): VerifyMode | undefined {
  const index = argv.indexOf('--mode');
  const value = index >= 0 ? argv[index + 1] : env.VERIFY_MODE;
  return value === 'smoke' || value === 'main' ? value : undefined;
}

async function main(): Promise<number> {
  const mode = modeFromArgs(process.argv.slice(2), process.env) ?? 'main';
  const parsed = parseVerifyConfig(process.env, mode);
  if (!parsed.ok) {
    writeErr({ event: 'verify_end', verdict: 'invalid', exitCode: 2, problems: parsed.problems });
    return 2;
  }
  const adminDatabaseUrl = process.env.VERIFY_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!adminDatabaseUrl) {
    writeErr({
      event: 'verify_end',
      verdict: 'invalid',
      exitCode: 2,
      problems: ['DATABASE_URL（または VERIFY_DATABASE_URL）が指定されていません'],
    });
    return 2;
  }
  const result = await runVerification({
    config: parsed.config,
    mode,
    adminDatabaseUrl,
    allowRemote: process.env.VERIFY_ALLOW_REMOTE === '1',
    revision: {
      commit: git(['rev-parse', 'HEAD']) ?? process.env.GITHUB_SHA ?? 'unknown',
      branch:
        process.env.VERIFY_BRANCH ??
        process.env.GITHUB_HEAD_REF ??
        git(['rev-parse', '--abbrev-ref', 'HEAD']) ??
        process.env.GITHUB_REF_NAME ??
        'unknown',
    },
    log: writeErr,
  });
  const json = JSON.stringify(result.summary);
  writeFileSync('verify-summary.json', `${JSON.stringify(result.summary, null, 2)}\n`);
  // ジョブの要約に出す表（CI は、このファイルを GITHUB_STEP_SUMMARY へ足す）
  writeFileSync('verify-summary.md', renderStepSummary(result.summary));
  process.stdout.write(`${json}\n`);
  return result.exitCode;
}

main()
  .then((code) => {
    process.exit(code);
  })
  .catch((error: unknown) => {
    writeErr({
      event: 'verify_end',
      verdict: 'invalid',
      exitCode: 2,
      errorName: error instanceof Error ? error.name : 'unknown',
    });
    process.exit(2);
  });
