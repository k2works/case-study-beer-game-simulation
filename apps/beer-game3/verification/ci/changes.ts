/**
 * 変更の検出（ジョブ changes。cicd-pipeline.md「変更の検出」）。
 * beer-game3 に関係する変更があるか（relevant）を、起動の種類ごとの基準で決める。
 * 基準が取れない、または検出の手順が失敗した場合は、真に倒す（検証を飛ばす方向には倒さない）。
 *
 * このファイルは、Node.js が型を取り除いて直接実行する（依存なし。相対の import を持たない）。
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** 対象のパス: アプリケーション、このワークフロー、運用の文書のうち名前に beer-game3 を含むもの。 */
export const RELEVANT_PATH_PATTERNS: readonly RegExp[] = [
  /^apps\/beer-game3\//,
  /^\.github\/workflows\/beer-game3\.yml$/,
  /^docs\/operation\/(?:[^/]*\/)*[^/]*beer-game3[^/]*(?:\/.*)?$/,
];

export function isRelevantPath(path: string): boolean {
  return RELEVANT_PATH_PATTERNS.some((pattern) => pattern.test(path));
}

/** git の引数を受け取り、標準出力を返す。失敗したら例外。試験では差し替える。 */
export type GitRunner = (args: string[]) => string;

export interface RelevanceInput {
  event: string;
  /** pull_request の対象の branch */
  baseRef?: string | undefined;
  /** push の直前のコミット（github.event.before） */
  before?: string | undefined;
}

const ALL_ZERO = /^0+$/;

function changedFiles(output: string): string[] {
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

export function resolveRelevance(input: RelevanceInput, git: GitRunner): boolean {
  switch (input.event) {
    case 'schedule':
    case 'workflow_dispatch':
      // 夜間と手動は、比較せず常に真
      return true;
    case 'pull_request': {
      if (!input.baseRef) {
        return true;
      }
      try {
        return changedFiles(git(['diff', '--name-only', `origin/${input.baseRef}...HEAD`])).some(
          isRelevantPath,
        );
      } catch {
        return true;
      }
    }
    case 'push': {
      const before = input.before ?? '';
      // 新しい branch（全ゼロ）は比較しない
      if (before === '' || ALL_ZERO.test(before)) {
        return true;
      }
      try {
        // 履歴にない（force push）ときは、ここで失敗して真に倒す
        git(['cat-file', '-e', `${before}^{commit}`]);
        return changedFiles(git(['diff', '--name-only', `${before}..HEAD`])).some(isRelevantPath);
      } catch {
        return true;
      }
    }
    default:
      return true;
  }
}

function runGit(args: string[]): string {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** ワークフローから呼ぶ入口。relevant を GITHUB_OUTPUT と標準出力に出す。 */
export function runCli(env: Record<string, string | undefined>): number {
  let relevant: boolean;
  try {
    relevant = resolveRelevance(
      {
        event: env.GATE_EVENT ?? '',
        baseRef: env.GATE_BASE_REF,
        before: env.GATE_BEFORE,
      },
      runGit,
    );
  } catch {
    relevant = true;
  }
  const line = `relevant=${relevant ? 'true' : 'false'}`;
  process.stdout.write(`${line}\n`);
  if (env.GITHUB_OUTPUT) {
    appendFileSync(env.GITHUB_OUTPUT, `${line}\n`);
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(runCli(process.env));
}
