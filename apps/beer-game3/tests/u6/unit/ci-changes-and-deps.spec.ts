import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  RELEVANT_PATH_PATTERNS,
  isRelevantPath,
  resolveRelevance,
  type GitRunner,
} from '../../../verification/ci/changes.js';
import { findForbiddenDeps, type NpmTree } from '../../../verification/ci/prod-deps.js';

// 機能: 変更の検出（relevant）と、本番の依存の検査（NFR6.4）

describe('シナリオ: 対象のパス', () => {
  it.each([
    'apps/beer-game3/src/server/main.ts',
    'apps/beer-game3/verification/ci/gate.ts',
    '.github/workflows/beer-game3.yml',
    'docs/operation/beer-game3/release-checklist.md',
    'docs/operation/beer-game3-release.md',
  ])('%s は対象', (path) => {
    expect(isRelevantPath(path)).toBe(true);
  });

  it.each([
    'apps/beer-game2/src/main.ts',
    '.github/workflows/beer-game2.yml',
    'docs/operation/beer-game2/index.md',
    'README.md',
    'apps/beer-game3-other/x.ts',
  ])('%s は対象外', (path) => {
    expect(isRelevantPath(path)).toBe(false);
  });

  it('対象のパスの一覧は 3 種類（アプリ、ワークフロー、運用の文書）', () => {
    expect(RELEVANT_PATH_PATTERNS).toHaveLength(3);
  });
});

function runner(table: Record<string, string | Error>): { run: GitRunner; calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    run: (args) => {
      calls.push(args);
      const hit = table[args.join(' ')];
      if (hit === undefined) {
        throw new Error(`想定外の git: ${args.join(' ')}`);
      }
      if (hit instanceof Error) {
        throw hit;
      }
      return hit;
    },
  };
}

describe('シナリオ: 起動の種類ごとの基準', () => {
  it('Given 夜間と手動 When 判定する Then 比較せず常に真', () => {
    for (const event of ['schedule', 'workflow_dispatch'] as const) {
      const git = runner({});
      expect(resolveRelevance({ event }, git.run)).toBe(true);
      expect(git.calls).toEqual([]);
    }
  });

  it('Given PR で対象のパスに差分あり When 判定する Then 真。基準は origin/<基準の branch>...HEAD', () => {
    const git = runner({
      'diff --name-only origin/develop...HEAD': 'README.md\napps/beer-game3/src/web/App.tsx\n',
    });
    expect(resolveRelevance({ event: 'pull_request', baseRef: 'develop' }, git.run)).toBe(true);
    expect(git.calls[0]).toEqual(['diff', '--name-only', 'origin/develop...HEAD']);
  });

  it('Given PR で対象外の差分だけ When 判定する Then 偽', () => {
    const git = runner({
      'diff --name-only origin/main...HEAD': 'README.md\napps/beer-game2/x.ts\n',
    });
    expect(resolveRelevance({ event: 'pull_request', baseRef: 'main' }, git.run)).toBe(false);
  });

  it('Given PR で差分が空 When 判定する Then 偽（対象の変更がない）', () => {
    const git = runner({ 'diff --name-only origin/develop...HEAD': '\n' });
    expect(resolveRelevance({ event: 'pull_request', baseRef: 'develop' }, git.run)).toBe(false);
  });

  it('Given PR で基準が取れない（git の失敗、基準の branch の指定なし）When 判定する Then 真に倒す', () => {
    const failing = runner({ 'diff --name-only origin/develop...HEAD': new Error('bad') });
    expect(resolveRelevance({ event: 'pull_request', baseRef: 'develop' }, failing.run)).toBe(true);
    const noBase = runner({});
    expect(resolveRelevance({ event: 'pull_request' }, noBase.run)).toBe(true);
  });

  it('Given push で before から HEAD の差分 When 判定する Then 差分で決める', () => {
    const before = 'a'.repeat(40);
    const git = runner({
      [`cat-file -e ${before}^{commit}`]: '',
      [`diff --name-only ${before}..HEAD`]: 'apps/beer-game3/package.json\n',
    });
    expect(resolveRelevance({ event: 'push', before }, git.run)).toBe(true);
    const git2 = runner({
      [`cat-file -e ${before}^{commit}`]: '',
      [`diff --name-only ${before}..HEAD`]: 'docs/index.md\n',
    });
    expect(resolveRelevance({ event: 'push', before }, git2.run)).toBe(false);
  });

  it('Given push で before が全ゼロ（新しい branch）When 判定する Then 比較せず真', () => {
    const git = runner({});
    expect(resolveRelevance({ event: 'push', before: '0'.repeat(40) }, git.run)).toBe(true);
    expect(git.calls).toEqual([]);
  });

  it('Given push で before が履歴にない（force push）When 判定する Then 真', () => {
    const before = 'b'.repeat(40);
    const git = runner({ [`cat-file -e ${before}^{commit}`]: new Error('missing') });
    expect(resolveRelevance({ event: 'push', before }, git.run)).toBe(true);
  });

  it('Given 知らない起動の種類 When 判定する Then 真に倒す', () => {
    expect(resolveRelevance({ event: 'release' }, runner({}).run)).toBe(true);
  });
});

describe('シナリオ: 本番の依存の検査', () => {
  it('Given 検証の依存を含む木 When 調べる Then 見つかった名前を階層つきで返す', () => {
    const tree: NpmTree = {
      dependencies: {
        fastify: { dependencies: { pino: {} } },
        '@playwright/test': {},
        deep: { dependencies: { 'axe-core': {}, '@axe-core/playwright': {} } },
      },
    };
    expect(findForbiddenDeps(tree).sort()).toEqual(
      ['@axe-core/playwright', '@playwright/test', 'axe-core'].sort(),
    );
  });

  it('Given playwright と playwright-core When 調べる Then 見つかる', () => {
    expect(
      findForbiddenDeps({ dependencies: { playwright: {}, 'playwright-core': {} } }).sort(),
    ).toEqual(['playwright', 'playwright-core']);
  });

  it('Given 検証の依存を含まない木 When 調べる Then 空', () => {
    expect(findForbiddenDeps({ dependencies: { fastify: {}, pg: {} } })).toEqual([]);
    expect(findForbiddenDeps({})).toEqual([]);
  });
});

describe('シナリオ: 依存の置き場（devDependencies だけ、版は固定）', () => {
  const pkg = JSON.parse(
    readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'),
  ) as {
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
  };
  const verificationDeps = ['@playwright/test', 'axe-core', '@axe-core/playwright'];

  it.each(verificationDeps)('%s は devDependencies にだけある', (name) => {
    expect(pkg.devDependencies[name]).toBeDefined();
    expect(pkg.dependencies[name]).toBeUndefined();
  });

  it.each(verificationDeps)('%s の版は範囲指定でなく固定', (name) => {
    expect(pkg.devDependencies[name]).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('playwright 系と axe 系が dependencies に 1 つもない', () => {
    expect(Object.keys(pkg.dependencies).filter((n) => /playwright|axe-core/.test(n))).toEqual([]);
  });
});
