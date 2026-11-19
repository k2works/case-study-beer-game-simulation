import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';
import { buildPlaywrightConfig } from '../../../verification/e2e/playwright.config.js';

// 機能: リリース前の確認票の存在と、画面の試験の規約（NFR9.4、NFR2.3、NFR6.1）

const appRoot = fileURLToPath(new URL('../../../', import.meta.url));
const repoRoot = fileURLToPath(new URL('../../../../../', import.meta.url));
const checklistPath = `${repoRoot}docs/operation/beer-game3/release-checklist.md`;

describe('シナリオ: リリース前の確認票', () => {
  it('Given リポジトリ When 確認票を探す Then docs/operation 配下に beer-game3 を含む文書として存在する', () => {
    expect(existsSync(checklistPath)).toBe(true);
  });

  const text = existsSync(checklistPath) ? readFileSync(checklistPath, 'utf8') : '';

  it('必須の列の見出し（確認した日、確認した人、ブラウザ、版、合否、所見）を持つ', () => {
    const header =
      text.split('\n').find((l) => l.startsWith('|') && l.includes('確認した日')) ?? '';
    for (const column of ['確認した日', '確認した人', 'ブラウザ', '版', '合否', '所見']) {
      expect(header, column).toContain(column);
    }
  });

  it('主要な操作 6 項目と、1 つ前の世代の 4 ブラウザ、実機の Safari を対象にしている', () => {
    for (const item of ['ゲームの作成', '参加', '役割の割当て', '開始', '入力', '週の確定']) {
      expect(text, item).toContain(item);
    }
    for (const browser of ['Chromium', 'Firefox', 'WebKit', 'Edge', 'Safari']) {
      expect(text, browser).toContain(browser);
    }
    expect(text).toContain('1 つ前の世代');
  });

  it('必須のチェック gate の設定の手順と戻し方の文書が、同じ系列にある', () => {
    const dir = `${repoRoot}docs/operation/beer-game3`;
    const files = existsSync(dir) ? readdirSync(dir) : [];
    const doc = files.find((f) => f.includes('required-check'));
    expect(doc).toBeDefined();
    const body = readFileSync(`${dir}/${doc}`, 'utf8');
    expect(body).toContain('gate');
    expect(body).toContain('戻し方');
  });
});

describe('シナリオ: 画面の試験の規約', () => {
  it('Given Playwright の設定 When 読む Then retries は 0', () => {
    expect(buildPlaywrightConfig({}).retries).toBe(0);
  });

  it('Given 4 ブラウザ When 設定を読む Then Chromium、Firefox、WebKit、Edge（msedge）のプロジェクトがある', () => {
    const projects = buildPlaywrightConfig({}).projects ?? [];
    expect(projects.map((p) => p.name)).toEqual(['chromium', 'firefox', 'webkit', 'edge']);
    expect(projects.find((p) => p.name === 'edge')?.use?.channel).toBe('msedge');
  });

  it('Given localhost の実行 When 設定を読む Then 失敗時のみトレースと画像を取る', () => {
    const use = buildPlaywrightConfig({}).use;
    expect(use?.trace).toBe('retain-on-failure');
    expect(use?.screenshot).toBe('only-on-failure');
  });

  it('Given 外部の接続先を許可して指す When 設定を読む Then トレースと画像を取らない', () => {
    const use = buildPlaywrightConfig({
      VERIFY_TARGET_URL: 'https://staging.example.com',
      VERIFY_ALLOW_REMOTE: '1',
    }).use;
    expect(use?.trace).toBe('off');
    expect(use?.screenshot).toBe('off');
    expect(use?.video).toBe('off');
  });

  it('Given 外部の接続先を許可なしで指す When 設定を読む Then 拒否して例外', () => {
    expect(() =>
      buildPlaywrightConfig({ VERIFY_TARGET_URL: 'https://staging.example.com' }),
    ).toThrow();
  });

  it('Given page.waitForTimeout を使うコード When ESLint にかける Then no-restricted-properties で落ちる', async () => {
    const eslint = new ESLint({ cwd: appRoot });
    const [result] = await eslint.lintText(
      "import type { Page } from '@playwright/test';\nexport async function wait(page: Page): Promise<void> {\n  await page.waitForTimeout(100);\n}\n",
      { filePath: `${appRoot}verification/e2e/wait.e2e.ts` },
    );
    expect(result?.messages.map((m) => m.ruleId)).toContain('no-restricted-properties');
  });

  it('Given 固定の setTimeout の待ち When ESLint にかける Then 落ちる', async () => {
    const eslint = new ESLint({ cwd: appRoot });
    const [result] = await eslint.lintText(
      'export const wait = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 100));\n',
      { filePath: `${appRoot}verification/e2e/sleep.e2e.ts` },
    );
    expect(result?.messages.map((m) => m.ruleId)).toContain('no-restricted-globals');
  });

  it('画面の試験のファイル名は *.e2e.ts で、Vitest の対象（*.spec.ts）に入らない', () => {
    const dir = `${appRoot}verification/e2e`;
    const specs = readdirSync(dir).filter((f) => f.endsWith('.e2e.ts'));
    expect(specs.sort()).toEqual(
      [
        'a11y.e2e.ts',
        'japanese.e2e.ts',
        'keyboard-flow.e2e.ts',
        'main-operations.e2e.ts',
        'status-indication.e2e.ts',
      ].sort(),
    );
    expect(readdirSync(dir).filter((f) => /\.spec\.tsx?$/.test(f))).toEqual([]);
  });

  it('画面の試験のどのファイルにも waitForTimeout を使っていない', () => {
    const dir = `${appRoot}verification/e2e`;
    for (const file of readdirSync(dir, { recursive: true, encoding: 'utf8' })) {
      if (file.endsWith('.ts')) {
        expect(readFileSync(`${dir}/${file}`, 'utf8'), file).not.toContain('waitForTimeout');
      }
    }
  });
});
