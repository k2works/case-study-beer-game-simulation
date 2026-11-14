import { findEnglishSentences } from '../shared/language.js';
import { expect, test } from './support/test.js';
import { STATE_CASES } from './support/states.js';

// 機能: 画面の文言は日本語のみで、英語の文が混じらない（AC5.7.2、NFR11.1）。出力の導線の説明は常に表示される（NFR11.2）
// 識別子（列名、役割の値、コード）と金額の記号は対象から除く（findEnglishSentences の規則）

for (const stateCase of STATE_CASES) {
  test(`表示された文言に英語の文が混じらない: ${stateCase.screen} / ${stateCase.state}`, async ({
    browser,
    baseURL,
  }) => {
    const { page, context } = await stateCase.open(browser, baseURL ?? '');
    try {
      const text = await page.locator('body').innerText();
      expect(findEnglishSentences(text)).toEqual([]);
      await expect(page.locator('html')).toHaveAttribute('lang', 'ja');
    } finally {
      await context.close();
    }
  });
}

test('出力の導線（終了後の進行管理）に、日本語の説明と列名の意味が常に表示される', async ({
  browser,
  baseURL,
}) => {
  const stateCase = STATE_CASES.find((c) => c.id === 'facilitator-ended-export');
  if (!stateCase) {
    throw new Error('出力の状態がありません');
  }
  const { page, context } = await stateCase.open(browser, baseURL ?? '');
  try {
    const notice = page.getByTestId('export-notice');
    await expect(notice).toBeVisible();
    await expect(notice).toContainText('表計算ソフト');
    await expect(page.getByTestId('export-columns')).toBeVisible();
    await expect(page.getByTestId('export-roles')).toBeVisible();
    // 折りたたまれていない（説明は閉じたり隠したりできない）
    await expect(page.getByTestId('export-panel').locator('details')).toHaveCount(0);
  } finally {
    await context.close();
  }
});
