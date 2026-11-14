import AxeBuilder from '@axe-core/playwright';
import { expect, test } from './support/test.js';
import { STATE_CASES } from './support/states.js';

// 機能: 全画面と主要な状態で、WCAG 2.2 AA の違反が 0 件（AC5.5.2、NFR8.2）。コントラスト 4.5:1 の検査を含む

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

for (const stateCase of STATE_CASES) {
  test(`axe-core: ${stateCase.screen} / ${stateCase.state}`, async ({ browser, baseURL }) => {
    const { page, context } = await stateCase.open(browser, baseURL ?? '');
    try {
      const results = await new AxeBuilder({ page }).withTags(TAGS).analyze();
      // 違反は、規則の識別子、影響、対象の要素の一覧で報告する（画面の内容は出さない）
      const report = results.violations.map((violation) => ({
        rule: violation.id,
        impact: violation.impact,
        targets: violation.nodes.map((node) => node.target.join(' ')).slice(0, 5),
      }));
      expect(report, JSON.stringify(report, null, 2)).toEqual([]);
    } finally {
      await context.close();
    }
  });
}

test('axe-core の規則に、コントラスト（color-contrast）が含まれる', async ({
  browser,
  baseURL,
}) => {
  const first = STATE_CASES[0];
  if (!first) {
    throw new Error('画面 × 状態の一覧が空です');
  }
  const { page, context } = await first.open(browser, baseURL ?? '');
  try {
    const results = await new AxeBuilder({ page }).withTags(TAGS).analyze();
    const checked = [...results.passes, ...results.incomplete, ...results.violations].map(
      (r) => r.id,
    );
    expect(checked).toContain('color-contrast');
  } finally {
    await context.close();
  }
});
