import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';
import { ACTIONS } from '../../../src/server/access/access-control.js';
import { routeCatalog } from '../../../src/server/http/routes.js';

/** import 文と動的 import から、読み込み先を取り出す。 */
function importsOf(source: string): string[] {
  const pattern = /(?:from\s+|import\s*\(\s*|import\s+)['"]([^'"]+)['"]/g;
  return [...source.matchAll(pattern)].map((match) => match[1]!);
}

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const serverDir = path.join(appRoot, 'src/server');
const httpDir = path.join(serverDir, 'http');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? sourceFiles(full) : full.endsWith('.ts') ? [full] : [];
  });
}

const importsReporting = (specifier: string): boolean => /(^|\/)reporting(\/|$)/.test(specifier);
const importsRetention = (specifier: string): boolean => /(^|\/)retention(\/|$)/.test(specifier);

describe('NFR6.5 入口は Reporting と Retention を直接 import しない', () => {
  it('src/server/http のどのモジュールも、reporting と retention を import していない', () => {
    const offenders = sourceFiles(httpDir).filter((file) =>
      importsOf(readFileSync(file, 'utf8')).some((s) => importsReporting(s) || importsRetention(s)),
    );
    expect(offenders).toEqual([]);
  });

  it('retention を import してよいのは、起動を組み立てる main.ts と設定の config.ts だけ', () => {
    const importers = sourceFiles(serverDir)
      .filter((file) => !file.startsWith(path.join(serverDir, 'retention')))
      .filter((file) => importsOf(readFileSync(file, 'utf8')).some(importsRetention))
      .map((file) => path.relative(serverDir, file))
      .sort();
    expect(importers).toEqual(['config.ts', 'main.ts']);
  });

  it('reporting を import してよいのは、権限の判定のあとに呼ぶ access/session-gateway.ts だけ', () => {
    const importers = sourceFiles(serverDir)
      .filter((file) => !file.startsWith(path.join(serverDir, 'reporting')))
      .filter((file) => importsOf(readFileSync(file, 'utf8')).some(importsReporting))
      .map((file) => path.relative(serverDir, file))
      .sort();
    expect(importers).toEqual(['access/session-gateway.ts']);
  });

  it('lint が、入口から reporting や retention を import したコードを失敗させる', async () => {
    const eslint = new ESLint({ cwd: appRoot });
    for (const source of [
      "import { buildResultsView } from '../reporting/results.js';\nexport const x = buildResultsView;\n",
      "import { RetentionJob } from '../retention/job.js';\nexport const x = RetentionJob;\n",
    ]) {
      const [bad] = await eslint.lintText(source, {
        filePath: path.join(httpDir, 'violating-sample.ts'),
      });
      expect(bad?.messages.some((m) => m.ruleId === 'no-restricted-imports')).toBe(true);
    }
  });

  it('定期処理の入口（HTTP の経路）を作らない', () => {
    for (const row of routeCatalog) {
      expect(row.url).not.toMatch(/retention|auto-?end|purge|cleanup|job/i);
    }
  });
});

describe('経路の表（routeCatalog）に結果と出力の 2 行がある', () => {
  it('viewResults と exportGame は GET で、操作の一覧に載っている', () => {
    const rows = routeCatalog.filter((row) => row.id === 'viewResults' || row.id === 'exportGame');
    expect(rows.map((row) => `${row.method} ${row.url} ${row.action}`).sort()).toEqual([
      'GET /api/games/:gameId/export exportGame',
      'GET /api/games/:gameId/results viewResults',
    ]);
    expect(ACTIONS).toContain('viewResults');
    expect(ACTIONS).toContain('exportGame');
  });
});

describe('NFR7.2 games を参照するすべての外部キーは、削除の連鎖で消える', () => {
  const migrations = readdirSync(path.join(appRoot, 'migrations'))
    .filter((name) => name.endsWith('.sql'))
    .map((name) => ({ name, sql: readFileSync(path.join(appRoot, 'migrations', name), 'utf8') }));

  it('games(game_id) を参照する列は、すべて on delete cascade を持つ', () => {
    let found = 0;
    for (const { name, sql } of migrations) {
      for (const match of sql.matchAll(/references\s+games\s*\(\s*game_id\s*\)([^,\n]*)/gi)) {
        found += 1;
        expect(match[1], `${name}: ${match[0]}`).toMatch(/on delete cascade/i);
      }
    }
    // game_settings、participants、role_assignments、week_records、pipeline_slots、access_codes、
    // idempotency_records（U1）と operation_log_entries（U3）。表が増えたら、この数も増える
    expect(found).toBeGreaterThanOrEqual(8);
  });

  it('連鎖のない参照は、同じ文で消える参加者への week_records.decided_by_participant_id だけ', () => {
    const uncascaded: string[] = [];
    for (const { name, sql } of migrations) {
      for (const match of sql.matchAll(/references\s+(\w+)\s*\(\s*\w+\s*\)([^,\n;]*)/gi)) {
        if (!/on delete cascade/i.test(match[2]!)) {
          uncascaded.push(`${name}->${match[1]}`);
        }
      }
    }
    expect(uncascaded).toEqual(['1763000000000_u3-facilitation.sql->participants']);
  });
});
