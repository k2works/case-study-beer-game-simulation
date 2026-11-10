import {
  expect,
  test,
  type Browser,
  type BrowserContext,
  type Page,
} from '@playwright/test';

const ROLES = [
  { key: 'FACTORY', label: '工場', input: '生産要請数' },
  { key: 'DISTRIBUTOR', label: '一次卸', input: '発注数' },
  { key: 'WHOLESALER', label: '二次卸', input: '発注数' },
  { key: 'RETAILER', label: '小売店', input: '発注数' },
] as const;

interface Player {
  context: BrowserContext;
  page: Page;
  name: string;
}

/** 進行役が作成し、4 人が参加し、役割を割り当てて開始するまで */
async function startTable(browser: Browser, weeks = 2) {
  const facContext = await browser.newContext();
  const fac = await facContext.newPage();
  await fac.goto('/new');
  await fac.getByLabel('週数').fill(String(weeks));
  // 進行役が確定する流れを検証するため、自動確定をオフにする
  await fac.getByLabel('全員が保存したら自動で次の週に進む').uncheck();
  await fac.getByRole('button', { name: '作成する' }).click();
  await expect(fac.getByRole('heading', { name: 'ロビー' })).toBeVisible();
  const joinCode = (await fac.locator('strong').innerText()).trim();

  const players: Player[] = [];
  for (const role of ROLES) {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto('/join');
    await page.getByLabel('参加コード').fill(joinCode);
    await page.getByLabel('表示名').fill(`${role.label}担当`);
    await page.getByRole('button', { name: '参加する' }).click();
    await expect(page.getByText('開始を待っています')).toBeVisible();
    players.push({ context, page, name: `${role.label}担当` });
  }
  for (const [i, role] of ROLES.entries()) {
    await fac
      .getByLabel(`${players[i]!.name} の役割`)
      .selectOption({ label: role.label });
  }
  await expect(fac.getByRole('button', { name: '開始する' })).toBeEnabled();
  await fac.getByRole('button', { name: '開始する' }).click();
  await expect(
    fac.getByRole('heading', { name: '進行役コンソール' }),
  ).toBeVisible();
  return { fac, facContext, players };
}

async function enterOrders(players: Player[], quantity: number) {
  for (const [i, player] of players.entries()) {
    const role = ROLES[i]!;
    const page = player.page;
    await expect(
      page.getByRole('heading', { name: `${role.label}の画面` }),
    ).toBeVisible({
      timeout: 15_000,
    });
    await page.getByLabel(role.input).fill(String(quantity));
    await page.getByRole('button', { name: '保存する' }).click();
    await expect(page.getByText('保存しました')).toBeVisible();
  }
}

async function commit(fac: Page) {
  await expect(fac.getByRole('button', { name: '週を確定する' })).toBeEnabled({
    timeout: 15_000,
  });
  await fac.getByRole('button', { name: '週を確定する' }).click();
  await fac
    .getByRole('dialog')
    .getByRole('button', { name: '確定する' })
    .click();
}

test('[US2.3/AC2.3.1] 作成 → 参加 → 割り当て → 開始 → 入力 → 確定 → 状態の更新', async ({
  browser,
}) => {
  const { fac, facContext, players } = await startTable(browser);

  // 情報の制約: 小売店だけが顧客需要を見る
  await expect(players[3]!.page.getByText('今週の顧客需要')).toBeVisible({
    timeout: 15_000,
  });
  await expect(players[0]!.page.getByText('今週の顧客需要')).toHaveCount(0);

  await enterOrders(players, 4);
  await commit(fac);

  // 週が進み、役割別の結果が履歴に載る
  for (const [i] of ROLES.entries()) {
    const page = players[i]!.page;
    await expect(page.getByText('2 週目')).toBeVisible({ timeout: 15_000 });
    await expect(
      page.getByRole('table', { name: '週ごとの結果' }).getByRole('row'),
    ).toHaveCount(2);
  }
  await expect(
    players[3]!.page
      .getByRole('table', { name: '週ごとの結果' })
      .getByText('$6.00')
      .first(),
  ).toBeVisible();

  // 最終週まで進めると終了する
  await enterOrders(players, 4);
  await commit(fac);
  await expect(fac.getByText('ゲームは終了しました。')).toBeVisible({
    timeout: 15_000,
  });
  await expect(
    players[3]!.page.getByText('ゲームは終了しました。'),
  ).toBeVisible({ timeout: 15_000 });

  await facContext.close();
  for (const p of players) await p.context.close();
});

test('[US2.1] 通知（SSE）を遮断しても、ポーリングで追いつく', async ({
  browser,
}) => {
  const { fac, facContext, players } = await startTable(browser);
  const retailer = players[3]!;
  // SSE を遮断してから、画面を開き直す
  await retailer.page.route('**/stream', (route) => route.abort());
  await retailer.page.reload();
  await expect(
    retailer.page.getByRole('heading', { name: '小売店の画面' }),
  ).toBeVisible({
    timeout: 15_000,
  });
  await enterOrders(players.slice(0, 3), 4);
  await retailer.page.getByLabel('発注数').fill('4');
  await retailer.page.getByRole('button', { name: '保存する' }).click();
  await commit(fac);
  await expect(retailer.page.getByText('2 週目')).toBeVisible({
    timeout: 15_000,
  });

  await facContext.close();
  for (const p of players) await p.context.close();
});

test('[US2.1] 資格が無ければ、参加へ誘導される', async ({ page }) => {
  await page.goto('/games/00000000-0000-0000-0000-000000000000/lobby');
  await expect(page.getByRole('heading', { name: '参加する' })).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('参加または復帰');
});
