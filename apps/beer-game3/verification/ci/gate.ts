/**
 * 集約のジョブ gate の判定（必須のチェックの唯一の名前。cicd-pipeline.md「集約のジョブ gate」）。
 * ジョブの結果、relevant、起動の種類、対象の branch から、成功か失敗かを返す純粋な関数と、環境変数から呼ぶ入口。
 *
 * このファイルは、Node.js が型を取り除いて直接実行する（依存なし。相対の import を持たない）。
 */
import { pathToFileURL } from 'node:url';

export type JobResult = 'success' | 'failure' | 'cancelled' | 'skipped';
export type GateEvent = 'pull_request' | 'push' | 'schedule' | 'workflow_dispatch';

export interface GateResults {
  changes: JobResult;
  verify: JobResult;
  e2e: JobResult;
  a11y: JobResult;
  loadSmoke: JobResult;
  loadMain: JobResult;
}

export interface GateInput {
  event: GateEvent;
  /** changes ジョブの出力。'false' 以外のすべての値（空、不明、未設定を含む）は、検証を要求する側に倒す */
  relevant: string | undefined;
  /** pull_request の対象の branch（github.base_ref）。それ以外では空 */
  baseRef: string;
  results: GateResults;
}

export interface GateDecision {
  ok: boolean;
  reason: string;
}

const pass = (reason: string): GateDecision => ({ ok: true, reason });
const fail = (reason: string): GateDecision => ({ ok: false, reason });

const JOB_NAMES: Record<keyof GateResults, string> = {
  changes: 'changes',
  verify: 'verify',
  e2e: 'e2e',
  a11y: 'a11y',
  loadSmoke: 'load-smoke',
  loadMain: 'load-main',
};

const VERIFICATION_JOBS = ['verify', 'e2e', 'a11y', 'loadSmoke'] as const;

export function decideGate(input: GateInput): GateDecision {
  const { event, results, baseRef } = input;

  // (1) changes が success でなければ失敗（失敗、取り消し、飛ばしのいずれも）
  if (results.changes !== 'success') {
    return fail(`${JOB_NAMES.changes} が success ではありません（${results.changes}）`);
  }

  // 夜間と手動: load-main を必須にし、ほかの 4 ジョブは飛ばされていてよい（走った結果は失敗を許さない）
  if (event === 'schedule' || event === 'workflow_dispatch') {
    if (results.loadMain !== 'success') {
      return fail(`${JOB_NAMES.loadMain} が success ではありません（${results.loadMain}）`);
    }
    for (const job of VERIFICATION_JOBS) {
      if (results[job] !== 'success' && results[job] !== 'skipped') {
        return fail(`${JOB_NAMES[job]} が失敗または取り消しです（${results[job]}）`);
      }
    }
    return pass(`${event}: load-main が success`);
  }

  if (event === 'pull_request' || event === 'push') {
    // (2) relevant が 'false' のときだけ、関係のない変更として、changes 以外がすべて skipped であることを確かめる
    if (input.relevant === 'false') {
      for (const job of [...VERIFICATION_JOBS, 'loadMain'] as const) {
        if (results[job] !== 'skipped') {
          return fail(
            `relevant が false なのに ${JOB_NAMES[job]} が skipped ではありません（${results[job]}）`,
          );
        }
      }
      return pass('beer-game3 に関係のない変更（検証は飛ばされた）');
    }

    // (3) それ以外（true、空、不明、未設定）は、検証を要求する
    for (const job of VERIFICATION_JOBS) {
      if (results[job] !== 'success') {
        return fail(`${JOB_NAMES[job]} が success ではありません（${results[job]}）`);
      }
    }
    const loadMainRequired = event === 'pull_request' && baseRef === 'main';
    if (loadMainRequired) {
      if (results.loadMain !== 'success') {
        return fail(`main 宛ての PR は ${JOB_NAMES.loadMain} が必須です（${results.loadMain}）`);
      }
    } else if (results.loadMain !== 'success' && results.loadMain !== 'skipped') {
      return fail(`${JOB_NAMES.loadMain} が失敗または取り消しです（${results.loadMain}）`);
    }
    return pass('検証がすべて成功');
  }

  return fail(`知らない起動の種類です（${String(event)}）`);
}

const RESULT_VALUES: readonly string[] = ['success', 'failure', 'cancelled', 'skipped'];

function resultOf(value: string | undefined): JobResult {
  // 読めない値は、失敗として扱う（黙って通さない）
  return RESULT_VALUES.includes(value ?? '') ? (value as JobResult) : 'failure';
}

/** ワークフローから呼ぶ入口。環境変数から入力を組み立て、判定を出力して、失敗なら終了コード 1 で終わる。 */
export function runCli(env: Record<string, string | undefined>): number {
  const decision = decideGate({
    event: env.GATE_EVENT as GateEvent,
    relevant: env.GATE_RELEVANT,
    baseRef: env.GATE_BASE_REF ?? '',
    results: {
      changes: resultOf(env.GATE_CHANGES),
      verify: resultOf(env.GATE_VERIFY),
      e2e: resultOf(env.GATE_E2E),
      a11y: resultOf(env.GATE_A11Y),
      loadSmoke: resultOf(env.GATE_LOAD_SMOKE),
      loadMain: resultOf(env.GATE_LOAD_MAIN),
    },
  });
  process.stdout.write(`${decision.ok ? 'gate: 成功' : 'gate: 失敗'}。${decision.reason}\n`);
  return decision.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(runCli(process.env));
}
