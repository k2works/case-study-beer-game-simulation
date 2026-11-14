import { expect, test } from './support/test.js';

// 機能: 4 つのブラウザで、ゲームの作成から週の確定までの主要な操作を完了できる（AC5.7.1、NFR10.1）

test('Given 最新の安定版のブラウザ When 作成、参加、割当て、開始、入力、週の確定を行う Then 完了し、新しい週が全画面に出る', async ({
  browser,
  baseURL,
}) => {
  const open = async () => (await browser.newContext({ baseURL: baseURL ?? '' })).newPage();

  const facilitator = await open();
  await facilitator.goto('/');
  await facilitator.getByTestId('go-create').click();
  await facilitator.getByLabel('ゲーム名').fill('主要な操作の試験');
  await facilitator.getByLabel('週数').fill('3');
  await facilitator.getByTestId('create-submit').click();
  await expect(facilitator.getByRole('heading', { name: 'ゲームを作成しました' })).toBeVisible();
  const joinCode = (await facilitator.locator('dl.codes code').nth(0).textContent()) ?? '';
  await facilitator.getByTestId('enter-lobby').click();

  const labels = ['工場', '一次卸', '二次卸', '小売店'];
  const players = [];
  for (const [index, label] of labels.entries()) {
    const page = await open();
    await page.goto('/');
    await page.getByLabel('参加コード').fill(joinCode);
    await page.getByLabel('表示名').fill(`主要な操作 ${label} ${index + 1}`);
    await page.getByTestId('join-submit').click();
    await expect(page.getByRole('heading', { name: 'ロビー' })).toBeVisible();
    players.push(page);
  }
  await expect(facilitator.getByRole('heading', { name: '参加者（4 人）' })).toBeVisible();

  for (const [index, label] of labels.entries()) {
    await facilitator.getByRole('combobox').nth(index).selectOption({ label });
  }
  await facilitator.getByTestId('start-game').click();
  await expect(facilitator.getByRole('heading', { name: '進行管理' })).toBeVisible();

  for (const page of players) {
    await expect(page.getByText('第 1 週 / 3')).toBeVisible();
    await page.getByTestId('decision-input').fill('5');
    await page.getByTestId('decision-submit').click();
    await expect(page.getByText('入力: 保存済み')).toBeVisible();
  }
  await expect(facilitator.getByText('4 / 4 役割が入力済み')).toBeVisible();
  await facilitator.getByTestId('confirm-week').click();
  await facilitator.getByTestId('confirm-week-yes').click();

  // 週の確定が、確定を要求した進行役以外の画面にも反映される
  await expect(facilitator.getByText('第 2 週 / 3')).toBeVisible();
  for (const page of players) {
    await expect(page.getByText('第 2 週 / 3')).toBeVisible();
  }
});
