import AxeBuilder from '@axe-core/playwright';
import { spawn } from 'node:child_process';
import { expect, test } from '@playwright/test';
import { E2E_API_URL, E2E_ORIGIN } from './ports.js';

/**
 * 振り返り: 1 人 + ボット（反応的な発注）で 1 ゲームを終えて、役割別の推移を確認する。
 * 終了前は値が見えないこと、グラフと表が同じ値であること、アクセシビリティの自動検査も行う。
 */
test('[US4.2/AC4.2.1] 終了後に役割別の振り返りを見られ、終了前は見えない', async ({
  page,
}) => {
  const menu = page.getByRole('navigation', { name: 'メインメニュー' });
  await page.goto('/new');
  await page.getByLabel('週数').fill('3');
  // 自動確定の既定は無効（AC1.1.6）。ボットと遊ぶため、有効にする
  await page.getByLabel('全員が保存したら自動で次の週に進む').check();
  await page.getByRole('button', { name: '作成する' }).click();
  await expect(page.getByRole('heading', { name: 'ロビー' })).toBeVisible();
  // 参加コード（復帰コードと区別するため、文言で探す）
  const joinCode = (
    await page
      .getByText(/^参加コード:/)
      .locator('strong')
      .innerText()
  ).trim();

  await menu.getByRole('link', { name: 'ゲームに参加' }).click();
  await page.getByLabel('参加コード').fill(joinCode);
  await page.getByLabel('表示名').fill('わたし');
  await page.getByRole('button', { name: '参加する' }).click();
  await expect(page.getByRole('heading', { name: 'ロビー' })).toBeVisible();

  const bots = spawn('npx', ['tsx', 'scripts/dev-bots.ts', joinCode, '3'], {
    stdio: 'ignore',
    env: {
      ...process.env,
      BOT_STRATEGY: 'reactive',
      API_URL: E2E_API_URL,
      ORIGIN: E2E_ORIGIN,
    },
  });
  try {
    for (const name of ['ボット1', 'ボット2', 'ボット3']) {
      await expect(page.getByLabel(`${name} の役割`)).toBeVisible({
        timeout: 20_000,
      });
    }
    for (const [name, role] of [
      ['わたし', '小売店'],
      ['ボット1', '工場'],
      ['ボット2', '一次卸'],
      ['ボット3', '二次卸'],
    ] as const) {
      await page.getByLabel(`${name} の役割`).selectOption({ label: role });
    }
    await page.getByRole('button', { name: '開始する' }).click();
    await expect(
      page.getByRole('heading', { name: '進行役コンソール' }),
    ).toBeVisible();

    // 終了前: 振り返りは見えない（メニューからも、URL を直接開いても）
    await menu.getByRole('link', { name: '振り返り' }).click();
    await expect(page.getByText(/ゲームが終了してから/)).toBeVisible();
    await expect(page.getByRole('table')).toHaveCount(0);
    await expect(page.getByRole('img')).toHaveCount(0);

    // 3 週を遊ぶ（自動確定）
    await menu.getByRole('link', { name: '自分の画面' }).click();
    for (const week of [1, 2, 3]) {
      await expect(page.getByText(`${week} 週目`).first()).toBeVisible({
        timeout: 20_000,
      });
      await page.getByLabel('発注数').fill('4');
      await page.getByRole('button', { name: '保存する' }).click();
      // 一瞬だけ出る案内ではなく、最終の状態を待つ: 次の週の表示、または最終週なら終了
      if (week < 3) {
        await expect(
          page.getByText(`${week + 1} 週目`, { exact: true }),
        ).toBeVisible({ timeout: 20_000 });
      } else {
        await expect(
          page.getByText('ゲームは終了しました。').first(),
        ).toBeVisible({
          timeout: 20_000,
        });
      }
    }
    await expect(page.getByText('ゲームは終了しました。')).toBeVisible({
      timeout: 20_000,
    });

    // 終了後: 振り返り
    await page.getByRole('link', { name: '振り返りを見る' }).click();
    await expect(
      page.getByRole('heading', { name: '振り返り', level: 1 }),
    ).toBeVisible();
    const table = page.getByRole('table', { name: /注文.*グラフと同じ値/ });
    await expect(table.getByRole('row')).toHaveCount(4); // 見出し + 3 週
    // 指標を切り替えるとグラフの名前も変わるため、共通の「週次推移」で探す
    const chart = page.getByRole('img', { name: /週次推移/ });
    await expect(chart.locator('polyline')).toHaveCount(5);

    // グラフの各系列の値が、表の同じ列の値と一致する
    const headers = await table.getByRole('columnheader').allInnerTexts();
    const rows = await table
      .getByRole('row')
      .evaluateAll((trs) =>
        trs
          .slice(1)
          .map((tr) => [...tr.children].map((c) => c.textContent ?? '')),
      );
    for (const line of await chart.locator('polyline').all()) {
      const label = (await line.getAttribute('data-label'))!;
      const column = headers.indexOf(label);
      expect(column).toBeGreaterThan(0);
      expect(await line.getAttribute('data-values')).toBe(
        rows.map((r) => r[column]).join(','),
      );
    }

    // 指標・役割の切り替え
    await page.getByRole('radio', { name: '在庫' }).check();
    await expect(
      page.getByRole('table', { name: /在庫.*グラフと同じ値/ }),
    ).toBeVisible();
    await page.getByRole('checkbox', { name: '工場' }).uncheck();
    // 在庫には需要の系列が無いので、4 役割から工場を外した 3 本
    await expect(chart.locator('polyline')).toHaveCount(3);

    // アクセシビリティの自動検査（重大・深刻な違反が無い）
    const results = await new AxeBuilder({ page }).analyze();
    const serious = results.violations.filter(
      (v) => v.impact === 'serious' || v.impact === 'critical',
    );
    expect(serious.map((v) => `${v.id}: ${v.help}`)).toEqual([]);

    // キーボードだけで、指標を切り替えられる
    await page.getByRole('radio', { name: '在庫' }).focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('radio', { name: '受注残' })).toBeChecked();

    // 出力（進行役）: CSV を受け取ると、全週 × 4 役割の行と見出しがある（US4.3/AC4.3.1）
    const href = await page
      .getByRole('link', { name: 'CSV で出力' })
      .getAttribute('href');
    const csv = await page.request.get(href!);
    expect(csv.status()).toBe(200);
    const lines = (await csv.text()).trimEnd().split('\r\n');
    expect(lines[0]).toMatch(/^schema_version,game_id,settings_kind/);
    expect(lines).toHaveLength(1 + 3 * 4);
  } finally {
    bots.kill();
  }
});

test('[US4.2/AC4.2.2] 資格が無ければ、参加へ誘導される（振り返りの URL を直接開く）', async ({
  page,
}) => {
  await page.goto('/games/00000000-0000-0000-0000-000000000000/review');
  await expect(page.getByRole('heading', { name: '参加する' })).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('参加または復帰');
  await expect(page.getByRole('table')).toHaveCount(0);
});
