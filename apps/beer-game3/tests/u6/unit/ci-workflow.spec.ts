import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

// 機能: ワークフローの定義（.github/workflows/beer-game3.yml）を機械で確かめる（cicd-pipeline.md、security-design.md）

const raw = readFileSync(
  new URL('../../../../../.github/workflows/beer-game3.yml', import.meta.url),
  'utf8',
);

interface Step {
  name?: string;
  uses?: string;
  if?: string;
  run?: string;
  with?: Record<string, unknown>;
  env?: Record<string, string>;
}
interface Job {
  name?: string;
  needs?: string[] | string;
  if?: string;
  'runs-on'?: string;
  strategy?: { matrix?: { browser?: string[] }; 'fail-fast'?: boolean };
  services?: Record<string, { image?: string }>;
  steps?: Step[];
  permissions?: unknown;
  environment?: unknown;
  outputs?: Record<string, string>;
  'timeout-minutes'?: number;
}
interface Workflow {
  name: string;
  on: {
    pull_request?: { branches?: string[]; types?: string[] };
    push?: { branches?: string[] };
    schedule?: Array<{ cron: string }>;
    workflow_dispatch?: { inputs?: Record<string, { default?: string }> };
  };
  permissions?: Record<string, string>;
  concurrency?: { group: string; 'cancel-in-progress': boolean | string };
  defaults?: { run?: { 'working-directory'?: string } };
  jobs: Record<string, Job>;
}

const workflow = parse(raw) as Workflow;
const jobs = workflow.jobs;
const stepsOf = (job: string): Step[] => jobs[job]?.steps ?? [];
const uploads = (job: string): Step[] =>
  stepsOf(job).filter((s) => s.uses?.startsWith('actions/upload-artifact@'));

describe('シナリオ: 名前、起動、権限、シークレット', () => {
  it('ワークフローの名前とジョブの名前は固定（必須のチェックの設定に使う）', () => {
    expect(workflow.name).toBe('beer-game3');
    expect(Object.keys(jobs).sort()).toEqual(
      ['a11y', 'changes', 'e2e', 'gate', 'load-main', 'load-smoke', 'verify'].sort(),
    );
    expect(jobs.gate?.name).toBe('gate');
  });

  it('起動は pull_request（develop と main、edited を含む）、push、schedule、workflow_dispatch', () => {
    expect(workflow.on.pull_request?.branches).toEqual(['develop', 'main']);
    expect(workflow.on.pull_request?.types).toEqual(
      expect.arrayContaining(['opened', 'synchronize', 'reopened', 'edited']),
    );
    expect(workflow.on.push?.branches).toEqual(['develop', 'main']);
    expect(workflow.on.schedule?.length).toBeGreaterThan(0);
    expect(workflow.on.workflow_dispatch).toBeDefined();
  });

  it('最上位の permissions が contents: read だけで、ジョブごとの追加がない', () => {
    expect(workflow.permissions).toEqual({ contents: 'read' });
    for (const [name, job] of Object.entries(jobs)) {
      expect(job.permissions, name).toBeUndefined();
    }
  });

  it('secrets の参照、environment、id-token、書き込みの権限がない', () => {
    expect(raw).not.toMatch(/secrets\./);
    expect(raw).not.toMatch(/id-token/);
    expect(raw).not.toMatch(/contents:\s*write/);
    for (const [name, job] of Object.entries(jobs)) {
      expect(job.environment, name).toBeUndefined();
    }
  });

  it('実行機は ubuntu-24.04 に固定し、latest を使わない。作業ディレクトリは apps/beer-game3', () => {
    for (const [name, job] of Object.entries(jobs)) {
      expect(job['runs-on'], name).toBe('ubuntu-24.04');
    }
    expect(raw).not.toMatch(/-latest/);
    expect(workflow.defaults?.run?.['working-directory']).toBe('apps/beer-game3');
  });

  it('Node.js は 26、PostgreSQL のサービスコンテナは 18（版を固定）', () => {
    expect(raw).toMatch(/node-version:\s*['"]?26/);
    for (const name of ['verify', 'load-smoke', 'load-main']) {
      expect(jobs[name]?.services?.postgres?.image, name).toMatch(
        /^postgres:18(\.\d+)?(-alpine)?$/,
      );
    }
  });
});

describe('シナリオ: 外部の actions は完全なコミットの識別子で固定する', () => {
  const uses = Object.values(jobs).flatMap((job) =>
    (job.steps ?? []).map((s) => s.uses).filter((u): u is string => typeof u === 'string'),
  );

  it('使うすべての actions が 40 桁の識別子で固定されている', () => {
    expect(uses.length).toBeGreaterThan(0);
    for (const use of uses) {
      expect(use, use).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
    }
  });

  it('版が行のコメントに書かれている', () => {
    const lines = raw.split('\n').filter((l) => /uses:\s/.test(l));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line, line).toMatch(/#\s*v\d/);
    }
  });
});

describe('シナリオ: 成果物の保持と条件', () => {
  it('失敗時のトレースと画像は if: failure() で 7 日', () => {
    const traces = ['e2e', 'a11y'].flatMap((job) => uploads(job));
    expect(traces.length).toBe(2);
    for (const step of traces) {
      expect(step.if).toContain('failure()');
      expect(step.with?.['retention-days']).toBe(7);
    }
  });

  it('短い負荷試験の要約は 7 日、if: always()', () => {
    const [step] = uploads('load-smoke');
    expect(step?.with?.['retention-days']).toBe(7);
    expect(step?.if).toContain('always()');
  });

  it('本試験の要約は 30 日、if: always()（成功でも失敗でも保存）', () => {
    const [step] = uploads('load-main');
    expect(step?.with?.['retention-days']).toBe(30);
    expect(step?.if).toContain('always()');
  });

  it('負荷試験のジョブはジョブの要約（GITHUB_STEP_SUMMARY）にも出す', () => {
    expect(raw).toContain('GITHUB_STEP_SUMMARY');
  });
});

describe('シナリオ: 夜間と手動は develop を取得し、取り消さない', () => {
  it('schedule が ref: develop を明示して取得し、workflow_dispatch が branch の入力（既定 develop）を持つ', () => {
    expect(workflow.on.workflow_dispatch?.inputs?.ref?.default).toBe('develop');
    const checkouts = stepsOf('load-main').filter((s) => s.uses?.startsWith('actions/checkout@'));
    const ref = String(checkouts[0]?.with?.ref ?? '');
    expect(ref).toContain("github.event_name == 'schedule'");
    expect(ref).toContain('develop');
    expect(ref).toContain('inputs.ref');
  });

  it('並行実行の集合は起動の種類ごとに表のとおり（夜間と手動は実行ごとに一意で、取り消さない）', () => {
    const group = workflow.concurrency?.group ?? '';
    expect(group).toContain('beer-game3-pr-');
    expect(group).toContain('github.event.pull_request.number');
    expect(group).toContain('beer-game3-push-');
    expect(group).toContain('github.ref');
    expect(group).toContain('beer-game3-nightly-');
    expect(group).toContain('beer-game3-dispatch-');
    expect(group.match(/github\.run_id/g)?.length).toBeGreaterThanOrEqual(2);
    const cancel = String(workflow.concurrency?.['cancel-in-progress']);
    expect(cancel).toContain("github.event_name == 'pull_request'");
    expect(cancel).toContain("github.event_name == 'push'");
    expect(cancel).not.toContain('schedule');
    expect(cancel).not.toContain('workflow_dispatch');
  });
});

describe('シナリオ: 変更の検出と集約のジョブ', () => {
  it('changes は fetch-depth: 0 で取得し、relevant を出力する', () => {
    const checkout = stepsOf('changes').find((s) => s.uses?.startsWith('actions/checkout@'));
    expect(checkout?.with?.['fetch-depth']).toBe(0);
    expect(jobs.changes?.outputs?.relevant).toBeDefined();
    expect(stepsOf('changes').some((s) => s.run?.includes('verification/ci/changes.ts'))).toBe(
      true,
    );
  });

  it('検証のジョブは changes に依存し、relevant が true のときだけ動く', () => {
    for (const name of ['verify', 'e2e', 'a11y', 'load-smoke']) {
      expect(jobs[name]?.needs, name).toEqual(expect.arrayContaining(['changes']));
      expect(jobs[name]?.if, name).toContain("needs.changes.outputs.relevant == 'true'");
    }
  });

  it('load-main は main 宛ての PR、夜間、手動で動く', () => {
    const condition = jobs['load-main']?.if ?? '';
    expect(condition).toContain("github.event_name == 'schedule'");
    expect(condition).toContain("github.event_name == 'workflow_dispatch'");
    expect(condition).toContain("github.base_ref == 'main'");
  });

  it('gate は if: always() で、すべてに依存し、判定は gate.ts が行う', () => {
    const gate = jobs.gate;
    expect(gate?.if).toContain('always()');
    expect(gate?.needs).toEqual(
      expect.arrayContaining(['changes', 'verify', 'e2e', 'a11y', 'load-smoke', 'load-main']),
    );
    expect(gate?.steps?.some((s) => s.run?.includes('verification/ci/gate.ts'))).toBe(true);
  });

  it('e2e は 4 ブラウザの行列で、fail-fast: false。ジョブ名は e2e (<ブラウザ>)', () => {
    const e2e = jobs.e2e;
    expect(e2e?.strategy?.matrix?.browser).toEqual(['chromium', 'firefox', 'webkit', 'edge']);
    expect(e2e?.strategy?.['fail-fast']).toBe(false);
    expect(e2e?.name).toBe('e2e (${{ matrix.browser }})');
  });

  it('画面の配信が要るジョブ（e2e、a11y、load-main）は、動かす前に npm run build を済ませる', () => {
    for (const name of ['e2e', 'a11y', 'load-main']) {
      const runs = stepsOf(name).map((s) => s.run ?? '');
      const build = runs.findIndex((r) => r.includes('npm run build'));
      const execute = runs.findIndex((r) => /npm run (e2e|verify:load)/.test(r));
      expect(build, name).toBeGreaterThanOrEqual(0);
      expect(execute, name).toBeGreaterThan(build);
    }
  });

  it('verify は npm run verify の後に、本番の依存の検査を動かす', () => {
    const runs = stepsOf('verify').map((s) => s.run ?? '');
    const verify = runs.findIndex((r) => r.includes('npm run verify'));
    const prod = runs.findIndex((r) => r.includes('verify:prod-deps'));
    expect(verify).toBeGreaterThanOrEqual(0);
    expect(prod).toBeGreaterThan(verify);
  });

  it('再実行の仕組みを入れない（retries と再試行の action がない）', () => {
    // サービスコンテナの健全性の確認（--health-retries）は、試験の再実行ではないため対象から除く
    expect(raw.replaceAll('--health-retries', '')).not.toMatch(/retries/i);
    expect(raw).not.toMatch(/nick-fields\/retry|retry-on|rerun/i);
  });

  it('負荷試験は VERIFY_ALLOW_REMOTE を設定しない', () => {
    expect(raw).not.toContain('VERIFY_ALLOW_REMOTE');
  });
});
