import { chooseOption, pressOn, tabTo, typeInto } from './support/keyboard.js';
import { expect, test } from './support/test.js';

// 機能: キーボードだけで、ゲームの作成から出力の開始までを通して完了できる（AC5.5.1、NFR8.1）
// マウスの操作を一切使わない。各工程は表示の状態の変化を待って進む（固定の待ちを使わない）

const ROLE_OPTIONS = ['工場', '一次卸', '二次卸', '小売店'];

test('Given キーボードだけ When 作成から結果の出力までを通す Then 6 工程すべてが完了する', async ({
  browser,
  baseURL,
}) => {
  const context = async () => browser.newContext({ baseURL: baseURL ?? '' });

  // 工程 1: ゲームの作成
  const facilitatorContext = await context();
  const facilitator = await facilitatorContext.newPage();
  await facilitator.goto('/');
  await pressOn(facilitator, facilitator.getByTestId('go-create'), 'Enter');
  await expect(facilitator.getByRole('heading', { name: 'ゲームを作成する' })).toBeVisible();
  await typeInto(facilitator, facilitator.getByLabel('ゲーム名'), 'キーボード通しの試験');
  await typeInto(facilitator, facilitator.getByLabel('週数'), '2');
  await pressOn(facilitator, facilitator.getByTestId('create-submit'), 'Enter');
  await expect(facilitator.getByRole('heading', { name: 'ゲームを作成しました' })).toBeVisible();
  const joinCode = (await facilitator.locator('dl.codes code').nth(0).textContent()) ?? '';
  expect(joinCode).not.toBe('');
  await pressOn(facilitator, facilitator.getByTestId('enter-lobby'), 'Enter');
  await expect(facilitator.getByRole('heading', { name: 'ロビー' })).toBeVisible();

  // 工程 2: 参加（4 人。別のブラウザの文脈）
  const players = [];
  for (const [index, label] of ROLE_OPTIONS.entries()) {
    const playerContext = await context();
    const page = await playerContext.newPage();
    await page.goto('/');
    await typeInto(page, page.getByLabel('参加コード'), joinCode);
    await typeInto(page, page.getByLabel('表示名'), `キーボード試験 ${label} ${index + 1}`);
    await pressOn(page, page.getByTestId('join-submit'), 'Enter');
    await expect(page.getByRole('heading', { name: 'ロビー' })).toBeVisible();
    players.push(page);
  }
  await expect(facilitator.getByRole('heading', { name: '参加者（4 人）' })).toBeVisible();

  // 工程 3: ロビー（役割の割当てと開始）
  for (const [index, label] of ROLE_OPTIONS.entries()) {
    const select = facilitator.getByRole('combobox').nth(index);
    await chooseOption(facilitator, select, label);
  }
  await expect(facilitator.getByTestId('start-game')).toBeEnabled();
  await pressOn(facilitator, facilitator.getByTestId('start-game'), 'Enter');
  await expect(facilitator.getByRole('heading', { name: '進行管理' })).toBeVisible();

  // 工程 4 と 5: 2 週ぶんの入力と週の確定
  for (const week of [1, 2]) {
    for (const page of players) {
      await expect(page.getByText(`第 ${week} 週 / 2`)).toBeVisible();
      await typeInto(page, page.getByTestId('decision-input'), String(3 + week));
      await pressOn(page, page.getByTestId('decision-submit'), 'Enter');
      await expect(page.getByText('入力: 保存済み')).toBeVisible();
    }
    await expect(facilitator.getByTestId('confirm-week')).toBeEnabled();
    await pressOn(facilitator, facilitator.getByTestId('confirm-week'), 'Enter');
    await pressOn(facilitator, facilitator.getByTestId('confirm-week-yes'), 'Enter');
    if (week === 1) {
      await expect(facilitator.getByText('第 2 週 / 2')).toBeVisible();
    }
  }
  await expect(facilitator.getByTestId('game-status')).toHaveText('終了');

  // 工程 6: 結果の表示と出力の開始
  await pressOn(facilitator, facilitator.getByTestId('show-results'), 'Enter');
  await expect(facilitator.getByTestId('results-screen')).toBeVisible();
  await pressOn(facilitator, facilitator.getByTestId('results-back'), 'Enter');
  const download = facilitator.waitForEvent('download');
  await pressOn(facilitator, facilitator.getByTestId('export-csv'), 'Enter');
  expect((await download).suggestedFilename()).not.toBe('');
  await expect(facilitator.getByTestId('export-done')).toBeVisible();

  // Tab だけで到達できることの確認（先頭の要素へ戻れる）
  await tabTo(facilitator, facilitator.getByTestId('export-json'));
  await facilitatorContext.close();
});
