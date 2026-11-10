import { spawn } from 'node:child_process';
import { expect, test } from '@playwright/test';

/**
 * ローカルで 1 人が、1 つのブラウザと開発用ボット（自動確定）（npm run dev:bots）で、1 ゲームを通す。
 * 進行役と参加者（小売店）を、同じブラウザで兼ねる。
 */
test('[US1.2] 1 人・1 ブラウザ + ボット 3 体で、最終週まで 1 ゲーム遊べる', async ({
  page,
}) => {
  const menu = page.getByRole('navigation', { name: 'メインメニュー' });
  await page.goto('/');
  await menu.getByRole('link', { name: '新しいゲーム' }).click();
  await page.getByLabel('週数').fill('2');
  await page.getByRole('button', { name: '作成する' }).click();
  await expect(page.getByRole('heading', { name: 'ロビー' })).toBeVisible();
  const joinCode = (await page.locator('strong').innerText()).trim();

  // 同じブラウザで、参加者としても参加する（進行役の資格を失わない）
  await menu.getByRole('link', { name: 'ゲームに参加' }).click();
  await page.getByLabel('参加コード').fill(joinCode);
  await page.getByLabel('表示名').fill('わたし');
  await page.getByRole('button', { name: '参加する' }).click();
  await expect(page.getByRole('heading', { name: 'ロビー' })).toBeVisible();
  await expect(page.getByText(joinCode)).toBeVisible(); // 進行役の表示のまま

  const bots = spawn('npx', ['tsx', 'scripts/dev-bots.ts', joinCode, '3'], {
    stdio: 'ignore',
  });
  try {
    for (const name of ['ボット1', 'ボット2', 'ボット3']) {
      await expect(page.getByLabel(`${name} の役割`)).toBeVisible({
        timeout: 20_000,
      });
    }
    const assign: [string, string][] = [
      ['わたし', '小売店'],
      ['ボット1', '工場'],
      ['ボット2', '一次卸'],
      ['ボット3', '二次卸'],
    ];
    for (const [name, role] of assign) {
      await page.getByLabel(`${name} の役割`).selectOption({ label: role });
    }
    await page.getByRole('button', { name: '開始する' }).click();
    await expect(
      page.getByRole('heading', { name: '進行役コンソール' }),
    ).toBeVisible();

    // 自動確定（既定）: 自分が保存し、ボットの発注がそろうと、自動で次の週に進む
    await menu.getByRole('link', { name: '自分の画面' }).click();
    await expect(
      page.getByRole('heading', { name: '小売店の画面' }),
    ).toBeVisible();
    for (const [week, done] of [
      [1, '2 週目'],
      [2, 'ゲームは終了しました。'],
    ] as const) {
      await expect(page.getByText(`${week} 週目`).first()).toBeVisible({
        timeout: 20_000,
      });
      await page.getByLabel('発注数').fill('4');
      await page.getByRole('button', { name: '保存する' }).click();
      // 自分が最後の保存だと、「…週目に進みました」の通知と「N 週目」の表示が両方出る。どちらでもよい
      await expect(page.getByText(done).first()).toBeVisible({
        timeout: 20_000,
      });
    }
  } finally {
    bots.kill();
  }
});
