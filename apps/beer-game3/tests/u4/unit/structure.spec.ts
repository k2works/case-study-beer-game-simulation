import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';
import { ACTIONS } from '../../../src/server/access/access-control.js';
import { findUncatalogedRoutes, routeCatalog } from '../../../src/server/http/routes.js';
import { buildU4App } from '../support/harness.js';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const httpDir = path.join(appRoot, 'src/server/http');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? sourceFiles(full) : full.endsWith('.ts') ? [full] : [];
  });
}

/** import 文と動的 import から、読み込み先を取り出す。 */
export function importsOf(source: string): string[] {
  const found: string[] = [];
  const pattern = /(?:from\s+|import\s*\(\s*|import\s+)['"]([^'"]+)['"]/g;
  for (const match of source.matchAll(pattern)) {
    found.push(match[1]!);
  }
  return found;
}

const importsGameSession = (specifier: string): boolean =>
  /(^|\/)game-session(\.js)?$/.test(specifier);

describe('BR19.2 入口は GameSession を直接 import しない', () => {
  it('src/server/http のどのモジュールも GameSession を import していない', () => {
    const offenders = sourceFiles(httpDir).filter((file) =>
      importsOf(readFileSync(file, 'utf8')).some(importsGameSession),
    );
    expect(offenders).toEqual([]);
  });

  it('走査が違反を見つける（静的な import と動的な import の両方）', () => {
    expect(importsOf("import { GameSession } from '../session/game-session.js';")).toEqual([
      '../session/game-session.js',
    ]);
    expect(
      importsOf("const m = await import('../session/game-session');").some(importsGameSession),
    ).toBe(true);
    expect(
      importsOf("import type { Store } from '../session/store.js';").some(importsGameSession),
    ).toBe(false);
  });

  it('lint が、入口から GameSession を import したコードを失敗させる', async () => {
    const eslint = new ESLint({ cwd: appRoot });
    const [bad] = await eslint.lintText(
      "import { GameSession } from '../session/game-session.js';\nexport const x = GameSession;\n",
      { filePath: path.join(httpDir, 'violating-sample.ts') },
    );
    expect(bad?.messages.some((m) => m.ruleId === 'no-restricted-imports')).toBe(true);

    const [ok] = await eslint.lintText(
      "import type { Store } from '../session/store.js';\nexport type S = Store;\n",
      { filePath: path.join(httpDir, 'ok-sample.ts') },
    );
    expect(ok?.messages.some((m) => m.ruleId === 'no-restricted-imports')).toBe(false);
  });
});

describe('BR19.3 経路の表（routeCatalog）と登録の差', () => {
  it('表のすべての行が、既知の操作か public を持つ', () => {
    for (const row of routeCatalog) {
      expect([...ACTIONS, 'public']).toContain(row.action);
    }
  });

  it('登録された API の経路は、表と完全に一致する', async () => {
    const { app } = await buildU4App();
    const registered = app.registeredRoutes();
    const key = (r: { method: string; url: string }) => `${r.method} ${r.url}`;
    expect(registered.map(key).sort()).toEqual(routeCatalog.map(key).sort());
    expect(findUncatalogedRoutes(registered, routeCatalog)).toEqual([]);
  });

  it('表に無い経路が登録されたら、差として見つかる', () => {
    const extra = { method: 'GET', url: '/api/secret' };
    expect(
      findUncatalogedRoutes(
        [...routeCatalog.map((r) => ({ method: r.method, url: r.url })), extra],
        routeCatalog,
      ),
    ).toEqual([extra]);
  });

  it('画面の配信以外の経路を、表の外から登録しようとすると起動が失敗する', async () => {
    const { app } = await buildU4App();
    expect(() => app.get('/api/sneaky', async () => ({ ok: true }))).toThrow(
      '経路の表に無い経路です',
    );
  });
});
