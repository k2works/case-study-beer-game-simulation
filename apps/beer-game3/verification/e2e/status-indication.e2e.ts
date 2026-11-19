import { expect, test } from './support/test.js';
import { STATE_CASES } from './support/states.js';

// 機能: 状態の表示は、色だけに頼らず、文字またはアクセシブルな名前でも示す（NFR8.4）
// axe-core は色だけに頼った表示を一般には検出しないため、状態を示す要素ごとに確かめる

for (const stateCase of STATE_CASES) {
  test(`状態を示す要素の文字または名前が空でない: ${stateCase.screen} / ${stateCase.state}`, async ({
    browser,
    baseURL,
  }) => {
    const { page, context } = await stateCase.open(browser, baseURL ?? '');
    try {
      const indicators = stateCase.indicators(page);
      expect(indicators.length).toBeGreaterThan(0);
      for (const indicator of indicators) {
        const count = await indicator.locator.count();
        expect(count, `${indicator.name} が表示されている`).toBeGreaterThan(0);
        for (let index = 0; index < count; index += 1) {
          const element = indicator.locator.nth(index);
          const text = ((await element.textContent()) ?? '').trim();
          if (text === '') {
            // 文字がない要素は、支援技術に伝わる名前を持つ
            await expect(element, `${indicator.name} のアクセシブルな名前`).toHaveAccessibleName(
              /.+/,
            );
          }
        }
      }
    } finally {
      await context.close();
    }
  });
}

test('結果の指標と費用の切り替えは、選択中が状態の属性（checked）で伝わる', async ({
  browser,
  baseURL,
}) => {
  const stateCase = STATE_CASES.find((c) => c.id === 'results-metric-selected');
  if (!stateCase) {
    throw new Error('結果の状態がありません');
  }
  const { page, context } = await stateCase.open(browser, baseURL ?? '');
  try {
    await expect(page.getByTestId('metric-inventory')).toBeChecked();
    await expect(page.getByTestId('metric-cost')).not.toBeChecked();
    const groups = page.getByRole('radiogroup');
    expect(await groups.count()).toBeGreaterThanOrEqual(1);
    for (let index = 0; index < (await groups.count()); index += 1) {
      await expect(groups.nth(index)).toHaveAccessibleName(/.+/);
      await expect(groups.nth(index).getByRole('radio', { checked: true })).toHaveCount(1);
    }
  } finally {
    await context.close();
  }
});
